// Apply a `luastg_apply_subtree` tree to the live editor from the command line.
//
// DSH registers host plugins when the process starts, so a rebuilt lib/index.js
// is not visible to an already-running session. This script loads the same tool
// implementation and drives it against the live bridge, which is how a tree can
// be applied right after `npm run build` without restarting DSH.
//
//   node scripts/live-apply-subtree.mjs build/stage1-native-tree.json
//   node scripts/live-apply-subtree.mjs tree.json 0/2 --port=8090 --reveal=false
//
// The file may be the tree itself or a saved tool request (`{ "tree": ... }`).
import { readFileSync } from 'node:fs'

import { apply } from '../lib/index.js'

function usage(message) {
  if (message) console.error(`error: ${message}\n`)
  console.error(
    'usage: node scripts/live-apply-subtree.mjs <tree.json|-> [parent] [--host=127.0.0.1] [--port=8090] [--reveal=false]',
  )
  process.exit(message ? 1 : 0)
}

function parseArgs(argv) {
  const positional = []
  const options = { host: '127.0.0.1', port: 8090, reveal: true }
  for (const arg of argv) {
    if (arg === '--reveal=false') options.reveal = false
    else if (arg === '--reveal=true') options.reveal = true
    else if (arg.startsWith('--port=')) {
      const raw = arg.slice('--port='.length)
      options.port = Number(raw)
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        usage(`--port must be an integer between 1 and 65535 (got ${raw})`)
      }
    } else if (arg.startsWith('--host=')) options.host = arg.slice('--host='.length)
    else if (arg === '--help' || arg === '-h') usage()
    else if (arg.startsWith('--')) usage(`unknown option ${arg}`)
    else positional.push(arg)
  }
  return { positional, options }
}

const { positional, options } = parseArgs(process.argv.slice(2))
if (positional.length === 0) usage('a tree file (or - for stdin) is required')

const [source, parent = '0'] = positional
const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')

let parsed
try {
  parsed = JSON.parse(raw)
} catch (error) {
  usage(`${source} is not valid JSON: ${error.message}`)
}
const tree = parsed !== null && typeof parsed === 'object' && parsed.tree !== undefined ? parsed.tree : parsed

const registered = new Map()
apply(
  { tools: { register: (definition) => registered.set(definition.name, definition) } },
  { host: options.host, port: options.port, timeoutMs: 5000 },
)

const tool = registered.get('luastg_apply_subtree')
if (tool === undefined) usage('lib/index.js did not register luastg_apply_subtree; run npm run build first')

try {
  const value = await tool.execute(
    { parent, tree, reveal: options.reveal },
    { signal: AbortSignal.timeout(60_000) },
  )
  console.log(JSON.stringify(value, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
