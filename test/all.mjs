// Single-process entry point for `npm test`.
//
// The repo used to rely on `node --test --test-isolation=none`, but that flag
// only exists on Node >= 23 while CI pins Node 22. Loading every test file into
// one process gets the same result on both versions and, unlike the default
// process-per-file isolation, needs no child processes (which the Windows
// sandbox refuses with `spawn EPERM`).
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const scripts = readdirSync(testDirectory)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => name !== 'all.mjs')
  .sort()

if (scripts.length === 0) {
  console.error('no test files found in test/')
  process.exit(1)
}

for (const script of scripts) {
  await import(pathToFileURL(join(testDirectory, script)).href)
}
