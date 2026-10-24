// Minimal newline-delimited JSON TCP server for transport tests.
import { createServer } from 'node:net'

/**
 * @param {(socket: import('node:net').Socket, line: string) => void} [onRequest]
 */
export async function startRawBridge(onRequest = () => {}) {
  const sockets = new Set()
  const requests = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setEncoding('utf8')

    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== '') {
          requests.push(line)
          onRequest(socket, line)
        }
        newline = buffer.indexOf('\n')
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  return {
    port: server.address().port,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
