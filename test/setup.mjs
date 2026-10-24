// Loaded with `--import` before the test files. Registers the resolve hook that
// maps the two DSH runtime packages onto an installed DSH release when one can
// be found; without one, the plugin smoke test skips itself.
import { existsSync } from 'node:fs'
import { register } from 'node:module'
import { join } from 'node:path'

function detectPackagesRoot() {
  if (typeof process.env.DSH_PACKAGES === 'string' && process.env.DSH_PACKAGES !== '') return process.env.DSH_PACKAGES
  const appData = process.env.APPDATA
  if (typeof appData !== 'string' || appData === '') return null
  const candidate = join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
  return existsSync(join(candidate, 'dsh-tools', 'package.json')) ? candidate : null
}

const root = detectPackagesRoot()
if (root !== null) {
  process.env.DSH_PACKAGES = root
  register('./dsh-resolver.mjs', import.meta.url)
}
