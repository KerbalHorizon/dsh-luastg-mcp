import assert from 'node:assert/strict'
import test from 'node:test'

const available = typeof process.env.DSH_PACKAGES === 'string' && process.env.DSH_PACKAGES !== ''
const skip = available ? false : 'no local DSH installation found; set DSH_PACKAGES to run this test'
const plugin = available ? await import('../lib/index.js') : null

function createHost() {
  const registered = []
  return {
    registered,
    ctx: { tools: { register: (definition) => registered.push(definition) } },
  }
}

function register(config = {}) {
  const host = createHost()
  plugin.apply(host.ctx, config)
  const byName = new Map(host.registered.map((definition) => [definition.name, definition]))
  return { host, byName }
}

test('exports the plugin contract with the bridge defaults', { skip }, () => {
  assert.ok(plugin !== null)
  assert.equal(plugin.name, 'luastg-mcp')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.Config, 'function')
  assert.deepEqual(plugin.Config({}), {
    host: '127.0.0.1',
    port: 8090,
    timeoutMs: 5000,
    maxDepth: 0,
  })
})

test('registers the five path-based tools and no removed tools', { skip }, () => {
  const { host, byName } = register()
  assert.deepEqual(
    host.registered.map((definition) => definition.name),
    [
      'luastg_get_nodes',
      'luastg_update_node',
      'luastg_add_node',
      'luastg_delete_node',
      'luastg_update_script',
    ],
  )
  assert.equal(byName.has('luastg_search_nodes'), false)
  assert.equal(byName.has('luastg_batch_update'), false)
})

test('every tool has a description, parameters, output and timeout', { skip }, () => {
  const { host } = register()
  for (const definition of host.registered) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, `${definition.name}: description is informative`)
    assert.equal(definition.parameters?.type, 'object', `${definition.name}: parameter root`)
    assert.equal(typeof definition.execute, 'function', `${definition.name}: execute`)
    assert.equal(typeof definition.output?.render, 'function', `${definition.name}: output.render`)
    assert.equal(typeof definition.output?.schema, 'object', `${definition.name}: output.schema`)
    assert.ok(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0, `${definition.name}: timeoutMs`)
    assert.equal(definition.parameters.properties.projectFile, undefined, `${definition.name}: projectFile is gone`)
  }
})

test('get_nodes exposes path + legacy node_id + read options', { skip }, () => {
  const { byName } = register()
  const tool = byName.get('luastg_get_nodes')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['attributes', 'maxDepth', 'node_id', 'path'])
  assert.equal(tool.parameters.required, undefined)
  assert.equal(tool.parameters.properties.path.type, 'string')
  assert.equal(tool.parameters.properties.node_id.type, 'string')
  assert.equal(tool.parameters.properties.maxDepth.type, 'integer')
  assert.equal(tool.parameters.properties.attributes.type, 'boolean')
})

test('update_node keeps attributes required and path optional for compatibility', { skip }, () => {
  const { byName } = register()
  const tool = byName.get('luastg_update_node')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['attributes', 'node_id', 'path'])
  assert.deepEqual(tool.parameters.required, ['attributes'])
  assert.equal(tool.parameters.properties.attributes.additionalProperties, true)
})

test('add_node uses parent/parent_id and requires node_type', { skip }, () => {
  const { byName } = register()
  const tool = byName.get('luastg_add_node')
  assert.deepEqual(
    Object.keys(tool.parameters.properties).sort(),
    ['attributes', 'index', 'node_type', 'parent', 'parent_id'],
  )
  assert.deepEqual(tool.parameters.required, ['node_type'])
  assert.equal(tool.parameters.properties.node_type.type, 'string')
  assert.equal(tool.parameters.properties.index.type, 'integer')
  assert.equal(tool.parameters.properties.template_id, undefined)
})

test('delete_node drops dry_run and exposes path/node_id', { skip }, () => {
  const { byName } = register()
  const tool = byName.get('luastg_delete_node')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['node_id', 'path'])
  assert.equal(tool.parameters.required, undefined)
  assert.equal(tool.parameters.properties.dry_run, undefined)
})

test('update_script requires script_content and accepts path/node_id', { skip }, () => {
  const { byName } = register()
  const tool = byName.get('luastg_update_script')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['node_id', 'path', 'script_content'])
  assert.deepEqual(tool.parameters.required, ['script_content'])
  assert.equal(tool.parameters.properties.script_content.type, 'string')
})

test('keeps explicit bridge settings in the resolved config', { skip }, () => {
  assert.deepEqual(plugin.Config({ host: 'localhost', port: 6553, timeoutMs: 1500, maxDepth: 3 }), {
    host: 'localhost',
    port: 6553,
    timeoutMs: 1500,
    maxDepth: 3,
  })

  const { byName } = register({ port: 6553, timeoutMs: 1500 })
  assert.ok(byName.get('luastg_get_nodes'), 'registration is lazy and does not connect')
})
