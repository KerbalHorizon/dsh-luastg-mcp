import assert from 'node:assert/strict'
import test from 'node:test'

import { startMockBridge } from './mock-bridge.mjs'

const available = typeof process.env.DSH_PACKAGES === 'string' && process.env.DSH_PACKAGES !== ''
const skip = available ? false : 'no local DSH installation found; set DSH_PACKAGES to run this test'
const plugin = available ? await import('../lib/index.js') : null

function exec() {
  return { signal: AbortSignal.timeout(5000) }
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

test('registers only the five path-based bridge tools', { skip }, () => {
  const registered = []
  plugin.apply({ tools: { register: (definition) => registered.push(definition) } }, {})
  assert.deepEqual(
    registered.map((definition) => definition.name),
    [
      'luastg_get_nodes',
      'luastg_update_node',
      'luastg_add_node',
      'luastg_delete_node',
      'luastg_update_script',
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
    assert.match(error.message, /打开一个 \.lstges 工程/)
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
    assert.match(error.message, /^luastg_get_nodes: 无法连接 LuaSTG 编辑器 MCP 桥接/)
    assert.match(error.message, /连接失败，请确保 LuaSTG 编辑器已启动并加载了 MCP 桥接插件/)
    assert.ok(error.message.includes(`127.0.0.1:${port}`))
    return true
  })
})
