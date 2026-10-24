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

export interface BridgeClientOptions {
  /** Bridge host; defaults to 127.0.0.1. */
  host?: string
  /** Bridge port; defaults to 8090. */
  port?: number
  /** Connect + response deadline in milliseconds; defaults to 5000. */
  timeoutMs?: number
}

export type BridgePayload = Record<string, unknown>

export interface BridgeResponse {
  /** `ok` or `pong` on success; any other string is a bridge error code. */
  status: string
  error?: string
  details?: unknown
  [key: string]: unknown
}

export class BridgeError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/** The editor is not running, the bridge is not started, or the socket dropped. */
export class BridgeUnavailableError extends BridgeError {
  endpoint: string

  constructor(endpoint: string, cause: unknown) {
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
  endpoint: string
  timeoutMs: number

  constructor(endpoint: string, timeoutMs: number) {
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
  constructor(message: string) {
    super('bridge-protocol', message)
    this.name = 'BridgeProtocolError'
  }
}

/** The bridge answered with a non-ok status such as node_not_found. */
export class BridgeCommandError extends BridgeError {
  status: string
  details: unknown
  response: BridgeResponse
  endpoint: string

  constructor(response: BridgeResponse, endpoint: string) {
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

function describeDetails(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > 2000 ? `${text.slice(0, 2000)}...` : text
  } catch {
    return String(value)
  }
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `the string ${JSON.stringify(value.slice(0, 120))}`
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.slice(0, 200)
  } catch {
    return String(value)
  }
}

function abortReason(signal: AbortSignal): string {
  const reason = signal.reason
  if (reason instanceof Error && reason.message !== '') return reason.message
  if (typeof reason === 'string' && reason !== '') return reason
  return 'aborted'
}

function readResponse(raw: unknown, endpoint: string): BridgeResponse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BridgeProtocolError(
      `the bridge at ${endpoint} returned ${describeValue(raw)} instead of a JSON object`,
    )
  }
  const record = raw as Record<string, unknown>
  if (typeof record.status !== 'string' || record.status.trim() === '') {
    throw new BridgeProtocolError(
      `the bridge at ${endpoint} returned a response without a non-empty string "status" field`,
    )
  }
  return record as BridgeResponse
}

function normalizePort(value: unknown): number {
  if (value === undefined || value === null) return 8090
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new BridgeError('bridge-config', `port must be an integer between 1 and 65535 (got ${String(value)})`)
  }
  return value
}

function normalizeTimeout(value: unknown): number {
  if (value === undefined || value === null) return 5000
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BridgeError('bridge-config', `timeoutMs must be a positive number (got ${String(value)})`)
  }
  return Math.min(60_000, Math.max(100, Math.trunc(value)))
}

function sendLine(client: BridgeClient, line: string, signal?: AbortSignal): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new BridgeError('aborted', `request to ${client.endpoint} was aborted: ${abortReason(signal)}`))
      return
    }

    let settled = false
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const socket = createConnection({ host: client.host, port: client.port })
    socket.setNoDelay(true)
    socket.setEncoding('utf8')

    function cleanup(): void {
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

    function finish(action: () => void): void {
      if (settled) return
      settled = true
      cleanup()
      action()
    }

    function fail(error: Error): void {
      finish(() => reject(error))
    }

    function onAbort(): void {
      fail(new BridgeError('aborted', `request to ${client.endpoint} was aborted: ${abortReason(signal as AbortSignal)}`))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      fail(new BridgeTimeoutError(client.endpoint, client.timeoutMs))
    }, client.timeoutMs)

    const acceptLine = (raw: string): boolean => {
      const text = raw.trim()
      if (text === '') return false

      let parsed: unknown
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

      let response: BridgeResponse
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

    socket.on('data', (chunk: string) => {
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

    socket.once('error', (error: Error) => {
      if (settled) return
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
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
  host: string
  port: number
  timeoutMs: number

  constructor(options: BridgeClientOptions = {}) {
    const host = typeof options.host === 'string' ? options.host.trim() : ''
    const normalizedHost = host.toLowerCase() === 'localhost' ? '127.0.0.1' : host
    this.host = normalizedHost === '' ? '127.0.0.1' : normalizedHost
    this.port = normalizePort(options.port)
    this.timeoutMs = normalizeTimeout(options.timeoutMs)
  }

  get endpoint(): string {
    return `${this.host}:${this.port}`
  }

  /**
   * Send one action and resolve with the bridge response object.
   *
   * Rejects with {@link BridgeUnavailableError}, {@link BridgeTimeoutError},
   * {@link BridgeProtocolError} or {@link BridgeCommandError}; the message of
   * every subtype is written to be shown to the model unchanged.
   */
  async request(payload: BridgePayload, signal?: AbortSignal): Promise<BridgeResponse> {
    const action = payload.action
    if (typeof action !== 'string' || action.trim() === '') {
      throw new BridgeProtocolError('a bridge request must carry a non-empty string "action" field')
    }

    let line: string
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
