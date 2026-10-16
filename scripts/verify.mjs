#!/usr/bin/env node
/**
 * Plugin self-check: module syntax, manifest, client bundle, and the DSH compatibility gate.
 *
 * Usage:
 *   node scripts/verify.mjs                        # auto-detect the DSH installation
 *   node scripts/verify.mjs --dsh <dir>            # point at a DSH package directory
 *   node scripts/verify.mjs --version 0.2.0-rc.2   # only check a runtime version
 *
 * Standard library only — no dependencies, no build step. Paths are derived from
 * `--dsh`, `$DSH_HOME`, or the default `~/.dsh`, so this stays portable.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// 1) Every module must parse.
const libDir = join(root, 'lib')
const modules = readdirSync(libDir).filter((name) => name.endsWith('.js'))
const broken = modules.filter((name) => {
  try {
    execFileSync(process.execPath, ['--check', join(libDir, name)], { stdio: 'pipe' })
    return false
  } catch {
    return true
  }
})
check(broken.length === 0, `${modules.length} modules parse`, broken.join(', '))

// 2) Manifest shape that both DSH halves rely on.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check(manifest.main === 'lib/index.js', 'main points at the host half')
check(manifest.dsh?.client?.platform === 'web', 'declares a web client half')
check(Array.isArray(manifest.files) && manifest.files.length > 0, 'files whitelist is set')
check(manifest.private !== true, 'not marked private (publishable)')

// 3) Host half must load on its own (it is a plain ESM module).
//    Its @deepseek-ai/* peers are provided by the DSH installation at runtime, so a bare
//    checkout cannot resolve them — that is expected, not a failure. Any other error is real.
try {
  const host = await import(`file://${join(root, 'lib/index.js').replace(/\\/g, '/')}`)
  // Schemastery hands back a schema *constructor*, not a plain object — check it has a dict.
  check(
    typeof host.apply === 'function' && host.Config != null && host.Config.dict != null,
    'host half exports apply + a Config schema',
  )
} catch (error) {
  const message = String(error?.message ?? error)
  if (message.includes("Cannot find package '@deepseek-ai/")) {
    console.log('  skip  host half import — DSH peers are not installed here (the host provides them)')
  } else {
    check(false, 'host half imports', message)
  }
}

// 4) Client bundle must register under the package name, or client-modules will not find it.
const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
const id = /id:\s*["']([^"']+)["']/.exec(bundle)?.[1]
check(id === manifest.name, `client bundle registers as "${manifest.name}"`, `found "${id}"`)

// 5) Compatibility gate: every @deepseek-ai/dsh* peer must accept the runtime version.
const candidateDirs = [
  flag('--dsh'),
  process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles/node_modules/@deepseek-ai/dsh'),
  join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh'),
].filter(Boolean)

let runtime = flag('--version')
let source = runtime ? 'argument' : ''
if (!runtime) {
  for (const dir of candidateDirs) {
    const file = join(dir, 'package.json')
    if (!existsSync(file)) continue
    runtime = JSON.parse(readFileSync(file, 'utf8')).version
    source = dir
    break
  }
}
if (!runtime) {
  console.log('  skip  compatibility gate — no DSH install found; pass --version to check it')
} else {
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) =>
    name.startsWith('@deepseek-ai/dsh'),
  )
  const rejects = peers.filter(([, range]) => !accepts(range, runtime, manifest.version))
  check(
    rejects.length === 0,
    `${peers.length} DSH peer ranges accept ${runtime}`,
    rejects.map(([name, range]) => `${name}@${range}`).join(', ') || `runtime from ${source}`,
  )
}

/** Minimal semver-range check for the shapes this manifest uses: `>=x.y.z-rc.n`, `^x.y.z`, `~x.y.z`, `*`. */
function accepts(range, version, ownVersion) {
  if (range === '*' || range === 'workspace:*' || range.startsWith('workspace:')) return true
  const wanted = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/)
  if (!wanted) return false
  const [major, minor, patch] = wanted.slice(1, 4).map(Number)
  const lower = /^[>^~]?=?\s*v?(\d+)\.(\d+)\.(\d+)/.exec(range)
  if (!lower) return false
  const [lMajor, lMinor, lPatch] = lower.slice(1, 4).map(Number)
  const above = major > lMajor || (major === lMajor && (minor > lMinor || (minor === lMinor && patch >= lPatch)))
  if (range.startsWith('^')) return major === lMajor && above
  if (range.startsWith('~')) return major === lMajor && minor === lMinor && above
  return above
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
