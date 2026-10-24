// Generated from src\bridge-client.ts by scripts/build.mjs. Do not edit.
// TCP client for the LuaSTG Editor Sharp X MCP bridge.
//
// The bridge speaks newline-delimited JSON on 127.0.0.1:8090: one request
// object per line, one response object per line. Every tool call opens its own
// connection and closes it after the response, which keeps calls independent
// and makes timeouts and cancellation unambiguous. (The C# server also accepts
// several lines on one connection; this client deliberately does not rely on
// that.)
import { createConnection } from 'node:net'

/** Upper bound for one response line; a whole project tree still fits easily. */
const MAX_RESPONSE_CHARS = 32 * 1024 * 1024

/** Socket errors that mean "the editor bridge is not reachable". */
const UNAVAILABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
])

                                      
                                            
               
                                       
               
                                                                       
                    
 

                                                   

                                 
                                                                            
                
                
                   
                        
 

export class BridgeError extends Error {
  code        

  constructor(code        , message        ) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/** The editor is not running, the bridge is not started, or the socket dropped. */
export class BridgeUnavailableError extends BridgeError {
  endpoint        

  constructor(endpoint        , cause         ) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? 'connection failed')
    super(
      'bridge-unavailable',
      `无法连接 LuaSTG 编辑器 MCP 桥接（${endpoint}）：连接失败，请确保 LuaSTG 编辑器已启动并加载了 MCP 桥接插件。` +
        `原始错误：${detail}`,
    )
    this.name = 'BridgeUnavailableError'
    this.endpoint = endpoint
    this.cause = cause
  }
}

/** The connection succeeded but no response line arrived in time. */
export class BridgeTimeoutError extends BridgeError {
  endpoint        
  timeoutMs        

  constructor(endpoint        , timeoutMs        ) {
    super(
      'bridge-timeout',
      `LuaSTG 编辑器 MCP 桥接在 ${timeoutMs} ms 内未响应（${endpoint}）。` +
        `请确认编辑器没有卡死，或调大 luastg-mcp 配置里的 timeoutMs。`,
    )
    this.name = 'BridgeTimeoutError'
    this.endpoint = endpoint
    this.timeoutMs = timeoutMs
  }
}

/** The response was not a JSON object with a string `status`. */
export class BridgeProtocolError extends BridgeError {
  constructor(message        ) {
    super('bridge-protocol', message)
    this.name = 'BridgeProtocolError'
  }
}

/** The bridge answered with a non-ok status such as node_not_found. */
export class BridgeCommandError extends BridgeError {
  status        
  details         
  response                
  endpoint        

  constructor(response                , endpoint        ) {
    const status = response.status
    const reason =
      typeof response.error === 'string' && response.error.trim() !== ''
        ? response.error.trim()
        : `the bridge returned status "${status}"`
    const suffix = response.details === undefined ? '' : ` (details: ${describeDetails(response.details)})`
    super(status, `${status}: ${reason}${suffix}`)
    this.name = 'BridgeCommandError'
    this.status = status
    this.details = response.details
    this.response = response
    this.endpoint = endpoint
  }
}

function describeDetails(value         )         {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > 2000 ? `${text.slice(0, 2000)}...` : text
  } catch {
    return String(value)
  }
}

function describeValue(value         )         {
  if (typeof value === 'string') return `the string ${JSON.stringify(value.slice(0, 120))}`
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.slice(0, 200)
  } catch {
    return String(value)
  }
}

function abortReason(signal             )         {
  const reason = signal.reason
  if (reason instanceof Error && reason.message !== '') return reason.message
  if (typeof reason === 'string' && reason !== '') return reason
  return 'aborted'
}

function readResponse(raw         , endpoint        )                 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BridgeProtocolError(
      `the bridge at ${endpoint} returned ${describeValue(raw)} instead of a JSON object`,
    )
  }
  const record = raw                           
  if (typeof record.status !== 'string' || record.status.trim() === '') {
    throw new BridgeProtocolError(
      `the bridge at ${endpoint} returned a response without a non-empty string "status" field`,
    )
  }
  return record                  
}

function normalizePort(value         )         {
  if (value === undefined || value === null) return 8090
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new BridgeError('bridge-config', `port must be an integer between 1 and 65535 (got ${String(value)})`)
  }
  return value
}

function normalizeTimeout(value         )         {
  if (value === undefined || value === null) return 5000
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BridgeError('bridge-config', `timeoutMs must be a positive number (got ${String(value)})`)
  }
  return Math.min(60_000, Math.max(100, Math.trunc(value)))
}

function sendLine(client              , line        , signal              )                          {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new BridgeError('aborted', `request to ${client.endpoint} was aborted: ${abortReason(signal)}`))
      return
    }

    let settled = false
    let buffer = ''
    let timer                                           
    const socket = createConnection({ host: client.host, port: client.port })
    socket.setNoDelay(true)
    socket.setEncoding('utf8')

    function cleanup()       {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      signal?.removeEventListener('abort', onAbort)
      socket.removeAllListeners()
      // After removeAllListeners an error event would be unhandled; keep a sink.
      socket.on('error', () => {})
      socket.destroy()
    }

    function finish(action            )       {
      if (settled) return
      settled = true
      cleanup()
      action()
    }

    function fail(error       )       {
      finish(() => reject(error))
    }

    function onAbort()       {
      fail(new BridgeError('aborted', `request to ${client.endpoint} was aborted: ${abortReason(signal               )}`))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      fail(new BridgeTimeoutError(client.endpoint, client.timeoutMs))
    }, client.timeoutMs)

    const acceptLine = (raw        )          => {
      const text = raw.trim()
      if (text === '') return false

      let parsed         
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        fail(
          new BridgeProtocolError(
            `the bridge at ${client.endpoint} returned invalid JSON: ` +
              `${error instanceof Error ? error.message : String(error)} (first 200 chars: ${text.slice(0, 200)})`,
          ),
        )
        return true
      }

      let response                
      try {
        response = readResponse(parsed, client.endpoint)
      } catch (error) {
        fail(error instanceof Error ? error : new BridgeProtocolError(String(error)))
        return true
      }

      if (response.status !== 'ok' && response.status !== 'pong') {
        fail(new BridgeCommandError(response, client.endpoint))
        return true
      }

      finish(() => resolve(response))
      return true
    }

    socket.on('data', (chunk        ) => {
      buffer += chunk
      if (buffer.length > MAX_RESPONSE_CHARS) {
        fail(
          new BridgeProtocolError(
            `response from ${client.endpoint} exceeded ${MAX_RESPONSE_CHARS} characters; refusing to buffer it`,
          ),
        )
        return
      }

      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const raw = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (acceptLine(raw)) return
        newline = buffer.indexOf('\n')
      }
    })

    socket.once('connect', () => {
      try {
        socket.write(`${line}\n`, 'utf8')
      } catch (error) {
        fail(
          new BridgeProtocolError(
            `could not send the request to ${client.endpoint}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    })

    socket.once('error', (error       ) => {
      if (settled) return
      const code = typeof (error                      ).code === 'string' ? (error                    ).code : ''
      if (UNAVAILABLE_ERROR_CODES.has(code)) fail(new BridgeUnavailableError(client.endpoint, error))
      else fail(new BridgeProtocolError(`connection to ${client.endpoint} failed: ${error.message}`))
    })

    socket.once('close', () => {
      if (settled) return
      // Tolerate a server that answers without the trailing newline.
      if (buffer.trim() !== '' && acceptLine(buffer)) return
      if (!settled) {
        fail(new BridgeProtocolError(`the bridge at ${client.endpoint} closed the connection without answering`))
      }
    })
  })
}

/** One-shot JSON-over-TCP client for the LuaSTG editor bridge. */
export class BridgeClient {
  host        
  port        
  timeoutMs        

  constructor(options                      = {}) {
    const host = typeof options.host === 'string' ? options.host.trim() : ''
    const normalizedHost = host.toLowerCase() === 'localhost' ? '127.0.0.1' : host
    this.host = normalizedHost === '' ? '127.0.0.1' : normalizedHost
    this.port = normalizePort(options.port)
    this.timeoutMs = normalizeTimeout(options.timeoutMs)
  }

  get endpoint()         {
    return `${this.host}:${this.port}`
  }

  /**
   * Send one action and resolve with the bridge response object.
   *
   * Rejects with {@link BridgeUnavailableError}, {@link BridgeTimeoutError},
   * {@link BridgeProtocolError} or {@link BridgeCommandError}; the message of
   * every subtype is written to be shown to the model unchanged.
   */
  async request(payload               , signal              )                          {
    const action = payload.action
    if (typeof action !== 'string' || action.trim() === '') {
      throw new BridgeProtocolError('a bridge request must carry a non-empty string "action" field')
    }

    let line        
    try {
      line = JSON.stringify(payload)
    } catch (error) {
      throw new BridgeProtocolError(
        `the bridge request could not be encoded as JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return await sendLine(this, line, signal)
  }
}


//# sourceURL=src\bridge-client.ts