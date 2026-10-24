#!/usr/bin/env node
// Structural check for the built plugin: exports, Cordis injection, and the
// exact tool definitions the DSH registry receives. Run with the local DSH
// packages mapped in (see package.json "check").
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)

assert.equal(plugin.name, 'luastg-mcp', 'plugin export name')
assert.ok(Array.isArray(plugin.inject), 'inject must be an array')
assert.ok(plugin.inject.includes('tools'), 'inject must include tools')
assert.equal(typeof plugin.apply, 'function', 'apply must be exported')
assert.equal(typeof plugin.Config, 'function', 'Config must be exported')

const registered = []
plugin.apply({ tools: { register: (definition) => registered.push(definition) } }, {})
assert.equal(registered.length, 5, 'exactly five tools must register')

const byName = new Map(registered.map((definition) => [definition.name, definition]))
assert.deepEqual(
  [...byName.keys()].sort(),
  [
    'luastg_add_node',
    'luastg_delete_node',
    'luastg_get_nodes',
    'luastg_update_node',
    'luastg_update_script',
  ],
)

for (const [name, definition] of byName) {
  assert.equal(typeof definition.description, 'string', `${name}: description`)
  assert.ok(definition.description.length > 40, `${name}: description is informative`)
  assert.equal(definition.parameters?.type, 'object', `${name}: parameters root object`)
  assert.equal(typeof definition.execute, 'function', `${name}: execute`)
  assert.equal(typeof definition.output?.render, 'function', `${name}: output.render`)
  assert.equal(typeof definition.output?.schema, 'object', `${name}: output.schema`)
  assert.ok(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0, `${name}: timeoutMs`)
}

const readTool = byName.get('luastg_get_nodes')
assert.deepEqual(
  Object.keys(readTool.parameters.properties).sort(),
  ['attributes', 'maxDepth', 'node_id', 'path'],
  'read tool exposes path, node_id, maxDepth, attributes',
)
assert.equal(readTool.parameters.required, undefined, 'read tool has no statically required arguments')
assert.equal(readTool.parameters.properties.maxDepth.type, 'integer', 'read maxDepth is an integer')
assert.equal(readTool.parameters.properties.attributes.type, 'boolean', 'read attributes is a boolean')

const updateTool = byName.get('luastg_update_node')
assert.deepEqual(
  Object.keys(updateTool.parameters.properties).sort(),
  ['attributes', 'node_id', 'path'],
  'update tool exposes path, node_id, attributes',
)
assert.deepEqual(updateTool.parameters.required, ['attributes'], 'update tool requires attributes')
assert.equal(updateTool.parameters.properties.attributes.additionalProperties, true, 'update attributes are open')

const addTool = byName.get('luastg_add_node')
assert.deepEqual(
  Object.keys(addTool.parameters.properties).sort(),
  ['attributes', 'index', 'node_type', 'parent', 'parent_id'],
  'add tool exposes parent, parent_id, node_type, attributes, index',
)
assert.deepEqual(addTool.parameters.required, ['node_type'], 'add tool requires node_type')
assert.equal(addTool.parameters.properties.attributes.additionalProperties, true, 'add attributes are open')
assert.equal(addTool.parameters.properties.index.type, 'integer', 'add index is an integer')

const deleteTool = byName.get('luastg_delete_node')
assert.deepEqual(
  Object.keys(deleteTool.parameters.properties).sort(),
  ['node_id', 'path'],
  'delete tool exposes path and node_id',
)
assert.equal(deleteTool.parameters.required, undefined, 'delete tool has no statically required arguments')

const scriptTool = byName.get('luastg_update_script')
assert.deepEqual(
  Object.keys(scriptTool.parameters.properties).sort(),
  ['node_id', 'path', 'script_content'],
  'script tool exposes path, node_id, script_content',
)
assert.deepEqual(scriptTool.parameters.required, ['script_content'], 'script tool requires script_content')

assert.equal(byName.has('luastg_search_nodes'), false, 'search tool is removed')
assert.equal(byName.has('luastg_batch_update'), false, 'batch tool is removed')

console.log(
  `check ok: ${plugin.name} exports name/inject/Config/apply; ` +
    `${registered.length} tools registered (${[...byName.keys()].join(', ')})`,
)
