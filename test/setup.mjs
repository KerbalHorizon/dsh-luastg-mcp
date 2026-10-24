// Loaded with `--import` before the test files. Locates the two DSH runtime
// packages and, when they come from a globally installed DSH release, registers
// the resolve hook that maps the bare specifiers onto it. Without either source
// the plugin smoke test skips itself.
//
// Resolution order:
//   1. DSH_PACKAGES, when the caller pins a location explicitly;
//   2. the repo's own node_modules (CI installs the devDependencies there) —
//      no hook needed, plain node resolution walks up from lib/index.js;
//   3. a globally installed DSH release (local Windows development boxes) —
//      that layout is not on the module path, so the hook maps it in place.
import { existsSync } from 'node:fs'
import { register } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function hasDshTools(dir) {
  return existsSync(join(dir, 'dsh-tools', 'package.json'))
}

function detectPackages() {
  if (typeof process.env.DSH_PACKAGES === 'string' && process.env.DSH_PACKAGES !== '') {
    const pinned = process.env.DSH_PACKAGES
    return { root: pinned, needsHook: !pinned.startsWith(join(repositoryRoot, 'node_modules')) }
  }

  const local = join(repositoryRoot, 'node_modules', '@deepseek-ai')
  if (hasDshTools(local)) return { root: local, needsHook: false }

  const appData = process.env.APPDATA
  if (typeof appData !== 'string' || appData === '') return null
  const candidate = join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
  return hasDshTools(candidate) ? { root: candidate, needsHook: true } : null
}

const detected = detectPackages()
if (detected !== null) {
  process.env.DSH_PACKAGES = detected.root
  if (detected.needsHook) register('./dsh-resolver.mjs', import.meta.url)
}
