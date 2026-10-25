import assert from 'node:assert/strict'
import test from 'node:test'

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startMockBridge } from './mock-bridge.mjs'

const available = typeof process.env.DSH_PACKAGES === 'string' && process.env.DSH_PACKAGES !== ''
const skip = available ? false : 'no local DSH installation found; set DSH_PACKAGES to run this test'
const plugin = available ? await import('../lib/index.js') : null

function exec() {
  return { signal: AbortSignal.timeout(5000) }
}

/** Nested tree the mock knows how to build: Folder -> (TaskWait, Folder -> TaskWait). */
function sampleSubtree() {
  return {
    type: 'Folder',
    attributes: { Name: 'Built' },
    children: [
      { type: 'TaskWait', attributes: { Time: '60' } },
      {
        type: 'Folder',
        attributes: { Name: 'Inner' },
        children: [{ type: 'TaskWait', attributes: { Time: '10' } }],
      },
    ],
  }
}

async function setup(t, config = {}, options = {}) {
  const bridge = await startMockBridge(options)
  t.after(async () => {
    await bridge.close()
  })

  const registered = []
  plugin.apply(
    { tools: { register: (definition) => registered.push(definition) } },
    { port: bridge.port, timeoutMs: 2000, ...config },
  )
  const byName = new Map(registered.map((definition) => [definition.name, definition]))
  return { bridge, byName }
}

test('registers the seven path-based bridge tools', { skip }, () => {
  const registered = []
  plugin.apply({ tools: { register: (definition) => registered.push(definition) } }, {})
  assert.deepEqual(
    registered.map((definition) => definition.name),
    [
      'luastg_get_nodes',
      'luastg_update_node',
      'luastg_add_node',
      'luastg_apply_subtree',
      'luastg_delete_node',
      'luastg_update_script',
      'luastg_take_screenshot',
    ],
  )
})

test('get_nodes reads the live tree through the bridge', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_get_nodes')

  const value = await tool.execute({}, exec())

  assert.equal(value.ok, true)
  assert.equal(value.source, 'editor')
  assert.equal(value.transport, 'tcp')
  assert.equal(value.endpoint, bridge.endpoint)
  assert.equal(value.action, 'get_tree')
  assert.equal(value.path, '0')
  assert.equal(value.document.name, 'MockStage')
  assert.equal(value.document.nodeCount, 7)
  assert.equal(value.tree.path, '0')
  assert.equal(value.tree.type, 'RootFolder')
  assert.deepEqual(bridge.requests[0], { action: 'get_tree', path: '0', maxDepth: 0, attributes: true })

  const rendered = tool.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.deepEqual(JSON.parse(rendered[0].text), value)
})

test('get_nodes forwards maxDepth and attributes=false', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_get_nodes')

  const value = await tool.execute({ path: '0', maxDepth: 1, attributes: false }, exec())

  assert.equal(value.maxDepth, 1)
  assert.equal(value.attributes, false)
  assert.equal(value.tree.attributes, undefined)
  assert.equal(value.tree.type, 'RootFolder')
  assert.equal(value.tree.children[0].children.length, 0)
  assert.equal(value.tree.children[0].truncated, true)
  assert.deepEqual(bridge.requests[0], { action: 'get_tree', path: '0', maxDepth: 1, attributes: false })
})

test('get_nodes accepts legacy node_id and a dotted path', { skip }, async (t) => {
  const { byName } = await setup(t)
  const tool = byName.get('luastg_get_nodes')

  const legacy = await tool.execute({ node_id: '0.0.0' }, exec())
  assert.equal(legacy.path, '0/0/0')
  assert.equal(legacy.tree.type, 'Stage')
  assert.equal(legacy.tree.text, 'Stage 1')

  const dotted = await tool.execute({ path: '0.1' }, exec())
  assert.equal(dotted.path, '0/1')
  assert.equal(dotted.tree.type, 'Stage')
  assert.equal(dotted.tree.text, 'Stage 2')
})

test('get_nodes rejects conflicting path and node_id', { skip }, async (t) => {
  const { byName } = await setup(t)
  const tool = byName.get('luastg_get_nodes')
  await assert.rejects(tool.execute({ path: '0/0', node_id: '0.1' }, exec()), /point at different nodes/)
})

test('get_nodes turns no_document into an actionable error', { skip }, async (t) => {
  const { byName } = await setup(t, {}, { document: null })
  const tool = byName.get('luastg_get_nodes')

  await assert.rejects(tool.execute({}, exec()), (error) => {
    assert.match(error.message, /^luastg_get_nodes: no_document:/)
    assert.match(error.message, /打开一个 .lstges 工程/)
    return true
  })
})

test('add_node maps parent, type, index and attributes to insert_node', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_add_node')

  const value = await tool.execute(
    {
      parent: '0/0',
      node_type: '.Comment',
      index: 0,
      attributes: { Comment: 'hello', Flag: true, Count: 3 },
    },
    exec(),
  )

  assert.deepEqual(bridge.requests[0], {
    action: 'insert_node',
    parent: '0/0',
    type: 'Comment',
    index: 0,
    attributes: { Comment: 'hello', Flag: 'true', Count: '3' },
  })
  assert.equal(value.ok, true)
  assert.equal(value.path, '0/0/0')
  assert.equal(value.parentPath, '0/0')
  assert.equal(value.index, 0)
  assert.equal(value.type, 'Comment')
  assert.equal(value.text, 'hello')
  assert.equal(value.selected, true)
  assert.match(value.pathNote, /positional/i)
})

test('add_node defaults to the root and appends', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_add_node')

  const value = await tool.execute({ node_type: 'Comment', attributes: { Comment: 'x' } }, exec())
  const request = bridge.requests[0]

  assert.equal(request.parent, '0')
  assert.equal('index' in request, false)
  assert.equal(request.type, 'Comment')
  assert.equal(request.attributes.Comment, 'x')
  assert.equal(value.path, '0/2')
})

test('add_node accepts legacy parent_id and rejects bad index/type', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_add_node')

  const value = await tool.execute({ parent_id: '0.1', node_type: 'Folder' }, exec())
  assert.equal(bridge.requests[0].parent, '0/1')
  assert.equal(value.path, '0/1/1')

  await assert.rejects(tool.execute({ node_type: 'NoSuchNode' }, exec()), /unknown_node_type/)
  const afterUnknownType = bridge.requests.length
  await assert.rejects(tool.execute({ node_type: 'Comment', index: -1 }, exec()), /index must be between/)
  assert.equal(bridge.requests.length, afterUnknownType, 'a bad index must be rejected before the request')
})

test('add_node accepts .lstges shorthand and full .NET type names', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_add_node')

  const shorthand = await tool.execute({ parent: '0/1', node_type: 'Task.TaskWait' }, exec())
  assert.equal(bridge.requests[0].type, 'TaskWait')
  assert.equal(shorthand.type, 'TaskWait')

  const fullName = 'LuaSTGEditorSharp.EditorData.Node.General.Comment'
  const full = await tool.execute({ parent: '0/1', node_type: fullName }, exec())
  assert.equal(bridge.requests[1].type, fullName)
  assert.equal(full.type, 'Comment')
  assert.equal(full.typeFullName, fullName)
})

test('add_node gives a new Stage the Initialize folder and a background node', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_add_node')

  const value = await tool.execute(
    { parent: '0/0', node_type: 'Stage', attributes: { Name: 'Stage 3' } },
    exec(),
  )

  assert.deepEqual(
    bridge.requests.map((request) => [request.action, request.parent, request.type]),
    [
      ['insert_node', '0/0', 'Stage'],
      ['get_tree', undefined, undefined],
      ['insert_node', '0/0/1', 'Folder'],
      ['insert_node', '0/0/1/0', 'StageBG'],
    ],
  )
  assert.equal(bridge.requests[2].index, 0, 'the Initialize folder must be the first child')
  assert.equal(bridge.requests[2].attributes.Name, 'Initialize')
  assert.equal(bridge.requests[2].reveal, false, 'the repair must not steal the selection')
  assert.equal(bridge.requests[3].attributes.Background, 'temple_background')

  assert.equal(value.ok, true)
  assert.equal(value.path, '0/0/1')
  assert.deepEqual(value.stageDefaults, {
    stages: 1,
    initialized: 1,
    alreadyInitialized: 0,
    items: [
      {
        path: '0/0/1',
        action: 'created',
        folderPath: '0/0/1/0',
        backgroundPath: '0/0/1/0/0',
        background: 'temple_background',
      },
    ],
    nodeCount: 10,
  })
  assert.equal(value.nodeCount, 10, 'nodeCount must include the nodes the repair created')

  const created = bridge.document.root.children[0].children[1]
  assert.equal(created.type, 'Stage')
  assert.equal(created.children[0].type, 'Folder')
  assert.equal(created.children[0].attributes[0].value, 'Initialize')
  assert.equal(created.children[0].children[0].type, 'StageBG')
  assert.equal(value.nodeCount, 10)
})

test('add_node leaves other node types untouched', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_add_node')

  const value = await tool.execute({ parent: '0/0/0', node_type: 'TaskWait', attributes: { Time: '30' } }, exec())

  assert.deepEqual(bridge.requests.map((request) => request.action), ['insert_node'])
  assert.equal('stageDefaults' in value, false)
})

test('add_node reports a Stage it could not repair instead of failing the insert', { skip }, async (t) => {
  const { bridge, byName } = await setup(t, {}, { rejectTypes: ['StageBG'] })
  const tool = byName.get('luastg_add_node')

  const value = await tool.execute({ parent: '0/0', node_type: 'Stage', attributes: { Name: 'Broken' } }, exec())

  assert.equal(value.ok, true, 'the Stage itself was inserted, so the call succeeded')
  assert.equal(value.stageDefaults.stages, 1)
  assert.equal(value.stageDefaults.initialized, 0)
  assert.equal(value.stageDefaults.items[0].action, 'failed')
  assert.match(value.stageDefaults.items[0].error, /StageBG|rejected/i)
  assert.match(value.stageDefaults.warning, /Initialize folder or the background/i)
  assert.equal(bridge.requests.some((request) => request.action === 'delete_node'), false, 'nothing is rolled back')
})

test('apply_subtree repairs every Stage it creates', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_apply_subtree')

  const value = await tool.execute(
    {
      parent: '0',
      tree: {
        type: 'StageGroup',
        attributes: { Name: 'Group B' },
        children: [{ type: 'Stage', attributes: { Name: 'Stage 3' } }],
      },
    },
    exec(),
  )

  assert.deepEqual(
    bridge.requests.map((request) => [request.action, request.parent, request.type]),
    [
      ['apply_subtree', '0', undefined],
      ['insert_node', '0', 'StageGroup'],
      ['insert_node', '0/2', 'Stage'],
      ['get_tree', undefined, undefined],
      ['insert_node', '0/2/0', 'Folder'],
      ['insert_node', '0/2/0/0', 'StageBG'],
    ],
  )
  assert.equal(value.strategy, 'insert_node-dfs')
  assert.equal(value.created, 2)
  assert.equal(value.stageDefaults.stages, 1)
  assert.equal(value.stageDefaults.items[0].action, 'created')

  const stage = bridge.document.root.children[2].children[0]
  assert.equal(stage.type, 'Stage')
  assert.equal(stage.children[0].type, 'Folder')
  assert.equal(stage.children[0].children[0].type, 'StageBG')
})

test('apply_subtree never duplicates a background the tree already provides', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_apply_subtree')

  const value = await tool.execute(
    {
      parent: '0',
      tree: {
        type: 'StageGroup',
        attributes: { Name: 'Group C' },
        children: [
          {
            type: 'Stage',
            attributes: { Name: 'Stage 4' },
            children: [
              {
                type: 'Folder',
                attributes: { Name: 'Initialize' },
                children: [{ type: 'StageBG', attributes: { Background: 'starlight_background' } }],
              },
            ],
          },
        ],
      },
    },
    exec(),
  )

  const backgroundInserts = bridge.requests.filter(
    (request) => request.action === 'insert_node' && request.type === 'StageBG',
  )
  assert.equal(backgroundInserts.length, 1, 'only the background from the spec exists')
  assert.equal(backgroundInserts[0].attributes.Background, 'starlight_background')
  assert.equal(value.stageDefaults.items[0].action, 'already-initialized')
  assert.equal(value.stageDefaults.alreadyInitialized, 1)
  assert.equal(value.stageDefaults.initialized, 0)
})

test('apply_subtree skips the Stage check when the tree has no Stage', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_apply_subtree')

  const value = await tool.execute({ parent: '0', tree: { type: 'Comment', attributes: { Comment: 'only' } } }, exec())

  assert.deepEqual(bridge.requests.map((request) => request.action), ['apply_subtree', 'insert_node'])
  assert.equal('stageDefaults' in value, false)
})

test('apply_subtree falls back to depth-first insert_node on a protocol-v1 bridge', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_apply_subtree')

  const value = await tool.execute({ parent: '0/0', tree: sampleSubtree() }, exec())

  // 1) the bulk action is probed once, 2) every node then goes through insert_node.
  assert.equal(bridge.requests[0].action, 'apply_subtree')
  assert.deepEqual(
    bridge.requests.slice(1).map((request) => [request.action, request.parent, request.type]),
    [
      ['insert_node', '0/0', 'Folder'],
      ['insert_node', '0/0/1', 'TaskWait'],
      ['insert_node', '0/0/1', 'Folder'],
      ['insert_node', '0/0/1/1', 'TaskWait'],
    ],
  )
  assert.equal(bridge.requests[1].attributes.Name, 'Built')
  assert.equal(bridge.requests[1].reveal, false, 'intermediate inserts must not select rows')
  assert.equal(bridge.requests[4].reveal, true, 'the final insert expands the whole chain')

  assert.equal(value.ok, true)
  assert.equal(value.strategy, 'insert_node-dfs')
  assert.equal(value.created, 4)
  assert.equal(value.path, '0/0/1')
  assert.equal(value.parentPath, '0/0')
  assert.equal(value.text, 'Built')
  assert.equal(value.nodeCount, 11)
  assert.match(value.pathNote, /positional/i)

  const nested = bridge.document.root.children[0].children[1]
  assert.equal(nested.type, 'Folder')
  assert.equal(nested.text, 'Built')
  assert.equal(nested.children[1].text, 'Inner')
  assert.equal(nested.children[1].children[0].type, 'TaskWait')
  assert.equal(nested.children[1].children[0].attributes[0].value, '10')
})

test('apply_subtree probes the bulk action only once per bridge and honours reveal:false', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_apply_subtree')

  await tool.execute({ parent: '0', tree: { type: 'Comment', attributes: { Comment: 'a' } } }, exec())
  const afterFirstCall = bridge.requests.length
  await tool.execute({ parent: '0', tree: { type: 'Comment', attributes: { Comment: 'b' } }, reveal: false }, exec())

  const probes = bridge.requests.filter((request) => request.action === 'apply_subtree')
  assert.equal(probes.length, 1, 'unknown_action must be remembered, not retried')
  assert.equal(bridge.requests[1].action, 'insert_node')
  assert.equal(bridge.requests[1].reveal, true, 'the default selects the last created node')

  const secondCall = bridge.requests.slice(afterFirstCall)
  const inserts = secondCall.filter((request) => request.action === 'insert_node')
  assert.equal(inserts.length, 1)
  assert.equal(inserts[0].reveal, false, 'reveal:false must not touch the selection')
})

test('apply_subtree uses the bulk action when the bridge implements it', { skip }, async (t) => {
  const { bridge, byName } = await setup(t, {}, { applySubtree: true })
  const tool = byName.get('luastg_apply_subtree')

  const value = await tool.execute({ parent: '0', tree: sampleSubtree() }, exec())

  assert.deepEqual(bridge.requests.map((request) => request.action), ['apply_subtree'])
  assert.equal(value.strategy, 'apply_subtree')
  assert.equal(value.created, 4)
  assert.equal(value.path, '0/2')
  assert.equal(value.text, 'Built')
  assert.equal(value.nodeCount, 11)
})

test('apply_subtree rolls back every created node when one insert is rejected', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_apply_subtree')

  await assert.rejects(
    tool.execute(
      {
        parent: '0',
        tree: {
          type: 'Folder',
          attributes: { Name: 'Doomed' },
          children: [
            { type: 'TaskWait', attributes: { Time: '60' } },
            { type: 'NoSuchNode' },
          ],
        },
      },
      exec(),
    ),
    (error) => {
      assert.match(error.message, /^luastg_apply_subtree: unknown_node_type:/)
      assert.match(error.message, /rolled back: deleted '0\/2'/)
      return true
    },
  )

  assert.deepEqual(
    bridge.requests.map((request) => request.action),
    ['apply_subtree', 'insert_node', 'insert_node', 'insert_node', 'delete_node'],
  )
  assert.equal(bridge.requests.at(-1).path, '0/2')
  assert.equal(bridge.document.root.children.length, 2, 'the document must be back to its original shape')
  assert.equal(bridge.document.root.children[1].text, 'Stage 2')
})

test('update_node sends one set_attribute per attribute and reports both', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_update_node')

  const value = await tool.execute({ path: '0', attributes: { Name: 'Renamed root', Comment: 'updated' } }, exec())

  assert.deepEqual(bridge.requests, [
    { action: 'set_attribute', path: '0', name: 'Name', value: 'Renamed root' },
    { action: 'set_attribute', path: '0', name: 'Comment', value: 'updated' },
  ])
  assert.equal(value.changedCount, 2)
  assert.equal(value.unchangedCount, 0)
  assert.deepEqual(value.changed.map((item) => item.name), ['Name', 'Comment'])
  assert.deepEqual(value.changed[0], {
    name: 'Name',
    oldValue: 'MockStage',
    newValue: 'Renamed root',
    changed: true,
  })
  assert.equal(value.text, 'Renamed root')
})

test('update_node reports unchanged values without inventing changes', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_update_node')

  const value = await tool.execute({ path: '0', attributes: { Name: 'MockStage' } }, exec())
  assert.equal(value.changedCount, 0)
  assert.equal(value.unchangedCount, 1)
  assert.deepEqual(value.unchanged, ['Name'])
  assert.equal(bridge.requests[0].name, 'Name')
})

test('update_node lists what was applied when a later attribute fails', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_update_node')

  await assert.rejects(
    tool.execute({ path: '0', attributes: { Name: 'Applied', Missing: 'x' } }, exec()),
    (error) => {
      assert.match(error.message, /^luastg_update_node: unknown_attribute:/)
      assert.match(error.message, /1 attribute\(s\) already applied: Name/)
      assert.match(error.message, /NOT rolled back/)
      return true
    },
  )

  assert.equal(bridge.requests.length, 2)
  assert.equal(bridge.document.root.attributes.find((item) => item.name === 'Name').value, 'Applied')
})

test('update_node summarizes long values instead of echoing them', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_update_node')

  const value = await tool.execute({ path: '0/1/0', attributes: { Code: 'print("new")' } }, exec())

  assert.equal(value.changedCount, 1)
  assert.deepEqual(value.changed[0], {
    name: 'Code',
    changed: true,
    oldChars: 12,
    newChars: 12,
    oldBytes: 12,
    newBytes: 12,
    valuesOmitted: true,
  })
  assert.equal('oldValue' in value.changed[0], false)
  assert.equal(bridge.requests[0].name, 'Code')
})

test('update_node accepts legacy node_id', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_update_node')

  const value = await tool.execute({ node_id: '0.1', attributes: { Name: 'Legacy' } }, exec())
  assert.equal(value.path, '0/1')
  assert.equal(bridge.requests[0].path, '0/1')
})

test('update_node requires a node reference', { skip }, async (t) => {
  const { byName } = await setup(t)
  const tool = byName.get('luastg_update_node')
  await assert.rejects(tool.execute({ attributes: { Name: 'x' } }, exec()), /luastg_update_node: path is required/)
})

test('update_script maps to set_attribute name=Code and returns only sizes', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_update_script')
  const script = 'function f()\n  print("x\\\\y")\nend'

  const value = await tool.execute({ path: '0/1/0', script_content: script }, exec())

  assert.deepEqual(bridge.requests[0], {
    action: 'set_attribute',
    path: '0/1/0',
    name: 'Code',
    value: script,
  })
  assert.equal(value.path, '0/1/0')
  assert.equal(value.attribute, 'Code')
  assert.equal(value.changed, true)
  assert.deepEqual(value.script, {
    chars: script.length,
    lines: 3,
    bytes: Buffer.byteLength(script, 'utf8'),
  })
  assert.deepEqual(value.previous, { chars: 12, lines: 1, bytes: 12 })
  assert.equal('oldValue' in value, false)
  assert.equal('newValue' in value, false)
  assert.equal('sha256' in value, false)
})

test('update_script supports legacy node_id and an empty script', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_update_script')

  const value = await tool.execute({ node_id: '0.1.0', script_content: '' }, exec())
  assert.equal(bridge.requests[0].path, '0/1/0')
  assert.equal(value.path, '0/1/0')
  assert.equal(value.changed, true)
  assert.deepEqual(value.script, { chars: 0, lines: 0, bytes: 0 })
  assert.deepEqual(value.previous, { chars: 12, lines: 1, bytes: 12 })
})

test('update_script surfaces a missing Code attribute and the 4 MiB limit', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_update_script')

  await assert.rejects(tool.execute({ path: '0/1', script_content: 'x' }, exec()), /unknown_attribute/)
  assert.equal(bridge.requests.length, 1)

  const huge = 'x'.repeat(4 * 1024 * 1024 + 1)
  await assert.rejects(tool.execute({ path: '0/1/0', script_content: huge }, exec()), /maximum is 4194304/)
  assert.equal(bridge.requests.length, 1)
})

test('delete_node removes a subtree and the next sibling shifts into its path', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const deleteTool = byName.get('luastg_delete_node')
  const readTool = byName.get('luastg_get_nodes')

  const removed = await deleteTool.execute({ path: '0/0' }, exec())
  assert.equal(removed.path, '0/0')
  assert.equal(removed.type, 'StageGroup')
  assert.equal(removed.text, 'Group A')
  assert.equal(removed.parentPath, '0')
  assert.equal(removed.index, 0)
  assert.equal(removed.nodeCount, 3)
  assert.match(removed.pathNote, /positional/i)

  const shifted = await readTool.execute({ path: '0/0' }, exec())
  assert.equal(shifted.tree.type, 'Stage')
  assert.equal(shifted.tree.text, 'Stage 2')

  assert.deepEqual(bridge.requests.map((request) => request.action), ['delete_node', 'get_tree'])
})

test('delete_node refuses the root and accepts legacy node_id', { skip }, async (t) => {
  const { bridge, byName } = await setup(t)
  const tool = byName.get('luastg_delete_node')

  await assert.rejects(tool.execute({ path: '0' }, exec()), /cannot_delete: the root node cannot be deleted/)

  const removed = await tool.execute({ node_id: '0.1' }, exec())
  assert.equal(removed.path, '0/1')
  assert.equal(removed.text, 'Stage 2')
  assert.equal(bridge.requests.length, 2)
})

test('the tools explain a refused editor connection', { skip }, async () => {
  const bridge = await startMockBridge()
  const port = bridge.port
  await bridge.close()

  const registered = []
  plugin.apply({ tools: { register: (definition) => registered.push(definition) } }, { port, timeoutMs: 1000 })
  const tool = registered.find((definition) => definition.name === 'luastg_get_nodes')

  await assert.rejects(tool.execute({}, exec()), (error) => {
    assert.match(error.message, /^luastg_get_nodes: 无法连接/)
    assert.match(error.message, /连接失败，请确保 LuaSTG 编辑器已启动并加载了 MCP 桥接插件/)
    assert.ok(error.message.includes(`127.0.0.1:${port}`))
    return true
  })
})

test('take_screenshot returns the bridge PNG as Base64 and writes no file', { skip }, async (t) => {
  const { bridge, byName } = await setup(t, {}, { screenshot: true })
  const tool = byName.get('luastg_take_screenshot')

  const value = await tool.execute({}, exec())

  assert.deepEqual(bridge.requests[0], { action: 'take_screenshot', format: 'png' })
  assert.equal(value.ok, true)
  assert.equal(value.source, 'bridge')
  assert.equal(value.format, 'png')
  assert.equal(value.temporaryFileWritten, false, 'the bridge path must not touch the disk')
  assert.equal(value.temporaryFileDeleted, true)

  const image = Buffer.from(value.imageBase64, 'base64')
  assert.equal(value.bytes, image.length)
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the payload is a real PNG')

  const rendered = tool.output.render({}, value)
  assert.match(rendered[0].text, /no temporary file is left behind/)
})

test('take_screenshot burns its temp file even when the capture fails', { skip }, async (t) => {
  // unknown_action on the bridge + a window title that cannot exist: the local capture fails,
  // and the finally block still has to leave the temp directory clean.
  const { byName } = await setup(t, { captureFallback: true })
  const tool = byName.get('luastg_take_screenshot')

  const before = readdirSync(tmpdir()).filter((name) => name.startsWith('luastg_shot_'))
  await assert.rejects(
    tool.execute({ window_title: 'no-such-window-3f9c1a' }, exec()),
    /luastg_take_screenshot:/,
  )
  const after = readdirSync(tmpdir()).filter((name) => name.startsWith('luastg_shot_'))
  assert.deepEqual(after.sort(), before.sort(), 'no luastg_shot_*.png may survive a failed capture')
})

test('take_screenshot explains a bridge without the action when the fallback is off', { skip }, async (t) => {
  const { byName } = await setup(t, { captureFallback: false })
  const tool = byName.get('luastg_take_screenshot')

  await assert.rejects(tool.execute({}, exec()), /no take_screenshot action and captureFallback is disabled/)
})
test('take_screenshot keeps the PNG on disk when keep_file is set', { skip }, async (t) => {
  const { byName } = await setup(t, {}, { screenshot: true })
  const tool = byName.get('luastg_take_screenshot')

  const value = await tool.execute({ keep_file: true }, exec())
  t.after(() => rmSync(value.path, { force: true }))

  assert.equal(value.temporaryFileDeleted, false)
  assert.equal(value.kept, true)
  assert.ok(value.path.startsWith(tmpdir()), 'kept files stay in the system temp directory')
  assert.equal(statSync(value.path).size, value.bytes)
  assert.equal(existsSync(value.path), true)
})