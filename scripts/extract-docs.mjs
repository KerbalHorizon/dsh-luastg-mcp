#!/usr/bin/env node
/**
 * extract-docs.mjs
 *
 * Cleans and consolidates the LuaSTG AEX+ / LuaSTG Sub reference docs found in
 *   docs/luastgaex+_doc/
 * into a single LLM-friendly corpus:
 *   docs/_raw_api_temp.md
 *
 * Pipeline
 *   1. Walk the doc tree (recursively, binary/image files are skipped).
 *   2. Decode + strip HTML (tags, scripts, styles, comments, entities).
 *   3. Score each file for "API density" using the LuaLS doc-comment dialect
 *      (`function lstg.X(...)`, `---@param`, `---@return`, `---@class`, ...).
 *   4. Drop changelogs / tutorials / readmes / licenses / tiny stubs by both
 *      filename heuristic and content score.
 *   5. Emit one markdown file with a per-file `## FILE:` header, a provenance
 *      table, and normalised body text.
 *
 * Usage: node scripts/extract-docs.mjs [--verbose] [--src <dir>] [--out <file>]
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const DEFAULT_SRC = path.join(ROOT, 'docs', 'luastgaex+_doc');
const DEFAULT_OUT = path.join(ROOT, 'docs', '_raw_api_temp.md');

/** File extensions we consider text and therefore eligible for extraction. */
const TEXT_EXT = new Set([
  '.lua', '.md', '.markdown', '.txt', '.html', '.htm',
  '.json', '.yml', '.yaml', '.cfg', '.ini',
]);

/** Filename patterns that mark a file as "not an API dictionary". */
const NAME_BLOCKLIST = [
  /changelog/i,
  /change[-_ ]?log/i,
  /更新日志/,
  /更新记录/,
  /版本历史/,
  /history/i,
  /^readme/i,
  /license/i,
  /^copying/i,
  /^authors?/i,
  /^contributing/i,
  /tutorial/i,
  /教程/,
  /入门/,
  /^guide/i,
  /安装/,
  /install/i,
  /^faq/i,
  /^notes?/i,
  /todo/i,
];

/** Directories (by basename) that never contain first-party API reference. */
const DIR_BLOCKLIST = [/^\.git$/, /^\.github$/, /^images?$/i, /^assets$/i, /^node_modules$/];

/** LuaLS doc tags that indicate structured API documentation. */
const DOC_TAG_RE = /^\s*---@(param|return|class|field|type|vararg|generic|overload|deprecated|see|enum)\b/gm;
/** Real function/method declarations (`function lstg.New(...)`, `function M:foo()`). */
const FUNC_DECL_RE = /^\s*(local\s+)?function\s+[\w.:]+\s*\(/gm;
/** Loose API mentions, used as a weak tie-breaker signal. */
const API_MENTION_RE = /\b(lstg\.[A-Za-z_]\w*|task\.[A-Za-z_]\w*)\s*[.(]/g;

/** A file must clear this weighted score to be kept. */
const MIN_SCORE = 10;
/** And must have at least this many bytes of cleaned text. */
const MIN_BYTES = 300;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose') || argv.includes('-v');
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const SRC = path.resolve(ROOT, argOf('--src') ?? DEFAULT_SRC);
const OUT = path.resolve(ROOT, argOf('--out') ?? DEFAULT_OUT);

// ---------------------------------------------------------------------------
// Text cleaning
// ---------------------------------------------------------------------------

/** Strip HTML tags / scripts / styles and decode the usual entities. */
function stripHtml(input) {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/tr|\/h[1-6]|\/li|\/pre|\/table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/gi, '&');
}

/** Normalise line endings, indentation and blank-line runs. */
function normalise(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Remove decorative separator lines such as `------` or `=====` only when they
 *  are the *entire* line and longer than 20 chars (keeps markdown headings). */
function stripRulers(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t.length <= 20) return true;
      return !(/^[-=*_#~]{20,}$/.test(t));
    })
    .join('\n');
}

function clean(raw) {
  return normalise(stripRulers(stripHtml(raw)));
}

// ---------------------------------------------------------------------------
// Scoring / filtering
// ---------------------------------------------------------------------------

function scoreText(text) {
  const lines = text.split('\n');
  const funcDecls = (text.match(FUNC_DECL_RE) || []).length;
  const docTags = (text.match(DOC_TAG_RE) || []).length;
  const mentions = (text.match(API_MENTION_RE) || []).length;
  const codeLines = lines.filter((l) => /^\s*(function|local|end\b|return\b|\w+\s*=)/.test(l)).length;
  const apiLines = lines.filter((l) => /lstg\.|task\.|---@/.test(l)).length;
  const density = lines.length ? apiLines / lines.length : 0;

  // Weighted score: real declarations dominate, doc tags support, mentions nudge.
  const score = funcDecls * 6 + docTags * 1.2 + mentions * 0.35 + codeLines * 0.2;

  return { lines: lines.length, funcDecls, docTags, mentions, codeLines, density, score };
}

function classify(relPath, baseName, size, text, stats) {
  const lower = baseName.toLowerCase();

  for (const dirRe of DIR_BLOCKLIST) {
    const segments = relPath.split(/[\\/]/);
    if (segments.some((s) => dirRe.test(s))) {
      return { keep: false, reason: 'ignored-directory' };
    }
  }

  for (const re of NAME_BLOCKLIST) {
    if (re.test(lower)) return { keep: false, reason: `name-blocklist:${re.source}` };
  }

  if (size < MIN_BYTES || text.length < MIN_BYTES) {
    return { keep: false, reason: 'too-small' };
  }

  if (stats.score < MIN_SCORE) {
    return { keep: false, reason: `low-api-score(${stats.score.toFixed(1)})` };
  }

  // Guard against prose-heavy tutorials that merely mention the API a lot.
  if (stats.density < 0.10 && stats.funcDecls === 0) {
    return { keep: false, reason: `prose-heavy(density=${stats.density.toFixed(2)})` };
  }

  return { keep: true, reason: 'api-reference' };
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DIR_BLOCKLIST.some((re) => re.test(entry.name))) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(SRC)) {
    console.error(`[extract] source directory not found: ${SRC}`);
    process.exit(1);
  }

  const rows = [];
  const kept = [];
  let scanned = 0;

  for await (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file);

    if (!TEXT_EXT.has(ext)) {
      rows.push({ rel, kind: 'skip', reason: `non-text(${ext || 'no-ext'})`, bytes: 0 });
      continue;
    }

    const info = await stat(file);
    const raw = await readFile(file, 'utf8').catch(() => '');
    scanned += 1;

    const text = clean(raw);
    const stats = scoreText(text);
    const verdict = classify(rel, base, info.size, text, stats);

    rows.push({
      rel,
      kind: verdict.keep ? 'keep' : 'skip',
      reason: verdict.reason,
      bytes: Buffer.byteLength(text, 'utf8'),
      stats,
    });

    if (verdict.keep) kept.push({ rel, text, stats, bytes: Buffer.byteLength(text, 'utf8') });
  }

  kept.sort((a, b) => b.stats.score - a.stats.score || a.rel.localeCompare(b.rel));

  const totalKeptBytes = kept.reduce((n, k) => n + k.bytes, 0);
  const totalScannedBytes = rows
    .filter((r) => r.stats)
    .reduce((n, r) => n + r.bytes, 0);

  const stamp = new Date().toISOString();
  const out = [];
  out.push('# LuaSTG AEX+ / LuaSTG Sub — Raw API Corpus');
  out.push('');
  out.push(`<!-- generated by scripts/extract-docs.mjs at ${stamp} -->`);
  out.push('');
  out.push('## Extraction Report');
  out.push('');
  out.push(`- Source directory: \`${path.relative(ROOT, SRC).replace(/\\/g, '/')}\``);
  out.push(`- Text files scanned: **${scanned}**`);
  out.push(`- Files kept as API reference: **${kept.length}**`);
  out.push(`- Files filtered out: **${rows.length - kept.length}**`);
  out.push(`- Merged size: ${(totalKeptBytes / 1024).toFixed(1)} KB`);
  out.push('');
  out.push('| # | Source file | API score | funcs | doc-tags | kept bytes |');
  out.push('|---|-------------|-----------|-------|----------|------------|');
  kept.forEach((k, i) => {
    out.push(
      `| ${i + 1} | \`${k.rel}\` | ${k.stats.score.toFixed(1)} | ${k.stats.funcDecls} | ${k.stats.docTags} | ${k.bytes} |`,
    );
  });
  out.push('');
  out.push('### Filtered out');
  out.push('');
  for (const r of rows.filter((x) => x.kind === 'skip')) {
    out.push(`- \`${r.rel}\` — ${r.reason}`);
  }
  out.push('');
  out.push('---');
  out.push('');

  for (const k of kept) {
    out.push(`## FILE: ${k.rel}`);
    out.push('');
    out.push('```lua');
    out.push(k.text);
    out.push('```');
    out.push('');
  }

  await writeFile(OUT, out.join('\n'), 'utf8');

  // Console report ---------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log('  SCORE  FUNCS  TAGS   BYTES  FILE');
  console.log('  ' + '-'.repeat(78));
  for (const r of rows) {
    const s = r.stats;
    const mark = r.kind === 'keep' ? '+' : '-';
    const score = s ? s.score.toFixed(0).padStart(5) : '    -';
    const funcs = s ? String(s.funcDecls).padStart(5) : '    -';
    const tags = s ? String(s.docTags).padStart(5) : '    -';
    const bytes = String(r.bytes ?? 0).padStart(7);
    console.log(`  ${mark} ${score}  ${funcs}  ${tags}  ${bytes}  ${pad(r.rel, 52)} ${r.kind === 'skip' ? '(' + r.reason + ')' : ''}`);
  }
  console.log('');
  console.log(`  scanned      : ${scanned}`);
  console.log(`  kept         : ${kept.length}`);
  console.log(`  filtered     : ${rows.length - kept.length}`);
  console.log(`  merged bytes : ${totalKeptBytes} (${(totalKeptBytes / 1024).toFixed(1)} KB)`);
  console.log(`  scanned text : ${(totalScannedBytes / 1024).toFixed(1)} KB`);
  console.log(`  output       : ${path.relative(ROOT, OUT)}`);
  console.log('');

  if (verbose) {
    const dropped = rows.filter((r) => r.kind === 'skip');
    console.log('  dropped detail:');
    for (const d of dropped) console.log(`    ${d.rel} -> ${d.reason}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('[extract] failed:', err);
  process.exit(1);
});
