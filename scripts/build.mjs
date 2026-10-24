#!/usr/bin/env node
// Build src/*.ts into lib/*.js with Node's own type-stripping compiler.
//
// The local DSH release environment has no network access and no TypeScript
// toolchain, so the published `lib/` artifacts are produced from the TypeScript
// sources by `module.stripTypeScriptTypes` (Node >= 22.13). The sources use only
// erasable TypeScript syntax (no enums, namespaces, parameter properties, or
// decorators), which is what this mode requires.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const outDir = join(root, 'lib')

/** @param {string} dir @param {string[]} [out] */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

rmSync(outDir, { recursive: true, force: true })

const sources = walk(srcDir).sort()
for (const file of sources) {
  const target = join(outDir, relative(srcDir, file).replace(/\.ts$/, '.js'))
  const relativeSource = relative(root, file)
  const code = stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip', sourceUrl: relativeSource })
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `// Generated from ${relativeSource} by scripts/build.mjs. Do not edit.\n${code}`)
}

console.log(`built ${sources.length} file(s) into lib/`)
