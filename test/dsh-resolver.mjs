// Test-only resolve hook: the plugin imports two bare packages that a real DSH
// installation provides through its runtime resolution table. Local tests run
// outside that table, so map those two specifiers onto the installed DSH
// packages. Their own transitive imports resolve natively from that location.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ENTRIES = new Map([
  ['@deepseek-ai/dsh-tools', 'lib/index.js'],
  ['@deepseek-ai/schemastery', 'lib/index.mjs'],
])

export async function resolve(specifier, context, nextResolve) {
  const entry = ENTRIES.get(specifier)
  const root = process.env.DSH_PACKAGES
  if (entry === undefined || typeof root !== 'string' || root === '') {
    return nextResolve(specifier, context)
  }
  const packageName = specifier.slice('@deepseek-ai/'.length)
  return { url: pathToFileURL(join(root, packageName, entry)).href, shortCircuit: true }
}
