// Attribute maps sent to the LuaSTG editor bridge.
//
// The bridge accepts a JSON object for insert_node.attributes and one
// name/value pair per set_attribute call. Values are always strings in the
// editor, so numbers and booleans are stringified here; anything else is
// rejected before it reaches the wire.

export interface AttributeOptions {
  /** Require at least one attribute (used by update_node). */
  required?: boolean
  /** Label used in error messages, `attributes` by default. */
  label?: string
}

/** Validate and normalize an attribute map. */
export function normalizeAttributeValues(raw: unknown, options: AttributeOptions = {}): Record<string, string> {
  const label = options.label ?? 'attributes'

  if (raw === undefined || raw === null) {
    if (options.required === true) {
      throw new Error(`${label} is required and must be a JSON object mapping attribute names to values`)
    }
    return {}
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object mapping attribute names to string, number, or boolean values`)
  }

  const entries = Object.entries(raw as Record<string, unknown>)
  if (options.required === true && entries.length === 0) {
    throw new Error(`${label} must contain at least one attribute to change`)
  }

  const normalized: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (key.trim() === '') throw new Error(`${label} contains an empty attribute name`)
    if (typeof value === 'string') normalized[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) normalized[key] = String(value)
    else if (typeof value === 'boolean') normalized[key] = String(value)
    else {
      throw new Error(
        `${label}.${key} must be a string, number, or boolean; the editor stores every attribute as text`,
      )
    }
  }
  return normalized
}
