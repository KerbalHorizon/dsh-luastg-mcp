import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BridgeClient,
  BridgeCommandError,
  BridgeProtocolError,
  BridgeTimeoutError,
  BridgeUnavailableError,
} from '../lib/bridge-client.js'
import { startRawBridge } from './raw-bridge.mjs'

test('sends exactly one newline-delimited JSON request', async (t) => {
  const bridge = await startRawBridge((socket, line) => {
    const request = JSON.parse(line)
    socket.write(`${JSON.stringify({ status: 'ok', echo: request })}\n`)
  })
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 2000 })
  const response = await client.request({ action: 'ping', text: 'a\nb' })

  assert.equal(bridge.requests.length, 1)
  assert.equal(bridge.requests[0].includes('\n'), false, 'the request must be one physical line')
  assert.deepEqual(JSON.parse(bridge.requests[0]), { action: 'ping', text: 'a\nb' })
  assert.deepEqual(response, { status: 'ok', echo: { action: 'ping', text: 'a\nb' } })
})

test('accepts pong as a successful status', async (t) => {
  const bridge = await startRawBridge((socket) => {
    socket.write(`${JSON.stringify({ status: 'pong', editor: 'connected' })}\n`)
  })
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 2000 })
  const response = await client.request({ action: 'ping' })
  assert.equal(response.status, 'pong')
  assert.equal(response.editor, 'connected')
})

test('reassembles a response split across TCP chunks', async (t) => {
  const bridge = await startRawBridge((socket) => {
    const payload = JSON.stringify({ status: 'ok', value: 42, note: 'split' })
    socket.write(payload.slice(0, 7))
    setTimeout(() => socket.write(`${payload.slice(7)}\n`), 15)
  })
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 2000 })
  const response = await client.request({ action: 'ping' })
  assert.equal(response.value, 42)
  assert.equal(response.note, 'split')
})

test('tolerates CRLF and a missing trailing newline', async (t) => {
  let call = 0
  const bridge = await startRawBridge((socket) => {
    call += 1
    if (call === 1) socket.write(`${JSON.stringify({ status: 'ok', n: 1 })}\r\n`)
    else {
      socket.write(JSON.stringify({ status: 'ok', n: 2 }))
      socket.end()
    }
  })
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 2000 })
  assert.equal((await client.request({ action: 'ping' })).n, 1)
  assert.equal((await client.request({ action: 'ping' })).n, 2)
})

test('turns a non-ok bridge status into a BridgeCommandError with details', async (t) => {
  const bridge = await startRawBridge((socket) => {
    socket.write(
      `${JSON.stringify({
        status: 'node_not_found',
        error: 'no child at index 9',
        details: { path: '0/9' },
      })}\n`,
    )
  })
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 2000 })
  await assert.rejects(
    client.request({ action: 'get_tree', path: '0/9' }),
    (error) => {
      assert.ok(error instanceof BridgeCommandError)
      assert.equal(error.status, 'node_not_found')
      assert.match(error.message, /node_not_found: no child at index 9/)
      assert.match(error.message, /"path":"0\/9"/)
      return true
    },
  )
})

test('reports invalid JSON from the bridge as a protocol error', async (t) => {
  const bridge = await startRawBridge((socket) => socket.write('{not json}\n'))
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 2000 })
  await assert.rejects(client.request({ action: 'ping' }), (error) => {
    assert.ok(error instanceof BridgeProtocolError)
    assert.match(error.message, /invalid JSON/)
    return true
  })
})

test('rejects a response that is not a JSON object', async (t) => {
  const bridge = await startRawBridge((socket) => socket.write('[1,2,3]\n'))
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 2000 })
  await assert.rejects(client.request({ action: 'ping' }), (error) => {
    assert.ok(error instanceof BridgeProtocolError)
    assert.match(error.message, /instead of a JSON object/)
    return true
  })
})

test('rejects a response without a status field', async (t) => {
  const bridge = await startRawBridge((socket) => socket.write('{"ok":true}\n'))
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 2000 })
  await assert.rejects(client.request({ action: 'ping' }), /without a non-empty string "status"/)
})

test('explains a refused connection in Chinese and names the endpoint', async (t) => {
  const bridge = await startRawBridge()
  const port = bridge.port
  await bridge.close()

  const client = new BridgeClient({ port, timeoutMs: 2000 })
  await assert.rejects(client.request({ action: 'ping' }), (error) => {
    assert.ok(error instanceof BridgeUnavailableError)
    assert.match(error.message, /^无法连接 LuaSTG 编辑器 MCP 桥接（127\.0\.0\.1:\d+）/)
    assert.match(error.message, /连接失败，请确保 LuaSTG 编辑器已启动并加载了 MCP 桥接插件/)
    assert.ok(error.message.includes(`127.0.0.1:${port}`))
    return true
  })
  t.diagnostic(`refused port ${port}`)
})

test('times out when the bridge accepts but never answers', async (t) => {
  const bridge = await startRawBridge()
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 120 })
  const startedAt = Date.now()
  await assert.rejects(client.request({ action: 'ping' }), (error) => {
    assert.ok(error instanceof BridgeTimeoutError)
    assert.match(error.message, /未响应/)
    assert.match(error.message, /timeoutMs/)
    return true
  })
  assert.ok(Date.now() - startedAt >= 100, 'the timeout must actually wait for the deadline')
})

test('honours AbortSignal and destroys the socket', async (t) => {
  const bridge = await startRawBridge()
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 5000 })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('test abort')), 30)
  t.after(() => clearTimeout(timer))

  await assert.rejects(client.request({ action: 'ping' }, controller.signal), (error) => {
    assert.equal(error.code, 'aborted')
    assert.match(error.message, /test abort/)
    return true
  })
})

test('reports a bridge that closes without answering', async (t) => {
  const bridge = await startRawBridge((socket) => socket.end())
  t.after(() => bridge.close())

  const client = new BridgeClient({ port: bridge.port, timeoutMs: 2000 })
  await assert.rejects(client.request({ action: 'ping' }), /closed the connection without answering/)
})

test('requires a non-empty action before connecting', async () => {
  const client = new BridgeClient({ port: 1, timeoutMs: 100 })
  await assert.rejects(client.request({}), /non-empty string "action"/)
  await assert.rejects(client.request({ action: '   ' }), /non-empty string "action"/)
})
