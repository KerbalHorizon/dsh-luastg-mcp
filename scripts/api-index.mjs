#!/usr/bin/env node
/**
 * api-index.mjs
 *
 * Parses docs/_raw_api_temp.md (the merged LuaLS-dialect corpus produced by
 * extract-docs.mjs) and emits a compact, greppable index of:
 *   - global/table functions with params + one-line description
 *   - ---@class declarations with their ---@field members
 *
 * Output: docs/_api_index.md  (+ a short console summary)
 *
 * Usage: node scripts/api-index.mjs [--src <file>] [--out <file>]
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const SRC = path.resolve(ROOT, argOf('--src') ?? 'docs/_raw_api_temp.md');
const OUT = path.resolve(ROOT, argOf('--out') ?? 'docs/_api_index.md');

/** Collapse whitespace and strip trailing punctuation noise. */
const oneLine = (s) => (s || '').replace(/\s+/g, ' ').trim();

function parseFileSection(chunk) {
  const lines = chunk.split('\n');
  const sections = { functions: [], classes: [] };

  // Per-file accumulators
  let pendingDesc = [];
  let pendingParams = [];
  let pendingReturns = [];
  let pendingVararg = null;
  let pendingDeprecated = false;

  const flush = () => {
    pendingDesc = [];
    pendingParams = [];
    pendingReturns = [];
    pendingVararg = null;
    pendingDeprecated = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // ---@param name type @description
    let m = line.match(/^---@param\s+(\w+)\s+([\w.]+)\s*(?:@\s*(.*))?$/);
    if (m) {
      pendingParams.push({ name: m[1], type: m[2], desc: oneLine(m[3]) });
      continue;
    }
    m = line.match(/^---@vararg\s+([\w.]+)/);
    if (m) {
      pendingVararg = m[1];
      continue;
    }
    m = line.match(/^---@return\s+([\w.]+)\s*(?:@\s*(.*))?$/);
    if (m) {
      pendingReturns.push({ type: m[1], desc: oneLine(m[2]) });
      continue;
    }
    if (/^---@deprecated/.test(line)) {
      pendingDeprecated = true;
      continue;
    }
    // ---@class Name[: Parent]
    m = line.match(/^---@class\s+([\w.]+)(?::\s*([\w.]+))?/);
    if (m) {
      sections.classes.push({ name: m[1], parent: m[2] || '', fields: [], file: '' });
      flush();
      continue;
    }
    // ---@field name type [desc]
    m = line.match(/^---@field\s+(\w+)\s+([\w.]+)\s*(.*)$/);
    if (m) {
      const cls = sections.classes[sections.classes.length - 1];
      if (cls) cls.fields.push({ name: m[1], type: m[2], desc: oneLine(m[3]) });
      continue;
    }
    // Plain doc text line
    if (/^---/.test(line) && !/^---@/.test(line)) {
      const text = line.replace(/^---\s?/, '');
      if (text.trim()) pendingDesc.push(text.trim());
      continue;
    }
    // Function declaration
    m = line.match(/^\s*(?:local\s+)?function\s+([\w.:]+)\s*\((.*)\)/);
    if (m) {
      sections.functions.push({
        name: m[1],
        args: m[2].trim(),
        desc: oneLine(pendingDesc.join(' ')),
        params: pendingParams.slice(),
        returns: pendingReturns.slice(),
        vararg: pendingVararg,
        deprecated: pendingDeprecated,
      });
      flush();
      continue;
    }
    // Any blank/non-doc line terminates an accumulated description block
    if (line === '' ) flush();
  }
  return sections;
}

async function main() {
  const text = await readFile(SRC, 'utf8');

  // Split on "## FILE: <rel>"
  const parts = text.split(/^## FILE: (.+)$/gm);
  const files = [];
  for (let i = 1; i < parts.length; i += 2) {
    files.push({ rel: parts[i].trim(), body: parts[i + 1] || '' });
  }

  const allFuncs = [];
  const allClasses = [];
  const perFile = [];

  for (const f of files) {
    const body = f.body.replace(/^```lua\s*$/m, '').replace(/^```\s*$/m, '');
    const { functions, classes } = parseFileSection(body);
    functions.forEach((fn) => (fn.file = f.rel));
    classes.forEach((c) => (c.file = f.rel));
    allFuncs.push(...functions);
    allClasses.push(...classes);
    perFile.push({ rel: f.rel, funcs: functions.length, classes: classes.length });
  }

  // Deduplicate by name (experiment/ duplicates core/)
  const seen = new Map();
  for (const fn of allFuncs) {
    const prev = seen.get(fn.name);
    if (!prev || (fn.desc.length > prev.desc.length)) seen.set(fn.name, fn);
  }
  const funcs = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

  const seenCls = new Map();
  for (const c of allClasses) if (!seenCls.has(c.name)) seenCls.set(c.name, c);
  const classes = [...seenCls.values()].sort((a, b) => a.name.localeCompare(b.name));

  const out = [];
  out.push('# LuaSTG API Index (derived)');
  out.push('');
  out.push(`Source: \`${path.relative(ROOT, SRC)}\``);
  out.push('');
  out.push(`- unique functions: **${funcs.length}**`);
  out.push(`- unique classes: **${classes.length}**`);
  out.push(`- source sections: ${files.length}`);
  out.push('');
  out.push('## Files');
  out.push('');
  for (const p of perFile) out.push(`- \`${p.rel}\` — ${p.funcs} functions, ${p.classes} classes`);
  out.push('');
  out.push('## Functions');
  out.push('');
  for (const fn of funcs) {
    const params = fn.params.map((p) => `${p.name}:${p.type}`).join(', ');
    const rets = fn.returns.map((r) => r.type).join(',');
    out.push(`### ${fn.name}(${fn.args})`);
    if (fn.desc) out.push(`> ${fn.desc}`);
    out.push(`- file: ${fn.file}`);
    if (params) out.push(`- params: ${params}`);
    if (fn.vararg) out.push(`- vararg: ${fn.vararg}`);
    if (rets) out.push(`- returns: ${rets}`);
    if (fn.deprecated) out.push('- **deprecated**');
    out.push('');
  }
  out.push('## Classes');
  out.push('');
  for (const c of classes) {
    out.push(`### ${c.name}${c.parent ? ` : ${c.parent}` : ''}`);
    out.push(`- file: ${c.file}`);
    if (c.fields.length) out.push(`- fields: ${c.fields.map((f) => `${f.name}:${f.type}`).join(', ')}`);
    out.push('');
  }

  await writeFile(OUT, out.join('\n'), 'utf8');
  console.log(`functions: ${funcs.length}`);
  console.log(`classes  : ${classes.length}`);
  console.log(`files    : ${files.length}`);
  console.log(`output   : ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error('[api-index] failed:', e);
  process.exit(1);
});
