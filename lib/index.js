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
  const client = new BridgeClient({ host, port, timeoutMs })
  const toolTimeout = Math.min(120_000, Math.max(15_000, timeoutMs + 10_000))

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
        'deprecated alias for parent.',
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

          return {
            ...envelope(client, 'insert_node', response, startedAt),
            parentPath: typeof response.parentPath === 'string' ? response.parentPath : reference.path,
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
}


//# sourceURL=src\index.ts