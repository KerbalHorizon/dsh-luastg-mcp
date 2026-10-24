// Generated from src\node-path.ts by scripts/build.mjs. Do not edit.
// Node addressing for the LuaSTG editor bridge.
//
// The bridge addresses nodes by position: "0" is the document root and
// "0/2/1" is the third child of the second child of the root. The pre-1.0
// file tools used dot-separated ids ("0.2.1"); both spellings are accepted
// here and normalized to the bridge's slash form, so an old id can be pasted
// into the new `path` argument unchanged.

const MAX_SEGMENTS = 256
const MAX_SEGMENT = 2_147_483_647

export class NodePathError extends Error {
  code        

  constructor(code        , message        ) {
    super(message)
    this.name = 'NodePathError'
    this.code = code
  }
}

/**
 * Normalize one node path to the bridge's canonical `0/2/1` form.
 *
 * Slash and dot separators are both accepted, whitespace around segments is
 * ignored, and leading zeros are removed. Empty segments, negative numbers,
 * non-numeric segments and absurdly large indexes are rejected before a
 * request reaches the editor.
 */
export function normalizeNodePath(value        , label = 'path')         {
  const source = value.trim()
  if (source === '') {
    throw new NodePathError('invalid-path', `${label} must be a non-empty path such as "0" or "0/2/1"`)
  }

  const rawSegments = source.split(/[/.]/)
  if (rawSegments.length > MAX_SEGMENTS) {
    throw new NodePathError(
      'invalid-path',
      `${label} "${value}" is too deep (${rawSegments.length} segments; the maximum is ${MAX_SEGMENTS})`,
    )
  }

  const segments           = []
  for (const raw of rawSegments) {
    const segment = raw.trim()
    if (segment === '') {
      throw new NodePathError(
        'invalid-path',
        `${label} "${value}" contains an empty segment; use single separators, for example "0/2/1"`,
      )
    }
    if (!/^\d+$/.test(segment)) {
      throw new NodePathError(
        'invalid-path',
        `${label} "${value}" has invalid segment "${segment}"; every segment must be a non-negative integer`,
      )
    }
    if (segment.length > 10) {
      throw new NodePathError('invalid-path', `${label} "${value}" has a segment that is too large`)
    }
    const index = Number(segment)
    if (!Number.isSafeInteger(index) || index > MAX_SEGMENT) {
      throw new NodePathError(
        'invalid-path',
        `${label} "${value}" has segment ${segment}; the largest supported index is ${MAX_SEGMENT}`,
      )
    }
    segments.push(String(index))
  }

  return segments.join('/')
}

function readOptionalPath(value         , label        )                {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new NodePathError('invalid-path', `${label} must be a string such as "0" or "0/4/2"`)
  }
  if (value.trim() === '') return null
  return normalizeNodePath(value, label)
}

                                       
                                                           
                  
                                                            
                    
                                                         
                      
 

                                                                

                                
                               
              
                                                                      
                             
 

/**
 * Resolve the node reference of one tool call.
 *
 * Both `path` and the legacy `node_id` are accepted; when both are present they
 * must normalize to the same node. With no argument the optional
 * `defaultPath` applies (root for `get_nodes` and `add_node`); otherwise the
 * call fails before any TCP traffic.
 */
export function resolveNodeReference(
  args                         ,
  options                       = {},
)                {
  const pathKey = options.pathKey ?? 'path'
  const legacyKey = options.legacyKey ?? 'node_id'
  const pathValue = readOptionalPath(args[pathKey], pathKey)
  const legacyValue = readOptionalPath(args[legacyKey], legacyKey)

  if (pathValue !== null && legacyValue !== null) {
    if (pathValue !== legacyValue) {
      throw new NodePathError(
        'conflicting-node-reference',
        `${pathKey} "${pathValue}" and ${legacyKey} "${legacyValue}" point at different nodes; pass only one of them`,
      )
    }
    return { path: pathValue, source: 'path' }
  }
  if (pathValue !== null) return { path: pathValue, source: 'path' }
  if (legacyValue !== null) return { path: legacyValue, source: 'node_id' }

  if (options.defaultPath !== undefined) {
    return { path: normalizeNodePath(options.defaultPath, 'default path'), source: 'default' }
  }

  throw new NodePathError(
    'path-required',
    `${pathKey} is required (for example "0" for the document root or "0/4/2" for a child); ` +
      `the legacy ${legacyKey} ("0.4.2") is also accepted`,
  )
}


//# sourceURL=src\node-path.ts