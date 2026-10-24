#!/usr/bin/env node
// Start the in-memory mock bridge for manual tests, including the PowerShell
// CRUD script:
//
//   node scripts/dev/serve-mock.mjs 8090
//   powershell -NoProfile -ExecutionPolicy Bypass -File ...\mcp-crud-test.ps1 -NoPause
//
// The mock has no relation to the real editor; it only speaks the same wire
// protocol and simulates path re-indexing.
import { startMockBridge } from '../../test/mock-bridge.mjs'

const port = Number(process.argv[2] ?? 8090)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`usage: node scripts/dev/serve-mock.mjs [port] (got ${process.argv[2] ?? ''})`)
  process.exit(2)
}

const bridge = await startMockBridge({ port })
console.log(`mock LuaSTG bridge listening on ${bridge.endpoint}`)
console.log(`document: ${bridge.document.name} (${bridge.document.root.children.length} top-level nodes)`)

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  console.log(`\n${signal}: closing mock bridge`)
  await bridge.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
