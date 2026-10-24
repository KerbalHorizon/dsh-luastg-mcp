// In-memory stand-in for the LuaSTGMcpBridge C# server.
//
// It speaks the same newline-delimited JSON protocol as TcpBridgeServer and
// keeps a small node tree with the same response shapes, positional paths and
// error statuses as TreeActions. The plugin tests use it both as a transport
// fixture and to exercise path shifts after insert/delete.
import { createServer } from 'node:net'

function attribute(name, value) {
  return { name, value, editWindow: '' }
}

function node(type, text, attributes = [], children = []) {
  return {
    type,
    typeFullName: `Mock.${type}`,
    text,
    attributes,
    children,
    banned: false,
    expanded: true,
    selected: false,
  }
}

/** A tree wide enough to show re-indexing: root -> group -> stage -> tasks. */
export function createMockDocument() {
  return {
    name: 'MockStage',
    path: 'D:\\mock\\MockStage.lstges',
    extension: '.lstges',
    dirty: false,
    root: node('RootFolder', 'MockStage', [attribute('Name', 'MockStage'), attribute('Comment', 'mock root')], [
      node('StageGroup', 'Group A', [attribute('Name', 'Group A')], [
        node('Stage', 'Stage 1', [attribute('Name', 'Stage 1')], [
          node('TaskWait', 'wait 30', [attribute('Time', '30')]),
          node('TaskWait', 'wait 60', [attribute('Time', '60')]),
        ]),
      ]),
      node('Stage', 'Stage 2', [attribute('Name', 'Stage 2')], [
        node('Comment', 'note', [attribute('Comment', 'note'), attribute('Code', 'print("old")')]),
      ]),
    ]),
  }
}

function failure(status, error, details) {
  const response = { status, error }
  if (details !== undefined) response.details = details
  return response
}

function parsePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return [0]
  const text = value.trim()
  if (!/^\d+(?:\/\d+)*$/.test(text)) return null
  return text.split('/').map(Number)
}

function resolveNode(document, rawPath) {
  const indexes = parsePath(rawPath)
  const requested = typeof rawPath === 'string' && rawPath.trim() !== '' ? rawPath.trim() : '0'
  if (indexes === null) return { error: `invalid path '${requested}'; a path looks like '0/2/1'` }
  if (indexes[0] !== 0) return { error: `no root node at index ${indexes[0]}; the document has 1 root node` }

  let current = document.root
  const chain = [current]
  for (let depth = 1; depth < indexes.length; depth += 1) {
    const index = indexes[depth]
    const children = Array.isArray(current.children) ? current.children : []
    if (index >= children.length) {
      const parentPath = indexes.slice(0, depth).join('/')
      return {
        error: `no child at index ${index} under '${parentPath}'; that node has ${children.length} child(ren)`,
      }
    }
    current = children[index]
    chain.push(current)
  }
  return { node: current, indexes, chain, path: indexes.join('/') }
}

function countNodes(value) {
  if (!value) return 0
  let total = 1
  for (const child of value.children ?? []) total += countNodes(child)
  return total
}

function documentSummary(document) {
  return {
    name: document.name,
    path: document.path,
    extension: document.extension,
    dirty: document.dirty === true,
    nodeCount: countNodes(document.root),
  }
}

function captureNode(value, path, depth, maxDepth, includeAttributes) {
  const children = Array.isArray(value.children) ? value.children : []
  const result = {
    path,
    type: value.type,
    typeFullName: value.typeFullName,
    text: value.text,
    banned: value.banned === true,
    expanded: value.expanded !== false,
    selected: value.selected === true,
    canDelete: path !== '0',
    attributeCount: (value.attributes ?? []).length,
    childCount: children.length,
    children: [],
  }
  if (includeAttributes) {
    result.attributes = (value.attributes ?? []).map((item) => ({
      name: item.name,
      value: item.value,
      editWindow: item.editWindow ?? '',
    }))
  }

  const truncated = maxDepth !== 0 && depth >= maxDepth
  if (!truncated) {
    children.forEach((child, index) => {
      result.children.push(captureNode(child, `${path}/${index}`, depth + 1, maxDepth, includeAttributes))
    })
  } else if (children.length > 0) {
    result.truncated = true
  }
  return result
}

function findAttribute(value, name) {
  const attributes = value.attributes ?? []
  return (
    attributes.find((item) => item.name === name) ??
    attributes.find((item) => item.name.toLowerCase() === name.toLowerCase()) ??
    null
  )
}

function refreshText(value) {
  if (value.type === 'Comment') {
    const comment = findAttribute(value, 'Comment')
    if (comment) value.text = comment.value
    return
  }
  if (value.type === 'TaskWait') {
    const time = findAttribute(value, 'Time')
    if (time) value.text = `wait ${time.value}`
    return
  }
  if (value.type === 'Stage' || value.type === 'StageGroup' || value.type === 'RootFolder') {
    const name = findAttribute(value, 'Name')
    if (name) value.text = name.value
  }
}

function getTree(request, document) {
  const requestedPath = typeof request.path === 'string' && request.path.trim() !== '' ? request.path.trim() : '0'
  const found = resolveNode(document, requestedPath)
  if (found.error) return failure('node_not_found', found.error, { path: requestedPath })

  const maxDepth = Number.isInteger(request.maxDepth) && request.maxDepth > 0 ? request.maxDepth : 0
  const includeAttributes = request.attributes !== false
  return {
    status: 'ok',
    document: documentSummary(document),
    tree: captureNode(found.node, found.path, 0, maxDepth, includeAttributes),
  }
}

function insertNode(request, document) {
  const requestedType = typeof request.type === 'string' ? request.type.trim() : ''
  if (requestedType === '') return failure('bad_request', "'type' is required, for example \"Comment\"")
  const simpleName = requestedType.includes('.')
    ? requestedType.slice(requestedType.lastIndexOf('.') + 1)
    : requestedType
  const known = ['Comment', 'TaskWait', 'Folder', 'Stage', 'StageGroup']
  if (!known.includes(simpleName)) {
    return failure('unknown_node_type', `unknown node type '${requestedType}'`, {
      suggestions: known.filter((name) => name.toLowerCase().includes(simpleName.toLowerCase())),
    })
  }

  const requestedParent = typeof request.parent === 'string' && request.parent.trim() !== '' ? request.parent.trim() : '0'
  const found = resolveNode(document, requestedParent)
  if (found.error) return failure('node_not_found', found.error, { path: requestedParent })

  const children = found.node.children
  const childCount = children.length
  const index = request.index === undefined || request.index === null ? childCount : request.index
  if (!Number.isInteger(index) || index < 0 || index > childCount) {
    return failure('index_out_of_range', `index ${index} is out of range 0..${childCount}`, {
      path: found.path,
      childCount,
    })
  }

  const attributes = []
  if (request.attributes && typeof request.attributes === 'object' && !Array.isArray(request.attributes)) {
    for (const [name, value] of Object.entries(request.attributes)) {
      attributes.push(attribute(name, value === null ? '' : String(value)))
    }
  }

  const created = node(simpleName, simpleName, attributes, [])
  if (requestedType !== simpleName) created.typeFullName = requestedType
  refreshText(created)
  children.splice(index, 0, created)
  document.dirty = true

  return {
    status: 'ok',
    path: `${found.path}/${index}`,
    type: simpleName,
    typeFullName: created.typeFullName,
    text: created.text,
    parentPath: found.path,
    index,
    selected: true,
    nodeCount: countNodes(document.root),
  }
}

function setAttribute(request, document) {
  const requestedPath = typeof request.path === 'string' ? request.path : ''
  const found = resolveNode(document, requestedPath)
  if (found.error) return failure('node_not_found', found.error, { path: requestedPath })

  const name = typeof request.name === 'string' ? request.name : ''
  if (name.trim() === '') return failure('bad_request', "'name' is required, for example \"Comment\"")
  if (!Object.prototype.hasOwnProperty.call(request, 'value')) {
    return failure('bad_request', "'value' is required")
  }

  const target = findAttribute(found.node, name)
  if (!target) {
    return failure(
      'unknown_attribute',
      `node '${found.path}' (${found.node.type}) has no attribute '${name}'`,
      {
        path: found.path,
        nodeType: found.node.type,
        availableAttributes: (found.node.attributes ?? []).map((item) => item.name),
      },
    )
  }

  const oldValue = target.value ?? ''
  const newValue = request.value === null ? '' : String(request.value)
  const changed = oldValue !== newValue
  if (changed) {
    target.value = newValue
    document.dirty = true
    refreshText(found.node)
  }

  return {
    status: 'ok',
    path: found.path,
    name: target.name,
    oldValue,
    newValue,
    changed,
    text: found.node.text,
  }
}

function deleteNode(request, document) {
  const requestedPath = typeof request.path === 'string' ? request.path : ''
  const found = resolveNode(document, requestedPath)
  if (found.error) return failure('node_not_found', found.error, { path: requestedPath })
  if (found.indexes.length === 1) {
    return failure('cannot_delete', 'the root node cannot be deleted', { path: found.path })
  }

  const parent = found.chain[found.chain.length - 2]
  const index = found.indexes[found.indexes.length - 1]
  const removed = found.node
  parent.children.splice(index, 1)
  document.dirty = true

  return {
    status: 'ok',
    path: found.path,
    type: removed.type,
    text: removed.text,
    parentPath: found.indexes.slice(0, -1).join('/'),
    index,
    nodeCount: countNodes(document.root),
  }
}

function handleRequest(request, document) {
  if (document === null) return failure('no_document', 'no document is open')
  switch (request.action) {
    case 'ping':
      return { status: 'pong', editor: 'connected' }
    case 'get_tree':
      return getTree(request, document)
    case 'insert_node':
      return insertNode(request, document)
    case 'set_attribute':
      return setAttribute(request, document)
    case 'delete_node':
      return deleteNode(request, document)
    default:
      return failure('unknown_action', `unknown action '${request.action}'`)
  }
}

/**
 * Start the mock bridge.
 *
 * @param {{ port?: number, document?: object | null }} [options]
 * @returns {Promise<{ port: number, endpoint: string, requests: object[], document: object | null, server: import('node:net').Server, close(): Promise<void> }>}
 */
export async function startMockBridge(options = {}) {
  const document = options.document === undefined ? createMockDocument() : options.document
  const requests = []
  const sockets = new Set()

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
          let request
          try {
            request = JSON.parse(line)
          } catch {
            socket.write(`${JSON.stringify(failure('bad_request', 'invalid JSON'))}\n`)
            newline = buffer.indexOf('\n')
            continue
          }
          requests.push(request)
          socket.write(`${JSON.stringify(handleRequest(request, document))}\n`)
        }

        newline = buffer.indexOf('\n')
      }
    })
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port ?? 0, '127.0.0.1')
  })

  const address = server.address()
  return {
    port: address.port,
    endpoint: `127.0.0.1:${address.port}`,
    requests,
    document,
    server,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
