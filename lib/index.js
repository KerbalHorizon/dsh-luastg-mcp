// Generated from src\index.ts by scripts/build.mjs. Do not edit.
// `dsh-luastg-mcp` — the LuaSTG side of DeepSeek Harness.
//
// Version 1.0 talks to the LuaSTG Editor Sharp X MCP bridge over TCP
// (127.0.0.1:8090, newline-delimited JSON). It never reads or writes a
// `.lstges` file: the C# bridge resolves nodes in the live editor, mutates them
// through real editor Commands on the UI thread, and WPF refreshes itself.
//
// Node addresses are positional paths ("0" is the document root, "0/4/2" a
// descendant). The pre-1.0 dot-separated `node_id` is still accepted as an
// alias and normalized by `node-path.ts`.
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BridgeClient, BridgeCommandError } from './bridge-client.js'
                                                        
import { normalizeAttributeValues } from './attributes.js'
import { resolveNodeReference } from './node-path.js'

/** Minimal view of the Cordis context this plugin needs. */
                           
          
                                          
   
 

                              
                                                        
               
                         
               
                                                         
                    
                                                                           
                   
 

export const name = 'luastg-mcp'

export const inject = ['tools']

export const Config = Schema.object({
  host: Schema.string()
    .default('127.0.0.1')
    .description('Host of the LuaSTG Editor Sharp X MCP bridge. The C# bridge listens on loopback only.'),
  port: Schema.number()
    .min(1)
    .max(65535)
    .step(1)
    .default(8090)
    .description('TCP port of the MCP bridge.'),
  timeoutMs: Schema.number()
    .min(100)
    .max(60000)
    .step(1)
    .default(5000)
    .description('Connect + response deadline in milliseconds for one bridge call.'),
  maxDepth: Schema.number()
    .min(0)
    .max(512)
    .step(1)
    .default(0)
    .description('Default tree depth for luastg_get_nodes: 0 returns everything, 2-3 is a cheap structure scan.'),
  captureFallback: Schema.boolean()
    .default(true)
    .description(
      'When the bridge has no take_screenshot action (protocol v1), capture the editor window locally with ' +
        'PowerShell instead of failing. Set false on hosts without a desktop session.',
    ),
})

const POSITIONAL_PATH_NOTE =
  'Paths are positional: inserting or deleting shifts later siblings, so re-read the tree with luastg_get_nodes ' +
  'before addressing other nodes.'

function text(value         )         {
  return typeof value === 'string' ? value.trim() : ''
}

function boundedInteger(value         , fallback        , min        , max        , label        )         {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`)
  }
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max} (got ${value})`)
  return value
}

function optionalInteger(value         , min        , max        , label        )                     {
  if (value === undefined || value === null) return undefined
  return boundedInteger(value, min, min, max, label)
}

function summarizeScript(value        )                                                  {
  return {
    chars: value.length,
    lines: value === '' ? 0 : value.split(/\r\n|\r|\n/).length,
    bytes: Buffer.byteLength(value, 'utf8'),
  }
}

/** Root namespaces that mean the caller already passed a full .NET type name. */
const EDITOR_TYPE_ROOTS = ['LuaSTGEditorSharp.', 'LuaSTGNode.']

/**
 * Accept a .NET class name, a full .NET name, or the legacy `.lstges` shorthand.
 *
 * The editor factory matches `Type.Name` and `Type.FullName` only, while a
 * `.lstges` file stores `.General.Folder` / `.Task.TaskWait`. Reducing a
 * shorthand to its last segment (`Folder`, `TaskWait`) keeps old `node_type`
 * values working; full names from the editor assemblies are passed through.
 */
function normalizeNodeType(raw        )         {
  let type = raw.trim().replace(/^\.+/, '')
  if (type === '') return ''
  if (type.includes('.') && !type.includes('+') && !EDITOR_TYPE_ROOTS.some((root) => type.startsWith(root))) {
    const last = type.slice(type.lastIndexOf('.') + 1)
    if (last !== '') type = last
  }
  return type
}

/**
 * The rule every tree-building tool repeats to the model.
 *
 * A human authoring a stage in the editor works with native nodes (TaskWait, CreateEnemy,
 * SetVelocity, Repeat, If, ...): they are readable, editable in the property grid, and produce
 * the same Lua. A wall of Code defeats the whole point of the editor, so the tools say so.
 */
const NATIVE_FIRST_NOTE =
  'Prefer native editor nodes over General.Code: build the stage from TaskWait / CreateEnemy / CreateSimpleEnemy / ' +
  'SetVelocity / TaskMoveTo / Repeat / If style nodes, and only fall back to a Code node for logic that no native ' +
  'node can express (arbitrary math, table manipulation, engine calls without a node).'

/** Upper bounds mirror the C# side so a bad tree is rejected before it reaches the editor. */
const SUBTREE_MAX_DEPTH = 64
const SUBTREE_MAX_NODES = 2000

/**
 * Validate and normalize a nested `{type, attributes, children}` tree for `apply_subtree`.
 *
 * Node types go through the same shorthand reduction as `luastg_add_node`, so callers can mix
 * `.Task.TaskWait`, `Task.TaskWait` and `TaskWait`. Attribute values are coerced to the strings
 * the editor stores. Anything malformed fails here with a readable message instead of after a
 * half-built tree has already been inserted.
 */
function normalizeSubtree(raw         , depth = 0, counter = { nodes: 0 })                          {
  if (depth > SUBTREE_MAX_DEPTH) throw new Error(`tree is nested deeper than ${SUBTREE_MAX_DEPTH} levels`)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('each tree node must be a JSON object such as {"type":"TaskWait","attributes":{"Time":"60"}}')
  }

  const node = raw                           
  counter.nodes += 1
  if (counter.nodes > SUBTREE_MAX_NODES) throw new Error(`tree has more than ${SUBTREE_MAX_NODES} nodes`)

  const type = normalizeNodeType(text(node.type))
  if (type === '') throw new Error('every tree node needs a "type", for example "TaskWait"')

  const normalized                          = { type }

  const attributes = normalizeAttributeValues(node.attributes, { required: false, label: 'attributes' })
  if (Object.keys(attributes).length > 0) normalized.attributes = attributes

  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) throw new Error(`"children" of "${type}" must be an array`)
    normalized.children = node.children.map((child) => normalizeSubtree(child, depth + 1, counter))
  }

  return normalized
}

/** How a `luastg_apply_subtree` call reached the document. */
                                                          

/** Normalized result of building a subtree, whichever transport was used. */
                        
                           
                                                                 
                 
                                  
              
              
                    
                    
 

/** Number of nodes in a normalized `{type, attributes, children}` tree. */
function countSubtreeNodes(tree                         )         {
  const children = Array.isArray(tree.children) ? (tree.children                             ) : []
  let total = 1
  for (const child of children) total += countSubtreeNodes(child)
  return total
}

/**
 * Build a subtree through repeated `insert_node` calls, depth-first.
 *
 * The bridge protocol v1 (docs/bridge-protocol.md) has no bulk subtree action:
 * `get_tree` / `insert_node` / `set_attribute` / `delete_node` are the whole tree
 * surface. This path therefore inserts the root first, appends each child to the
 * path the bridge returned for its parent, and never guesses a path itself.
 *
 * Failure is rolled back the same way a refused bulk insert would leave nothing
 * behind: one `delete_node` on the subtree root removes everything this call
 * created. Paths are positional, so the root path stays valid for that delete
 * even after the children were appended.
 */
async function buildSubtreeWithInsertNode(
  client              ,
  parentPath        ,
  tree                         ,
  options                                           ,
)                        {
  const total = countSubtreeNodes(tree)
  const paths           = []
  let rootText = ''
  let nodeCount                    

  const insert = async (spec                         , parent        )                  => {
    const payload                          = {
      action: 'insert_node',
      parent,
      type: spec.type,
      // Expanding ancestors + selecting the row on every insert would flash the
      // tree; only the final node is revealed, and it expands the whole chain.
      reveal: options.reveal && paths.length + 1 === total,
    }
    if (spec.attributes !== undefined) payload.attributes = spec.attributes

    const response = await client.request(payload, options.signal)
    const path = typeof response.path === 'string' ? response.path.trim() : ''
    if (path === '') {
      throw new Error(`the bridge inserted "${String(spec.type)}" but returned no path for the new node`)
    }
    if (paths.length === 0) rootText = typeof response.text === 'string' ? response.text : ''
    paths.push(path)
    if (typeof response.nodeCount === 'number') nodeCount = response.nodeCount
    return path
  }

  const visit = async (spec                         , parent        )                => {
    const path = await insert(spec, parent)
    const children = Array.isArray(spec.children) ? (spec.children                             ) : []
    for (const child of children) await visit(child, path)
  }

  try {
    await visit(tree, parentPath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (paths.length === 0) {
      throw new Error(`${reason} (no node was inserted, so the document is unchanged)`)
    }
    const root = paths[0]
    try {
      // Deliberately not tied to the caller's AbortSignal: a cancelled or timed-out
      // call must still clean up, or the document would keep a partial subtree.
      await client.request({ action: 'delete_node', path: root })
    } catch (rollbackError) {
      const rollbackReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      throw new Error(
        `${reason}. Rollback failed too: deleting '${root}' returned ${rollbackReason}; ` +
          'the partially built subtree is still in the document.',
      )
    }
    throw new Error(`${reason} (rolled back: deleted '${root}' and every node created under it)`)
  }

  return {
    strategy: 'insert_node-dfs',
    created: paths.length,
    path: paths[0],
    text: rootText,
    parentPath,
    nodeCount,
  }
}

/**
 * Build a subtree, preferring the bridge's bulk `apply_subtree` action.
 *
 * The documented protocol (v1) has no such action and answers `unknown_action`;
 * that is not an error worth showing a user, so the capability is remembered on
 * first contact and every later call goes straight to the `insert_node` path.
 * Any other bridge error is a real failure and is propagated unchanged.
 */
async function applySubtree(
  client              ,
  capability                                 ,
  parentPath        ,
  tree                         ,
  options                                           ,
)                        {
  if (capability.native !== false) {
    try {
      const payload                          = { action: 'apply_subtree', parent: parentPath, tree }
      if (!options.reveal) payload.reveal = false

      const response = await client.request(payload, options.signal)
      capability.native = true
      return {
        strategy: 'apply_subtree',
        created: typeof response.created === 'number' ? response.created : countSubtreeNodes(tree),
        path: typeof response.path === 'string' ? response.path : '',
        text: typeof response.text === 'string' ? response.text : '',
        parentPath: typeof response.parentPath === 'string' ? response.parentPath : parentPath,
        nodeCount: typeof response.nodeCount === 'number' ? response.nodeCount : undefined,
      }
    } catch (error) {
      if (!(error instanceof BridgeCommandError) || error.status !== 'unknown_action') throw error
      capability.native = false
    }
  }

  return await buildSubtreeWithInsertNode(client, parentPath, tree, options)
}

// ---------------------------------------------------------------------------
// Stage guard
// ---------------------------------------------------------------------------

/**
 * The editor's own "Add Stage" toolbox action builds Stage -> TaskNode -> Folder "Initialize"
 * -> StageBG before the node ever reaches the document (`PluginToolbox.AddStageNode`). The
 * bridge has no such defaulting: `TreeActions.InsertNodeCore` creates exactly the node it was
 * asked for, so a bridge-created Stage used to arrive with no children at all and compiled to a
 * stage without a background.
 *
 * Every tree-building tool therefore repairs the Stages it creates: a missing `Initialize`
 * folder is added, a missing background node is added inside it. A Stage that already has both
 * is left untouched, and an existing background elsewhere under the Stage is never duplicated.
 */
const STAGE_TYPE_NAME = 'Stage'
const STAGE_BACKGROUND_TYPE = 'StageBG'
const INITIALIZE_FOLDER_NAME = 'Initialize'
const DEFAULT_STAGE_BACKGROUND = 'temple_background'

/** What the bridge's `get_tree` returns for one node: only the fields the guard reads. */
                        
               
               
                       
                                                       
                           
 

/** How one Stage was repaired. `path` is always the Stage, never a child. */
                               
              
                                                                                            
                     
                         
                     
                
 

/** Result of guarding every Stage created by one tool call. */
                             
                
                     
                            
                              
                                                                                        
                    
                  
 

function isStageNode(node              )          {
  if (node.type === STAGE_TYPE_NAME) return true
  const fullName = typeof node.typeFullName === 'string' ? node.typeFullName : ''
  return fullName.endsWith('.Stage.Stage')
}

function isStageBackgroundNode(node              )          {
  if (node.type === STAGE_BACKGROUND_TYPE) return true
  const fullName = typeof node.typeFullName === 'string' ? node.typeFullName : ''
  return fullName.endsWith('.StageBG')
}

function attributeValue(node              , name        )         {
  const attributes = Array.isArray(node.attributes) ? node.attributes : []
  const exact = attributes.find((item) => item?.name === name)
  const match = exact ?? attributes.find((item) => (item?.name ?? '').toLowerCase() === name.toLowerCase())
  return typeof match?.value === 'string' ? match.value.trim() : ''
}

function findInitializeFolder(stage              )                           {
  const children = Array.isArray(stage.children) ? stage.children : []
  return children.find(
    (child) =>
      child?.type === 'Folder' && attributeValue(child, 'Name').toLowerCase() === INITIALIZE_FOLDER_NAME.toLowerCase(),
  )
}

function containsStageBackground(node              )          {
  if (isStageBackgroundNode(node)) return true
  for (const child of Array.isArray(node.children) ? node.children : []) {
    if (containsStageBackground(child)) return true
  }
  return false
}

function collectStageNodes(node              , found                 = [])                 {
  if (isStageNode(node)) found.push(node)
  for (const child of Array.isArray(node.children) ? node.children : []) collectStageNodes(child, found)
  return found
}

/** Whether a normalized `apply_subtree` spec creates at least one Stage. */
function subtreeSpecHasStage(spec                         )          {
  const type = typeof spec.type === 'string' ? spec.type : ''
  if (type === STAGE_TYPE_NAME || type.endsWith('.Stage')) return true
  const children = Array.isArray(spec.children) ? (spec.children                             ) : []
  return children.some((child) => subtreeSpecHasStage(child))
}

async function readTreeNode(client              , path        , signal              )                        {
  const response = await client.request({ action: 'get_tree', path, maxDepth: 0, attributes: true }, signal)
  const tree = response.tree
  if (tree === null || typeof tree !== 'object') {
    throw new Error(`the bridge returned no tree for '${path}'`)
  }
  return tree                
}

/** Path and document node count the bridge reports for one inserted node. */
                         
              
                    
 

/** Inserts one node and returns where the bridge put it. */
async function insertNodeUnder(
  client              ,
  parent        ,
  type        ,
  attributes                        ,
  index                    ,
  signal              ,
)                         {
  const payload                          = { action: 'insert_node', parent, type, attributes, reveal: false }
  if (index !== undefined) payload.index = index
  const response = await client.request(payload, signal)
  const path = typeof response.path === 'string' ? response.path.trim() : ''
  if (path === '') throw new Error(`the bridge inserted "${type}" but returned no path for the new node`)
  return {
    path,
    ...(typeof response.nodeCount === 'number' ? { nodeCount: response.nodeCount } : {}),
  }
}

/** What one Stage repair changed, plus the document size after the last insert. */
                             
                             
                    
 

/**
 * Makes one Stage satisfy the invariant: an `Initialize` folder that contains a background node.
 *
 * @param client - bridge connection.
 * @param stage - snapshot of the Stage, as returned by `get_tree`.
 * @param signal - tool cancellation.
 * @returns what was repaired, for the tool's response.
 */
async function guardStageNode(
  client              ,
  stage              ,
  signal              ,
)                             {
  const stagePath = typeof stage.path === 'string' ? stage.path.trim() : ''
  if (stagePath === '') throw new Error('the bridge returned a Stage node without a path')

  const folder = findInitializeFolder(stage)

  if (folder !== undefined) {
    if (containsStageBackground(folder)) {
      return {
        result: {
          path: stagePath,
          action: 'already-initialized',
          ...(typeof folder.path === 'string' ? { folderPath: folder.path } : {}),
        },
      }
    }
    const folderPath = typeof folder.path === 'string' && folder.path.trim() !== '' ? folder.path : `${stagePath}/0`
    const background = await insertNodeUnder(
      client,
      folderPath,
      STAGE_BACKGROUND_TYPE,
      { Background: DEFAULT_STAGE_BACKGROUND },
      0,
      signal,
    )
    return {
      result: {
        path: stagePath,
        action: 'background-added',
        folderPath,
        backgroundPath: background.path,
        background: DEFAULT_STAGE_BACKGROUND,
      },
      ...(background.nodeCount === undefined ? {} : { nodeCount: background.nodeCount }),
    }
  }

  // First child, so the background is set before anything else the stage does.
  const createdFolder = await insertNodeUnder(
    client,
    stagePath,
    'Folder',
    { Name: INITIALIZE_FOLDER_NAME },
    0,
    signal,
  )

  if (containsStageBackground(stage)) {
    // The Stage already has a background somewhere else; never create a second one, because
    // both would be emitted as `New(background)` at stage start.
    return {
      result: { path: stagePath, action: 'folder-added', folderPath: createdFolder.path },
      ...(createdFolder.nodeCount === undefined ? {} : { nodeCount: createdFolder.nodeCount }),
    }
  }

  const background = await insertNodeUnder(
    client,
    createdFolder.path,
    STAGE_BACKGROUND_TYPE,
    { Background: DEFAULT_STAGE_BACKGROUND },
    0,
    signal,
  )
  return {
    result: {
      path: stagePath,
      action: 'created',
      folderPath: createdFolder.path,
      backgroundPath: background.path,
      background: DEFAULT_STAGE_BACKGROUND,
    },
    ...(background.nodeCount === undefined ? {} : { nodeCount: background.nodeCount }),
  }
}

/**
 * Guards every Stage at or below `rootPath`.
 *
 * Stages never nest inside each other (`Stage` requires a `StageGroup` parent), so repairing one
 * Stage only shifts indexes below it and the paths of its sibling Stages stay valid.
 */
async function guardStagesUnder(
  client              ,
  rootPath        ,
  signal              ,
)                                         {
  const root = await readTreeNode(client, rootPath, signal)
  const stages = collectStageNodes(root)
  if (stages.length === 0) return undefined

  const items                        = []
  let nodeCount                    
  for (const stage of stages) {
    const path = typeof stage.path === 'string' ? stage.path : ''
    try {
      const outcome = await guardStageNode(client, stage, signal)
      items.push(outcome.result)
      if (outcome.nodeCount !== undefined) nodeCount = outcome.nodeCount
    } catch (error) {
      items.push({ path, action: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  const failed = items.filter((item) => item.action === 'failed')
  const initialized = items.filter(
    (item) => item.action === 'created' || item.action === 'folder-added' || item.action === 'background-added',
  )

  return {
    stages: items.length,
    initialized: initialized.length,
    alreadyInitialized: items.filter((item) => item.action === 'already-initialized').length,
    items,
    ...(nodeCount === undefined ? {} : { nodeCount }),
    ...(failed.length > 0
      ? {
          warning:
            `${failed.length} Stage node(s) still miss the Initialize folder or the background: ` +
            failed.map((item) => `${item.path} (${item.error ?? 'unknown error'})`).join('; ') +
            '. Add them by hand before running the stage.',
        }
      : {}),
  }
}

/** `guardStagesUnder` that never turns a successful insert into a failed tool call. */
async function tryGuardStages(
  client              ,
  rootPath        ,
  signal              ,
)                                         {
  try {
    return await guardStagesUnder(client, rootPath, signal)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      stages: 0,
      initialized: 0,
      alreadyInitialized: 0,
      items: [],
      warning:
        `the node was inserted, but the Stage initialization check failed (${reason}); ` +
        'make sure the Stage owns an "Initialize" folder with a background node.',
    }
  }
}

/** Keep the output small when a node carries a long value, especially Code. */
function changeRecord(name        , oldValue        , newValue        )                          {
  const isCode = name.toLowerCase() === 'code'
  if (isCode || oldValue.length > 2000 || newValue.length > 2000) {
    return {
      name,
      changed: true,
      oldChars: oldValue.length,
      newChars: newValue.length,
      oldBytes: Buffer.byteLength(oldValue, 'utf8'),
      newBytes: Buffer.byteLength(newValue, 'utf8'),
      valuesOmitted: true,
    }
  }
  return { name, oldValue, newValue, changed: true }
}

function envelope(
  client              ,
  action        ,
  body                         ,
  startedAt        ,
)                          {
  return {
    ok: true,
    source: 'editor',
    transport: 'tcp',
    endpoint: client.endpoint,
    action,
    elapsedMs: Math.round(performance.now() - startedAt),
    ...body,
  }
}

function toolError(tool        , error         )        {
  let message = error instanceof Error ? error.message : String(error)
  if (error instanceof BridgeCommandError && error.status === 'no_document') {
    message += ' 请在 LuaSTG 编辑器中打开一个 .lstges 工程后重试。'
  }
  throw new Error(`${tool}: ${message}`)
}

function rewriteScriptResponse(response                )                          {
  const safe                          = { ...response }
  // The bridge returns the whole old and new value; scripts can be megabytes.
  delete safe.oldValue
  delete safe.newValue
  return safe
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

/** Bridge action that returns the editor window as a Base64 PNG (see csharp/take-screenshot.cs). */
const SCREENSHOT_ACTION = 'take_screenshot'
const DEFAULT_WINDOW_TITLE = 'LuaSTG Editor'

/** One PNG in the system temp directory: the workspace is never touched. */
function defaultScreenshotPath()         {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const random = Math.random().toString(36).slice(2, 8)
  return join(tmpdir(), `luastg_shot_${stamp}_${random}.png`)
}

/** Deletes a temp file and never lets a cleanup failure mask the real result. */
function removeQuietly(file        )       {
  try {
    unlinkSync(file)
  } catch {
    // Already gone (bridge path writes nothing) or locked: the OS reclaims temp files anyway.
  }
}

/** Writes `image` to `file` (creating its directory) and returns the path. */
function writeOnce(file        , image        )         {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, image)
  return file
}

function captureWindowScriptPath()         {
  // lib/index.js -> ../scripts/capture-window.ps1
  return fileURLToPath(new URL('../scripts/capture-window.ps1', import.meta.url))
}

/**
 * Captures the editor window with `scripts/capture-window.ps1`.
 *
 * This is the fallback for a protocol-v1 bridge: it needs no editor rebuild, but it needs a
 * desktop session, so it is Windows only and can be switched off with `captureFallback: false`.
 */
function runWindowCapture(out        , titleLike        , timeoutMs        )       {
  if (process.platform !== 'win32') {
    throw new Error('the bridge has no take_screenshot action and local capture only works on Windows')
  }

  const script = captureWindowScriptPath()
  if (!existsSync(script)) throw new Error(`the local capture script is missing: ${script}`)

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', out, '-TitleLike', titleLike],
    { stdio: 'ignore', timeout: timeoutMs, windowsHide: true },
  )

  if (result.error !== undefined) throw new Error(`powershell could not run: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`the capture script failed with exit code ${result.status}`)
  if (!existsSync(out)) throw new Error('the capture script finished without writing the PNG')
}

function screenshotResult(
  client              ,
  source                         ,
  image        ,
  windowTitle        ,
  startedAt        ,
  keptFile         ,
)                          {
  return {
    ok: true,
    source,
    transport: 'tcp',
    endpoint: client.endpoint,
    action: SCREENSHOT_ACTION,
    format: 'png',
    bytes: image.length,
    window: windowTitle,
    imageBase64: image.toString('base64'),
    // Burn after reading is the default: the bridge path never writes a file, the local path is
    // deleted before this value is returned. keep_file opts out and reports where the PNG lives.
    temporaryFileWritten: source === 'powershell' || keptFile !== undefined,
    temporaryFileDeleted: keptFile === undefined,
    ...(keptFile === undefined ? {} : { kept: true, path: keptFile }),
    elapsedMs: Math.round(performance.now() - startedAt),
  }
}

/**
 * Register the LuaSTG tools on the host context.
 * @param ctx - host context providing the tool registry.
 * @param config - profile configuration resolved from the `luastg-mcp` row.
 */
export function apply(ctx                 , config              = {})       {
  const host = text(config.host) || '127.0.0.1'
  const port = boundedInteger(config.port, 8090, 1, 65535, 'port')
  const timeoutMs = boundedInteger(config.timeoutMs, 5000, 100, 60_000, 'timeoutMs')
  const defaultMaxDepth = boundedInteger(config.maxDepth, 0, 0, 512, 'maxDepth')
  const captureFallback = config.captureFallback !== false
  const client = new BridgeClient({ host, port, timeoutMs })
  const toolTimeout = Math.min(120_000, Math.max(15_000, timeoutMs + 10_000))
  /** Whether this bridge implements the bulk `apply_subtree` action (undefined = untested). */
  const subtreeCapability                                  = { native: undefined }

  ctx.tools.register(
    defineTool({
      name: 'luastg_get_nodes',
      description:
        'Read the node tree of the project currently open in LuaSTG Editor Sharp X through the MCP bridge on ' +
        '127.0.0.1:8090. Read-only: nothing is written to disk and the editor is not modified. Nodes are addressed ' +
        'by positional path: "0" is the document root and "0/2/1" is the third child of the second child of the root. ' +
        'By default the whole active document is returned; pass maxDepth for a bounded scan and attributes=false for ' +
        'a structure-only tree. Every node carries path, type, text, attributes, attributeCount, childCount and ' +
        'children; document carries name, path, dirty and nodeCount. Paths are positional and change after an ' +
        'insert/delete, so re-read the tree before addressing other nodes. The legacy node_id ("0.2.1") argument is ' +
        'accepted as a deprecated alias for path. If the editor or bridge is not running the tool fails with an ' +
        'actionable connection error.',
      parameters: {
        path: {
          type: 'string',
          description:
            'Positional node path to read, for example "0" (root) or "0/4/2". Defaults to "0". The legacy dot form ' +
            '"0.4.2" is accepted too.',
        },
        node_id: {
          type: 'string',
          description: 'Deprecated alias for path: a dot-separated node id such as "0.4.2". Prefer path.',
        },
        maxDepth: {
          type: 'integer',
          description:
            `Levels to return below the selected node; 0 means the entire subtree. Defaults to ${defaultMaxDepth} ` +
            '(set by the profile configuration). Use 2-3 for a quick structure scan of a large document.',
        },
        attributes: {
          type: 'boolean',
          description:
            'Include every attribute value on each node (default true). Pass false for a compact structure-only tree.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: toolTimeout,
      async execute(args, exec) {
        try {
          const reference = resolveNodeReference(args                           , {
            pathKey: 'path',
            legacyKey: 'node_id',
            defaultPath: '0',
          })
          const maxDepth = boundedInteger(args.maxDepth, defaultMaxDepth, 0, 512, 'maxDepth')
          if (args.attributes !== undefined && args.attributes !== null && typeof args.attributes !== 'boolean') {
            throw new Error('attributes must be a boolean')
          }
          const includeAttributes = args.attributes !== false

          const startedAt = performance.now()
          const response = await client.request(
            {
              action: 'get_tree',
              path: reference.path,
              maxDepth,
              attributes: includeAttributes,
            },
            exec.signal,
          )

          return {
            ...envelope(client, 'get_tree', response, startedAt),
            path: reference.path,
            maxDepth,
            attributes: includeAttributes,
          }
        } catch (error) {
          toolError('luastg_get_nodes', error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'luastg_update_node',
      description:
        'Change existing attribute values of one node in the project open in LuaSTG Editor Sharp X through the MCP ' +
        'bridge. Each attribute is sent as its own set_attribute command, so every change is a separate undoable ' +
        'editor command and the operation is NOT atomic: if a later attribute fails, earlier ones stay changed and ' +
        'the error lists them. Address the node by path ("0" or "0/4/2") or the deprecated node_id ("0.4.2"). ' +
        'Attribute names must already exist on the node; the editor rejects unknown names and reports the available ' +
        'ones. Long values (including Code) are summarized by size instead of echoed. Returns the changed/unchanged ' +
        'attributes and the node display text.',
      parameters: {
        path: {
          type: 'string',
          description: 'Positional path of the node to edit, for example "0/4/2". Required unless node_id is given.',
        },
        node_id: {
          type: 'string',
          description: 'Deprecated alias for path: a dot-separated node id such as "0.4.2".',
        },
        attributes: {
          type: 'object',
          additionalProperties: true,
          required: true,
          description:
            'JSON object mapping existing attribute names to new values (string; numbers and booleans are stored as ' +
            'text). At least one entry is required. Every attribute is sent as its own editor command.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: toolTimeout * 2,
      async execute(args, exec) {
        try {
          const reference = resolveNodeReference(args                           , {
            pathKey: 'path',
            legacyKey: 'node_id',
          })
          const attributes = normalizeAttributeValues(args.attributes, { required: true, label: 'attributes' })
          const names = Object.keys(attributes)

          const startedAt = performance.now()
          const changed                                 = []
          const unchanged           = []
          let displayText = ''

          for (const name of names) {
            let response                
            try {
              response = await client.request(
                { action: 'set_attribute', path: reference.path, name, value: attributes[name] },
                exec.signal,
              )
            } catch (error) {
              const applied = changed.map((item) => String(item.name))
              const done = applied.length + unchanged.length
              const suffix =
                done === 0
                  ? ''
                  : ` (${done} attribute(s) already applied${applied.length > 0 ? `: ${applied.join(', ')}` : ''}; ` +
                    'they are NOT rolled back — use the editor undo if needed)'
              throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`)
            }

            if (typeof response.text === 'string') displayText = response.text
            if (response.changed === true) {
              const oldValue = typeof response.oldValue === 'string' ? response.oldValue : ''
              const newValue = typeof response.newValue === 'string' ? response.newValue : attributes[name]
              changed.push(changeRecord(name, oldValue, newValue))
            } else {
              unchanged.push(name)
            }
          }

          return {
            ok: true,
            source: 'editor',
            transport: 'tcp',
            endpoint: client.endpoint,
            action: 'set_attribute',
            status: 'ok',
            elapsedMs: Math.round(performance.now() - startedAt),
            path: reference.path,
            attributes,
            changed,
            unchanged,
            changedCount: changed.length,
            unchangedCount: unchanged.length,
            text: displayText,
          }
        } catch (error) {
          toolError('luastg_update_node', error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'luastg_add_node',
      description:
        'Insert one new node as a child of an existing parent in the project open in LuaSTG Editor Sharp X through ' +
        'the MCP bridge. The type must be known to the editor. It accepts a .NET class name ("Comment", "TaskWait", ' +
        '"Folder"), a full name ("LuaSTGEditorSharp.EditorData.Node.General.Comment"), or the legacy .lstges ' +
        'shorthand ("General.Folder", "Task.TaskWait"), which is reduced to its class name before the request. ' +
        'parent defaults to the document root "0"; ' +
        'index defaults to appending at the end. Initial attributes are applied before insertion. The editor executes ' +
        'a real InsertCommand on its UI thread, so Undo/Redo and the WPF tree refresh keep working. Returns the new ' +
        "node's path, type, text, parentPath, index, selected and nodeCount. Paths are positional: later siblings " +
        'shift, so re-read the tree before addressing other nodes. The legacy parent_id ("0.4") is accepted as a ' +
        'deprecated alias for parent. Inserting a Stage also repairs the editor defaults the bridge cannot apply: a ' +
        'missing Folder "Initialize" and its background node (StageBG, temple_background) are added automatically and ' +
        'reported in stageDefaults, so a generated Stage never comes out empty.',
      parameters: {
        parent: {
          type: 'string',
          description:
            'Positional path of the parent that receives the new child, for example "0" (root) or "0/4". Defaults to "0".',
        },
        parent_id: {
          type: 'string',
          description: 'Deprecated alias for parent: a dot-separated node id such as "0.4".',
        },
        node_type: {
          type: 'string',
          required: true,
          description:
            'Node type to create: a .NET class name ("Comment", "TaskWait", "Folder"), a full name, or the legacy ' +
            '.lstges shorthand ("General.Folder", "Task.TaskWait"). A leading dot is ignored and a shorthand is ' +
            'reduced to its class name before the request.',
        },
        attributes: {
          type: 'object',
          additionalProperties: true,
          description:
            'Optional initial attribute values (string; numbers and booleans are stored as text). Names that do not ' +
            'exist on the type are rejected by the editor.',
        },
        index: {
          type: 'integer',
          description:
            "0-based position among the parent's children; default appends. Inserting at 0..n-1 shifts the paths of " +
            'that sibling and every later one.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: toolTimeout,
      async execute(args, exec) {
        try {
          const reference = resolveNodeReference(args                           , {
            pathKey: 'parent',
            legacyKey: 'parent_id',
            defaultPath: '0',
          })
          const nodeType = normalizeNodeType(text(args.node_type))
          if (nodeType === '') throw new Error('node_type is required, for example "Comment"')
          if (/\s/.test(nodeType)) throw new Error('node_type must not contain whitespace')
          if (nodeType.length > 300) throw new Error('node_type is too long')

          const attributes = normalizeAttributeValues(args.attributes, { required: false, label: 'attributes' })
          const index = optionalInteger(args.index, 0, 2_147_483_647, 'index')

          const payload                          = {
            action: 'insert_node',
            parent: reference.path,
            type: nodeType,
          }
          if (index !== undefined) payload.index = index
          if (Object.keys(attributes).length > 0) payload.attributes = attributes

          const startedAt = performance.now()
          const response = await client.request(payload, exec.signal)

          // A Stage inserted through the bridge has no children; the editor's own "Add Stage"
          // toolbox action would have built Folder "Initialize" -> StageBG for it. Repair that
          // here so a generated stage never compiles without a background.
          const createdPath = typeof response.path === 'string' ? response.path.trim() : ''
          const createdType = typeof response.type === 'string' ? response.type : ''
          const createdFullName = typeof response.typeFullName === 'string' ? response.typeFullName : ''
          const stageDefaults =
            createdPath !== '' && (createdType === STAGE_TYPE_NAME || createdFullName.endsWith('.Stage.Stage'))
              ? await tryGuardStages(client, createdPath, exec.signal)
              : undefined

          return {
            ...envelope(client, 'insert_node', response, startedAt),
            parentPath: typeof response.parentPath === 'string' ? response.parentPath : reference.path,
            ...(stageDefaults === undefined ? {} : { stageDefaults }),
            ...(stageDefaults?.nodeCount === undefined ? {} : { nodeCount: stageDefaults.nodeCount }),
            pathNote: POSITIONAL_PATH_NOTE,
          }
        } catch (error) {
          toolError('luastg_add_node', error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'luastg_apply_subtree',
      description:
        'Build a whole nested node tree in ONE call in the project open in LuaSTG Editor Sharp X. ' +
        'Pass a nested JSON object: {"type":"TaskNode","attributes":{},"children":[{"type":"TaskWait",' +
        '"attributes":{"Time":"60"}}]}. Types accept the same class name, full name or .lstges shorthand as ' +
        'luastg_add_node. The bridge protocol v1 has no bulk subtree action, so every node is created through a real ' +
        'InsertCommand on the editor UI thread, depth-first via insert_node; a bridge that does implement ' +
        'apply_subtree is used in one round trip instead. If any node is rejected, the nodes already created are ' +
        'deleted again, so the document is left as it was found. Use this instead of a chain of luastg_add_node ' +
        'calls: it keeps parent/child paths consistent and avoids positional-path drift between inserts. Returns ' +
        'created, the root path, text, parentPath, nodeCount and strategy. Every Stage in the tree gets the same ' +
        'default repair as luastg_add_node: a missing Folder "Initialize" with a StageBG (temple_background) is ' +
        'added, an existing background is never duplicated, and the result is reported in stageDefaults. ' +
        NATIVE_FIRST_NOTE,
      parameters: {
        parent: {
          type: 'string',
          description:
            'Positional path of the parent that receives the subtree root, for example "0" (root) or "0/2/0". Defaults to "0".',
        },
        tree: {
          type: 'object',
          additionalProperties: true,
          required: true,
          description:
            'Nested node spec: {"type": "...", "attributes": {"AttrCap": "value"}, "children": [ ...same shape... ]}. ' +
            'Attribute names must match the node caption exactly (case insensitive fallback).',
        },
        reveal: {
          type: 'boolean',
          description: 'Expand ancestors and select the new root afterwards. Defaults to true.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: toolTimeout,
      async execute(args, exec) {
        try {
          const reference = resolveNodeReference(args                           , {
            pathKey: 'parent',
            defaultPath: '0',
          })
          const tree = normalizeSubtree(args.tree)
          const reveal = args.reveal !== false

          const startedAt = performance.now()
          const built = await applySubtree(client, subtreeCapability, reference.path, tree, {
            reveal,
            signal: exec.signal,
          })

          // Same guard as luastg_add_node, for every Stage the tree spec created.
          const stageDefaults =
            built.path !== '' && subtreeSpecHasStage(tree)
              ? await tryGuardStages(client, built.path, exec.signal)
              : undefined

          return {
            ...envelope(client, built.strategy === 'apply_subtree' ? 'apply_subtree' : 'insert_node', {}, startedAt),
            strategy: built.strategy,
            created: built.created,
            path: built.path,
            text: built.text,
            parentPath: built.parentPath,
            ...(built.nodeCount === undefined ? {} : { nodeCount: built.nodeCount }),
            ...(stageDefaults === undefined ? {} : { stageDefaults }),
            ...(stageDefaults?.nodeCount === undefined ? {} : { nodeCount: stageDefaults.nodeCount }),
            pathNote: POSITIONAL_PATH_NOTE,
          }
        } catch (error) {
          toolError('luastg_apply_subtree', error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'luastg_delete_node',
      description:
        'Delete one node and its entire subtree from the project open in LuaSTG Editor Sharp X through the MCP ' +
        'bridge. The editor executes a real DeleteCommand on its UI thread, so Undo restores the node and the WPF ' +
        'tree updates. Address it by path ("0/4/2") or the deprecated node_id ("0.4.2"). The document root cannot be ' +
        'deleted, and types marked [CannotDelete] are refused by the editor. Returns the removed path, type, text, ' +
        'parentPath, index and the new nodeCount. Paths are positional: later siblings shift, so re-read the tree ' +
        'before addressing other nodes. dry_run is not supported by the bridge.',
      parameters: {
        path: {
          type: 'string',
          description: 'Positional path of the node to delete, for example "0/4/2". Required unless node_id is given.',
        },
        node_id: {
          type: 'string',
          description: 'Deprecated alias for path: a dot-separated node id such as "0.4.2".',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: toolTimeout,
      async execute(args, exec) {
        try {
          const reference = resolveNodeReference(args                           , {
            pathKey: 'path',
            legacyKey: 'node_id',
          })

          const startedAt = performance.now()
          const response = await client.request(
            { action: 'delete_node', path: reference.path },
            exec.signal,
          )

          return {
            ...envelope(client, 'delete_node', response, startedAt),
            pathNote: POSITIONAL_PATH_NOTE,
          }
        } catch (error) {
          toolError('luastg_delete_node', error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'luastg_update_script',
      description:
        'Replace the whole Lua script stored in the "Code" attribute of one node in the project open in LuaSTG ' +
        'Editor Sharp X through the MCP bridge. Implemented as set_attribute name="Code": the text is sent exactly as ' +
        'given (no local escaping or line-ending rewriting) and becomes one undoable editor command. Maximum 4 MiB ' +
        'of UTF-8. Address the node by path ("0/4/2") or the deprecated node_id ("0.4.2"). Returns only size summaries ' +
        'and the node display text, never the old or new script, so large scripts stay cheap. The node must already ' +
        'have a Code attribute; otherwise the editor returns unknown_attribute with the available names.',
      parameters: {
        path: {
          type: 'string',
          description:
            'Positional path of the node whose Code attribute should be replaced, for example "0/4/2". Required ' +
            'unless node_id is given.',
        },
        node_id: {
          type: 'string',
          description: 'Deprecated alias for path: a dot-separated node id such as "0.4.2".',
        },
        script_content: {
          type: 'string',
          required: true,
          description:
            'The complete new Lua source. May contain newlines, quotes and backslashes. An empty string clears the ' +
            'script. Maximum 4 MiB of UTF-8.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: toolTimeout,
      async execute(args, exec) {
        try {
          const reference = resolveNodeReference(args                           , {
            pathKey: 'path',
            legacyKey: 'node_id',
          })
          if (typeof args.script_content !== 'string') {
            throw new Error('script_content must be a string')
          }
          const script = args.script_content
          const scriptBytes = Buffer.byteLength(script, 'utf8')
          if (scriptBytes > 4 * 1024 * 1024) {
            throw new Error(`script_content is ${scriptBytes} bytes; the maximum is 4194304 bytes (4 MiB)`)
          }

          const startedAt = performance.now()
          const response = await client.request(
            { action: 'set_attribute', path: reference.path, name: 'Code', value: script },
            exec.signal,
          )
          const oldValue = typeof response.oldValue === 'string' ? response.oldValue : ''

          return {
            ...envelope(client, 'set_attribute', rewriteScriptResponse(response), startedAt),
            path: reference.path,
            attribute: typeof response.name === 'string' ? response.name : 'Code',
            changed: response.changed === true,
            script: summarizeScript(script),
            previous: summarizeScript(oldValue),
            text: typeof response.text === 'string' ? response.text : '',
          }
        } catch (error) {
          toolError('luastg_update_script', error)
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'luastg_take_screenshot',
      description:
        'Capture the currently open LuaSTG Editor Sharp X window and save it as a PNG. Prefers the bridge action ' +
        'take_screenshot (Base64 PNG rendered from the WPF window); when the installed bridge predates that action ' +
        'it falls back to capturing the window locally with PowerShell, so no editor restart is needed. The PNG is ' +
        'returned as Base64 (imageBase64) and its byte size plus the window title are reported. Nothing is left on ' +
        'disk: the bridge path never writes a file, and the local capture writes one file under the system temp ' +
        'directory that is deleted again before this tool returns — even when the capture fails. Pass window_title ' +
        'to match another window ("LuaSTG Editor" by default).',
      parameters: {
        window_title: {
          type: 'string',
          description:
            'Substring of the window title, used only by the local capture fallback. Defaults to "LuaSTG Editor".',
        },
        keep_file: {
          type: 'boolean',
          description:
            'Keep the PNG on disk instead of deleting it, and return its absolute path. Needed when something has ' +
            'to open the image (read_image, a review loop); the default false leaves nothing behind.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const record = value                           
          return [
            {
              type: 'text',
              text:
                `Captured the editor window "${String(record.window ?? '')}" ` +
                `(${String(record.bytes ?? 0)} bytes PNG, via ${String(record.source)}). ` +
                'The image is delivered as Base64 in the structured result (imageBase64); ' +
                'no temporary file is left behind.',
            },
          ]
        },
      },
      timeoutMs: toolTimeout,
      async execute(args, exec) {
        const windowTitle = text(args.window_title) || DEFAULT_WINDOW_TITLE
        const keepFile = args.keep_file === true
        const startedAt = performance.now()
        // Only the PowerShell fallback needs a file; it is removed in `finally` unless keep_file.
        const tempFile = defaultScreenshotPath()
        let keepPath                    

        try {
          // 1) Ask the bridge for the window bitmap: it answers Base64 and writes nothing.
          try {
            const response = await client.request({ action: SCREENSHOT_ACTION, format: 'png' }, exec.signal)
            const base64 = typeof response.imageBase64 === 'string' ? response.imageBase64 : ''
            if (base64 === '') throw new Error('the bridge answered take_screenshot without imageBase64')

            const image = Buffer.from(base64, 'base64')
            if (keepFile) keepPath = writeOnce(tempFile, image)
            return screenshotResult(client, 'bridge', image, windowTitle, startedAt, keepPath)
          } catch (error) {
            // A bridge that predates the action is expected: fall back to a local capture.
            if (!(error instanceof BridgeCommandError) || error.status !== 'unknown_action') throw error
          }

          // 2) Fallback: capture the window from this machine, then read and burn it.
          if (!captureFallback) {
            throw new Error(
              'the installed bridge has no take_screenshot action and captureFallback is disabled; ' +
                'rebuild the C# bridge with csharp/take-screenshot.cs or enable captureFallback',
            )
          }

          mkdirSync(dirname(tempFile), { recursive: true })
          runWindowCapture(tempFile, windowTitle, toolTimeout)
          const image = readFileSync(tempFile)
          if (keepFile) keepPath = tempFile
          return screenshotResult(client, 'powershell', image, windowTitle, startedAt, keepPath)
        } catch (error) {
          toolError('luastg_take_screenshot', error)
        } finally {
          // Burn after reading, unless keep_file asked for a physical file on purpose.
          if (keepPath === undefined) removeQuietly(tempFile)
        }
      },
    }),
  )
}


//# sourceURL=src\index.ts