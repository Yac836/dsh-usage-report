#!/usr/bin/env node
/**
 * First-time install of this plugin into a DSH profile.
 *
 * Copies the deployment whitelist (the same `pluginFiles` list the guarded updater uses)
 * into `<DSH_HOME>/profiles/<profile>/plugins/dsh-usage-report` and writes the
 * `.deployment.json` manifest, so `update.cmd` / `scripts/sync-deploy.ps1` can manage that
 * copy from then on.
 *
 * Usage:
 *   node scripts/install.mjs                     # detect <DSH_HOME> (~/.dsh), profile "web"
 *   node scripts/install.mjs --dsh <home>        # explicit DSH home
 *   node scripts/install.mjs --profile <name>    # profile name (default: web)
 *   node scripts/install.mjs --profile desktop --desktop <install dir or exe>
 *   node scripts/install.mjs --check             # dry run, writes nothing
 *
 * Guarantees, matching the updater's rules:
 *   - never writes DSH configuration (it prints the patch snippet to add instead)
 *   - never deletes or overwrites an existing installation
 *   - refuses a dirty checkout, a symlinked path, or an unknown profile
 *   - records the exact commit and a sha256 per file
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { pluginFiles } from './sync-deploy.mjs'
import { assertDesktopClosed, checkDesktop, findDesktop } from './desktop-runtime.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fail = (message) => {
  console.error(`install: ${message}`)
  process.exit(1)
}

// Validate the entire command before inspecting or writing any runtime paths.
// Do not echo parser errors: arguments can contain private paths or values.
let options
try {
  const parsed = parseArgs({
    options: {
      dsh: { type: 'string' }, profile: { type: 'string' },
      desktop: { type: 'string' },
      check: { type: 'boolean' }, help: { type: 'boolean' },
    },
    strict: true, allowPositionals: false, tokens: true,
  })
  const seen = new Set()
  for (const token of parsed.tokens) {
    if (token.kind !== 'option' || seen.has(token.name)) throw new Error('invalid option')
    seen.add(token.name)
    if (typeof token.value === 'string' && (!token.value.trim() || token.value.startsWith('--'))) {
      throw new Error('missing option value')
    }
  }
  options = parsed.values
} catch {
  fail('invalid arguments; use --help. No files were written.')
}
if (options.help) {
  console.log('Usage: node scripts/install.mjs [--dsh <data home>] [--profile <name>] [--desktop <Desktop install directory or exe>] [--check] [--help]')
  console.log('--check validates installation without writing files. Unknown or repeated options are rejected.')
  process.exit(0)
}
const check = options.check === true

/** Reject symlinks anywhere in the chain, so a "path" cannot hide behind a link. */
function plain(path) {
  const resolved = resolve(path)
  let at = resolved
  for (;;) {
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) fail(`refusing symlinked path: ${at}`)
    const parent = dirname(at)
    if (parent === at) return resolved
    at = parent
  }
}

const inside = (parent, child) => {
  const part = relative(resolve(parent), resolve(child))
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../'))
}

const git = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

const dshHome = plain(options.dsh ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profile = options.profile ?? 'web'
if (!/^[a-zA-Z0-9_-]+$/.test(profile)) fail('invalid --profile')
if (options.desktop && profile !== 'desktop') fail('--desktop requires --profile desktop')
if (options.desktop && process.platform !== 'win32') fail('--desktop automatic checks currently require Windows')
if (!existsSync(dshHome)) fail(`DSH home not found: ${dshHome} (pass --dsh <dir>)`)

const profileDir = join(dshHome, 'profiles', profile)
if (!existsSync(profileDir)) fail(`profile not found: ${profileDir} (create it in DSH first, or pass --profile)`)
const patchFile = join(profileDir, 'cordis.patch.yml')
if (!existsSync(patchFile)) {
  fail(`no cordis.patch.yml in ${profileDir}; the updater needs it — create the profile in DSH first`)
}
const target = plain(join(profileDir, 'plugins', 'dsh-usage-report'))
if (!inside(profileDir, target)) fail('resolved target escapes the profile directory')

// Refuse to touch an existing installation; the updater owns that copy.
if (existsSync(target)) {
  const entries = readdirSync(target).filter((name) => name !== '.deployment.json')
  fail(
    entries.length > 0
      ? `target already exists and is not empty: ${target}\n       Move it aside first, or use the updater (update.cmd) to sync it.`
      : `target exists with an installation marker already: ${target}`,
  )
}

// The manifest records a commit, so the checkout must actually be at one and be clean.
let commit
try {
  commit = git(['rev-parse', 'HEAD'])
} catch {
  fail('not a git checkout; the installation manifest records a commit')
}
if (!/^[a-f0-9]{40}$/.test(commit)) fail(`unexpected HEAD: ${commit}`)
if (git(['status', '--porcelain']).length > 0) {
  fail('working tree is dirty; commit or stash first so the manifest matches what is installed')
}

const source = plain(root)
const files = {}
for (const rel of pluginFiles) {
  const from = plain(join(source, rel))
  if (!existsSync(from)) fail(`missing source file: ${rel}`)
  files[rel] = sha256(from)
}

let desktop
if (profile === 'desktop' && process.platform === 'win32') {
  try {
    desktop = checkDesktop({ executable: findDesktop(options.desktop), plugin: source })
    if (!check) assertDesktopClosed()
  } catch (error) {
    const code = /^[a-z_]+$/.test(error?.message || '') ? error.message : 'desktop_check_failed'
    fail(`${code}. Fully quit Desktop before installing; use --desktop to select its installation. No files were written.`)
  }
}
const quote = value => `'${value.replaceAll("'", "''")}'`
const updateCommand = `pwsh -NoProfile -File .\\scripts\\sync-deploy.ps1 -DshHome ${quote(dshHome)} -Profile ${profile}`
  + (desktop ? ` -DesktopPath ${quote(desktop.executable)}` : '')
  + (profile === 'desktop' ? ' -NoRestart' : '')

if (check) {
  console.log(`dry run — would install ${pluginFiles.length} files from ${source}`)
  console.log(`  into ${target}`)
  console.log(`  at commit ${commit}`)
  if (desktop) console.log(`Desktop ${desktop.version}: bundled peers and plugin import passed.`)
  console.log(`Later Windows updates (reuse this data home): ${updateCommand}`)
  process.exit(0)
}

for (const rel of pluginFiles) {
  const to = join(target, rel)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(source, rel), to)
}

const installed = {}
for (const rel of pluginFiles) {
  const hash = sha256(join(target, rel))
  if (hash !== files[rel]) fail(`copy verification failed for ${rel}`)
  installed[rel] = hash
}

const marker = join(target, '.deployment.json')
if (existsSync(marker)) fail('refusing to overwrite an existing .deployment.json')
writeFileSync(
  marker,
  JSON.stringify({ commit, profile, installedAt: new Date().toISOString(), files: installed }, null, 2) + '\n',
  { mode: 0o600 },
)

const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
if (manifest.name !== 'dsh-usage-report') fail(`unexpected package name: ${manifest.name}`)

console.log(`installed ${pluginFiles.length} files at commit ${commit.slice(0, 7)}`)
console.log(`  target: ${target}`)
console.log('')
console.log('Next: add this row to ' + join(profileDir, 'cordis.patch.yml') + ' (see examples/cordis.patch.example.yml):')
console.log('')
console.log('  - insert:')
console.log('      - id: usage-report')
console.log('        name: ./plugins/dsh-usage-report/lib/index.js')
console.log('')
console.log('Then restart DSH. Later Windows updates (reuse this data home):')
console.log(updateCommand)
