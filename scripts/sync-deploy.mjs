/** File transaction for sync-deploy.ps1. No DSH configuration or session writes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const pluginFiles = Object.freeze([
  'package.json', 'LICENSE', 'README.md', 'README.zh-CN.md',
  ...['aggregate', 'cache', 'client', 'currency', 'index', 'pricing', 'projection', 'render'].map(name => `lib/${name}.js`),
])
const marker = '.deployment.json'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = file => digest(readFileSync(file))
const fail = code => { throw new Error(code) }
const requireThat = (condition, code) => { if (!condition) fail(code) }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'w', mode: 0o600 })

function plainPath(path) {
  path = resolve(path)
  for (let at = path; ; at = dirname(at)) {
    if (existsSync(at)) requireThat(!lstatSync(at).isSymbolicLink(), 'linked_path_refused')
    if (dirname(at) === at) break
  }
  return path
}

function contains(parent, child) {
  const part = relative(resolve(parent), resolve(child))
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function readJson(file) {
  requireThat(statSync(plainPath(file)).size < 128 * 1024, 'metadata_too_large')
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function filesIn(dir, prefix = '') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = prefix + entry.name
    requireThat(!entry.isSymbolicLink(), 'linked_path_refused')
    if (entry.isDirectory()) {
      requireThat(name === 'lib', 'unknown_installed_directory')
      files.push(...filesIn(join(dir, entry.name), `${name}/`))
    } else {
      requireThat(entry.isFile(), 'special_file_refused')
      files.push(name)
    }
  }
  return files.sort()
}

function checkedInstallation(dir, profile) {
  plainPath(dir)
  requireThat(same(filesIn(dir), [...pluginFiles, marker].sort()), 'unknown_or_missing_installed_file')
  const info = readJson(join(dir, marker))
  requireThat(Object.keys(info).every(key => ['commit', 'profile', 'installedAt', 'files'].includes(key)), 'unknown_installation_metadata')
  requireThat(/^[a-f0-9]{40}$/.test(info.commit) && info.profile === profile, 'invalid_installation_metadata')
  requireThat(same(Object.keys(info.files).sort(), [...pluginFiles].sort()), 'invalid_file_manifest')
  for (const file of pluginFiles) requireThat(info.files[file] === hash(join(dir, file)), 'installed_file_modified')
  requireThat(readJson(join(dir, 'package.json')).name === 'dsh-usage-report', 'wrong_plugin')
  return { info, markerHash: hash(join(dir, marker)) }
}

export function planDeployment({ source, dshHome, profile = 'web', commit }) {
  requireThat(/^[a-zA-Z0-9_-]+$/.test(profile), 'invalid_profile')
  requireThat(/^[a-f0-9]{40}$/.test(commit), 'invalid_commit')
  source = realpathSync(plainPath(source))
  dshHome = realpathSync(plainPath(dshHome))
  requireThat(!contains(source, dshHome) && !contains(dshHome, source), 'overlapping_source_and_runtime')
  const target = plainPath(join(dshHome, 'profiles', profile, 'plugins', 'dsh-usage-report'))
  const patch = plainPath(join(dshHome, 'profiles', profile, 'cordis.patch.yml'))
  requireThat(existsSync(target) && existsSync(patch), 'existing_installation_required')
  requireThat(same(filesIn(join(source, 'lib')), pluginFiles.filter(file => file.startsWith('lib/')).map(file => file.slice(4)).sort()), 'source_file_list_changed')
  const manifest = readJson(join(source, 'package.json'))
  requireThat(manifest.name === 'dsh-usage-report' && manifest.main === 'lib/index.js', 'wrong_source_package')
  const installed = checkedInstallation(target, profile)
  const files = Object.fromEntries(pluginFiles.map(file => [file, hash(plainPath(join(source, file)))]))
  return { source, dshHome, profile, target, patch, patchHash: hash(patch), commit,
    before: installed.info, beforeMarkerHash: installed.markerHash, files,
    unchanged: pluginFiles.every(file => files[file] === installed.info.files[file]) }
}

export function inspectInstallation({ dshHome, profile = 'web' }) {
  requireThat(/^[a-zA-Z0-9_-]+$/.test(profile), 'invalid_profile')
  const home = realpathSync(plainPath(dshHome))
  const installed = checkedInstallation(join(home, 'profiles', profile, 'plugins', 'dsh-usage-report'), profile)
  return { commit: installed.info.commit, markerHash: installed.markerHash }
}

function assertCurrent(record) {
  const current = checkedInstallation(record.target, record.profile)
  requireThat(current.markerHash === record.beforeMarkerHash && hash(record.patch) === record.patchHash, 'installation_changed_during_deploy')
}

export function prepareDeployment(options, backup) {
  const plan = planDeployment(options)
  backup = realpathSync(plainPath(backup))
  requireThat(!contains(plan.source, backup) && !contains(plan.dshHome, backup) && !contains(backup, plan.target), 'unsafe_backup_location')
  requireThat(readdirSync(backup).length === 0, 'backup_directory_not_empty')
  requireThat(statSync(backup).dev === statSync(dirname(plan.target)).dev, 'backup_must_be_on_runtime_volume')
  const candidate = join(backup, 'candidate')
  mkdirSync(join(candidate, 'lib'), { recursive: true, mode: 0o700 })
  for (const file of pluginFiles) {
    copyFileSync(join(plan.source, file), join(candidate, file))
    requireThat(hash(join(candidate, file)) === plan.files[file], 'source_changed_during_copy')
  }
  writeJson(join(candidate, marker), { commit: plan.commit, profile: plan.profile,
    installedAt: new Date().toISOString(), files: plan.files })
  checkedInstallation(candidate, plan.profile)
  assertCurrent(plan)
  writeJson(join(backup, 'deployment.json'), { ...plan, phase: 'prepared' })
  return { commit: plan.commit, previousCommit: plan.before.commit, backup }
}

function recoveryRecord(backup) {
  backup = realpathSync(plainPath(backup))
  const record = readJson(join(backup, 'deployment.json'))
  requireThat(/^[a-zA-Z0-9_-]+$/.test(record.profile), 'invalid_recovery_record')
  const expected = resolve(record.dshHome, 'profiles', record.profile, 'plugins', 'dsh-usage-report')
  requireThat(resolve(record.target) === expected && resolve(record.patch) === resolve(record.dshHome, 'profiles', record.profile, 'cordis.patch.yml'), 'invalid_recovery_record')
  requireThat(!contains(record.dshHome, backup) && !contains(record.source, backup) && !contains(backup, record.target), 'unsafe_backup_location')
  plainPath(record.target)
  plainPath(record.patch)
  return { backup, record }
}

async function importPlugin(target) {
  const host = await import(pathToFileURL(join(target, 'lib/index.js')).href)
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.Config({}).currency, 'USD')
}

export async function activateDeployment(backup, validate = importPlugin) {
  const saved = recoveryRecord(backup)
  backup = saved.backup
  const record = saved.record
  requireThat(record.phase === 'prepared', 'backup_not_prepared')
  assertCurrent(record)
  const candidate = join(backup, 'candidate')
  const next = checkedInstallation(candidate, record.profile)
  requireThat(next.info.commit === record.commit && same(next.info.files, record.files), 'candidate_changed')
  const previous = join(backup, 'previous')
  requireThat(!existsSync(previous), 'previous_backup_exists')
  renameSync(record.target, previous)
  try {
    renameSync(candidate, record.target)
    await validate(record.target)
    requireThat(hash(record.patch) === record.patchHash, 'configuration_changed_during_deploy')
    record.phase = 'active'
    writeJson(join(backup, 'deployment.json'), record)
  } catch {
    // Keep both versions. Never delete or overwrite an unexpected path on recovery.
    requireThat(!existsSync(candidate), 'activation_recovery_needs_inspection')
    if (existsSync(record.target)) renameSync(record.target, candidate)
    renameSync(previous, record.target)
    record.phase = 'restored_after_failure'
    writeJson(join(backup, 'deployment.json'), record)
    fail('activation_failed_previous_restored')
  }
  return { commit: record.commit, previousCommit: record.before.commit, backup, phase: record.phase }
}

export async function rollbackDeployment(backup, validate = importPlugin) {
  const saved = recoveryRecord(backup)
  backup = saved.backup
  const record = saved.record
  requireThat(record.phase === 'active', 'backup_not_active')
  const current = checkedInstallation(record.target, record.profile)
  requireThat(current.info.commit === record.commit && same(current.info.files, record.files), 'current_version_does_not_match_backup')
  const previous = join(backup, 'previous')
  const old = checkedInstallation(previous, record.profile)
  requireThat(old.markerHash === record.beforeMarkerHash, 'previous_backup_changed')
  const replaced = join(backup, 'replaced')
  requireThat(!existsSync(replaced), 'rollback_already_used')
  const patchBefore = hash(record.patch)
  renameSync(record.target, replaced)
  try {
    renameSync(previous, record.target)
    await validate(record.target)
    requireThat(hash(record.patch) === patchBefore, 'configuration_changed_during_rollback')
    record.phase = 'rolled_back'
    writeJson(join(backup, 'deployment.json'), record)
  } catch {
    requireThat(!existsSync(previous), 'rollback_recovery_needs_inspection')
    if (existsSync(record.target)) renameSync(record.target, previous)
    renameSync(replaced, record.target)
    fail('rollback_failed_current_restored')
  }
  return { commit: old.info.commit, backup, phase: record.phase }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, ...args] = process.argv.slice(2)
    const values = Object.fromEntries(args.reduce((pairs, value, at) => at % 2 ? pairs : [...pairs, [value, args[at + 1]]], []))
    const options = { source: values['--source'], dshHome: values['--home'], profile: values['--profile'], commit: values['--commit'] }
    let result
    if (action === 'plan') result = planDeployment(options)
    else if (action === 'inspect') result = inspectInstallation(options)
    else if (action === 'prepare') result = prepareDeployment(options, values['--backup'])
    else if (action === 'activate') result = await activateDeployment(values['--backup'])
    else if (action === 'rollback') result = await rollbackDeployment(values['--backup'])
    else fail('unknown_action')
    console.log(JSON.stringify(result))
  } catch (error) {
    // Do not echo raw filesystem/configuration/import errors, command output, or contents.
    const code = /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'deployment_check_failed'
    console.error(JSON.stringify({ ok: false, code }))
    process.exitCode = 1
  }
}
