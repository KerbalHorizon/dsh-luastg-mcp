#!/usr/bin/env node
// Extract keyframes from a video with ffmpeg, so a model can look at them one by one.
//
// Frames land in the system temp directory (never in the repository) and are printed as a JSON
// manifest: `{ ok, outDir, mode, count, frames: [{ index, path, bytes }] }`.
//
//   node scripts/extract-video-frames.mjs game.mp4
//   node scripts/extract-video-frames.mjs game.mp4 --scene=0.2 --max=40 --scale=1600:-2
//   node scripts/extract-video-frames.mjs game.mp4 --scene=0 --fps=2        # fixed rate instead
//   node scripts/extract-video-frames.mjs game.mp4 --out=C:\Temp\frames
//
// Scene mode (`--scene`, default 0.3) keeps the first frame of every scene cut, which is what
// makes a 10-minute replay readable in ~20 images. `--scene=0` switches to a fixed `--fps`.
//
// Needs ffmpeg on PATH, via FFMPEG_PATH, or through `--ffmpeg=C:\path\to\ffmpeg.exe`.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const DEFAULTS = { scene: 0.3, fps: 1, max: 60, scale: '1280:-2' }

function usage(message) {
  if (message) console.error(`error: ${message}\n`)
  console.error(
    'usage: node scripts/extract-video-frames.mjs <video> [--scene=0.3] [--fps=1] [--max=60] ' +
      '[--scale=1280:-2] [--out=<dir>] [--ffmpeg=<exe>]',
  )
  process.exit(message ? 1 : 0)
}

function parseArgs(argv) {
  const positional = []
  const options = { ...DEFAULTS, out: '', ffmpeg: '' }

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') usage()
    else if (!arg.startsWith('--')) positional.push(arg)
    else {
      const [key, raw = ''] = arg.slice(2).split('=')
      const value = raw.trim()
      switch (key) {
        case 'scene':
          options.scene = Number(value)
          if (!Number.isFinite(options.scene) || options.scene < 0 || options.scene > 1) {
            usage(`--scene must be between 0 and 1 (got '${value}')`)
          }
          break
        case 'fps':
          options.fps = Number(value)
          if (!Number.isFinite(options.fps) || options.fps <= 0) usage(`--fps must be > 0 (got '${value}')`)
          break
        case 'max':
          options.max = Number.parseInt(value, 10)
          if (!Number.isInteger(options.max) || options.max <= 0) usage(`--max must be a positive integer (got '${value}')`)
          break
        case 'scale':
          if (!/^\d+:-?\d+$/.test(value)) usage(`--scale must look like 1280:-2 (got '${value}')`)
          options.scale = value
          break
        case 'out':
          options.out = value
          break
        case 'ffmpeg':
          options.ffmpeg = value
          break
        default:
          usage(`unknown option --${key}`)
      }
    }
  }

  return { positional, options }
}

/** `ffmpeg -version` in one shot: the exit code is the whole answer. */
function probe(candidate) {
  const result = spawnSync(candidate, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 10_000 })
  return result.status === 0
}

function findFfmpeg(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH)
  candidates.push('ffmpeg')
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? ''
    candidates.push(
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      join(local, 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    )
  }

  for (const candidate of candidates) {
    if (candidate && probe(candidate)) return candidate
  }
  return null
}

const { positional, options } = parseArgs(process.argv.slice(2))
if (positional.length === 0) usage('a video file is required')

const video = resolve(positional[0])
if (!existsSync(video)) usage(`video not found: ${video}`)

const ffmpeg = findFfmpeg(options.ffmpeg)
if (ffmpeg === null) {
  console.error(
    'error: ffmpeg was not found.\n' +
      '  install:  winget install Gyan.FFmpeg   (or: scoop install ffmpeg / choco install ffmpeg)\n' +
      '  or pass:  --ffmpeg=C:\\path\\to\\ffmpeg.exe\n' +
      '  or set:   FFMPEG_PATH',
  )
  process.exit(2)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir =
  options.out !== ''
    ? resolve(options.out)
    : join(tmpdir(), `luastg_frames_${basename(video, extname(video)).replace(/[^\w.-]+/g, '_')}_${stamp}`)
mkdirSync(outDir, { recursive: true })

const sceneMode = options.scene > 0
const filters = sceneMode
  ? [`select='gt(scene,${options.scene})'`, `scale=${options.scale}`]
  : [`fps=${options.fps}`, `scale=${options.scale}`]

const args = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  video,
  '-vf',
  filters.join(','),
  '-vsync',
  'vfr',
  '-frames:v',
  String(options.max),
  join(outDir, 'frame_%04d.png'),
]

const startedAt = performance.now()
const run = spawnSync(ffmpeg, args, { stdio: 'ignore', timeout: 15 * 60_000 })

if (run.error) {
  console.error(`error: ffmpeg could not run: ${run.error.message}`)
  process.exit(3)
}
if (run.status !== 0) {
  console.error(`error: ffmpeg exited with code ${run.status} (is the file a readable video?)`)
  process.exit(4)
}

const frames = readdirSync(outDir)
  .filter((name) => name.endsWith('.png'))
  .sort()
  .map((name, index) => {
    const path = join(outDir, name)
    return { index, path, bytes: statSync(path).size }
  })

if (frames.length === 0) {
  console.error(
    `error: no frame was extracted (scene=${options.scene}). Try a lower threshold: --scene=0.1, ` +
      'or a fixed rate: --scene=0 --fps=2',
  )
  process.exit(5)
}

console.log(
  JSON.stringify(
    {
      ok: true,
      ffmpeg,
      video,
      outDir,
      mode: sceneMode ? 'scene' : 'fps',
      scene: sceneMode ? options.scene : undefined,
      fps: sceneMode ? undefined : options.fps,
      scale: options.scale,
      count: frames.length,
      truncated: frames.length >= options.max,
      frames,
      elapsedMs: Math.round(performance.now() - startedAt),
    },
    null,
    2,
  ),
)
