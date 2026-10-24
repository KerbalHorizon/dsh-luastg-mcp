import assert from 'node:assert/strict'
import test from 'node:test'

import { NodePathError, normalizeNodePath, resolveNodeReference } from '../lib/node-path.js'

test('normalizes slash paths to the bridge form', () => {
  assert.equal(normalizeNodePath('0'), '0')
  assert.equal(normalizeNodePath('0/4/2'), '0/4/2')
  assert.equal(normalizeNodePath(' 0 / 04 / 002 '), '0/4/2')
  assert.equal(normalizeNodePath('0/0/0'), '0/0/0')
})

test('normalizes legacy dot-separated node ids', () => {
  assert.equal(normalizeNodePath('0.4.2'), '0/4/2')
  assert.equal(normalizeNodePath('0.0'), '0/0')
  assert.equal(normalizeNodePath('0.04.002'), '0/4/2')
})

test('accepts mixed separators for a paste from an old tool result', () => {
  assert.equal(normalizeNodePath('0.4/2'), '0/4/2')
  assert.equal(normalizeNodePath('0/4.2'), '0/4/2')
})

test('rejects malformed paths before they reach the bridge', () => {
  for (const value of ['', '/', '0/', '/0', '0//1', '0..1', '0/-1', '0/a', 'a/0', '0/1/']) {
    assert.throws(
      () => normalizeNodePath(value),
      (error) => error instanceof NodePathError && error.code === 'invalid-path',
      `expected ${JSON.stringify(value)} to be rejected`,
    )
  }
})

test('rejects absurdly large or deep paths', () => {
  assert.throws(() => normalizeNodePath('0/2147483648'), /largest supported index/)
  assert.throws(() => normalizeNodePath('0/99999999999999999999'), /too large/)
  assert.throws(() => normalizeNodePath(Array.from({ length: 257 }, () => '0').join('/')), /too deep/)
})

test('resolves the canonical path argument', () => {
  const reference = resolveNodeReference({ path: '0.4.2' })
  assert.deepEqual(reference, { path: '0/4/2', source: 'path' })
})

test('resolves the deprecated node_id alias', () => {
  const reference = resolveNodeReference({ node_id: '0.4.2' })
  assert.deepEqual(reference, { path: '0/4/2', source: 'node_id' })
})

test('accepts path and node_id when they address the same node', () => {
  const reference = resolveNodeReference({ path: '0/4/2', node_id: '0.4.2' })
  assert.deepEqual(reference, { path: '0/4/2', source: 'path' })
})

test('rejects path and node_id that disagree', () => {
  assert.throws(
    () => resolveNodeReference({ path: '0/4/2', node_id: '0.4.3' }),
    (error) => error instanceof NodePathError && error.code === 'conflicting-node-reference',
  )
})

test('applies the default path only when no reference was given', () => {
  assert.deepEqual(resolveNodeReference({}, { defaultPath: '0' }), { path: '0', source: 'default' })
  assert.deepEqual(resolveNodeReference({ path: '0/1' }, { defaultPath: '0' }), {
    path: '0/1',
    source: 'path',
  })
})

test('requires a reference when there is no default', () => {
  assert.throws(
    () => resolveNodeReference({}),
    (error) => error instanceof NodePathError && error.code === 'path-required' && /node_id/.test(error.message),
  )
})

test('supports custom argument names for parent/parent_id', () => {
  assert.deepEqual(resolveNodeReference({ parent_id: '0.4' }, { pathKey: 'parent', legacyKey: 'parent_id' }), {
    path: '0/4',
    source: 'node_id',
  })
  assert.deepEqual(
    resolveNodeReference({}, { pathKey: 'parent', legacyKey: 'parent_id', defaultPath: '0' }),
    { path: '0', source: 'default' },
  )
})

test('rejects a non-string reference', () => {
  assert.throws(() => resolveNodeReference({ path: 4 }), /path must be a string/)
})
