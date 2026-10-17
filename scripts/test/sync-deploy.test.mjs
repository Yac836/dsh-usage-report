import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activateDeployment, planDeployment, pluginFiles, prepareDeployment, rollbackDeployment } from '../sync-deploy.mjs'

const oldCommit = '1'.repeat(40)
const newCommit = '2'.repeat(40)
const sha = value => createHash('sha256').update(value).digest('hex')
const json = (file, data) => writeFileSync(file, JSON.stringify(data))

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-deploy-test-'))
  const source = join(root, 'repo')
  const dshHome = join(root, 'home')
  const target = join(dshHome, 'profiles/web/plugins/dsh-usage-report')
  const patch = join(dshHome, 'profiles/web/cordis.patch.yml')
  const backup = join(root, 'backup')
  for (const dir of [join(source, 'lib'), join(target, 'lib'), backup, join(dshHome, 'sessions')]) mkdirSync(dir, { recursive: true })
  const packageData = { name: 'dsh-usage-report', main: 'lib/index.js', type: 'module' }
  const hashes = {}
  for (const file of pluginFiles) {
    const text = file === 'package.json' ? JSON.stringify(packageData)
      : file === 'lib/index.js' ? 'export function apply() {}\nexport const Config = () => ({currency: "USD"})\n'
        : file.endsWith('.js') ? 'export const sample = true\n' : `original ${file}\n`
    writeFileSync(join(source, file), text)
    writeFileSync(join(target, file), text)
    hashes[file] = sha(Buffer.from(text))
  }
  json(join(target, '.deployment.json'), { commit: oldCommit, profile: 'web', installedAt: '2026-10-17T00:00:00.000Z', files: hashes })
  writeFileSync(join(source, 'README.md'), 'updated documentation\n')
  writeFileSync(patch, '- insert:\n    - id: usage-report\n      name: ./plugins/dsh-usage-report/lib/index.js\n')
  const session = join(dshHome, 'sessions/retained.txt')
  writeFileSync(session, 'retained session fixture\n')
  const options = { source, dshHome, profile: 'web', commit: newCommit }
  try { await run({ root, source, dshHome, target, patch, session, backup, options }) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

test('deployment copies the selected version, keeps the old code, and preserves configuration and session bytes', () => fixture(async f => {
  const patchBefore = readFileSync(f.patch)
  const sessionBefore = readFileSync(f.session)
  const markerBefore = readFileSync(join(f.target, '.deployment.json'))
  prepareDeployment(f.options, f.backup)
  assert.equal(JSON.parse(readFileSync(join(f.target, '.deployment.json'))).commit, oldCommit)
  const result = await activateDeployment(f.backup)
  assert.equal(result.commit, newCommit)
  assert.equal(readFileSync(join(f.target, 'README.md'), 'utf8'), 'updated documentation\n')
  assert.deepEqual(readFileSync(join(f.backup, 'previous/.deployment.json')), markerBefore)
  assert.deepEqual(readFileSync(f.patch), patchBefore)
  assert.deepEqual(readFileSync(f.session), sessionBefore)
  assert.equal(planDeployment(f.options).unchanged, true)
}))

test('rollback restores the exact old code while retaining configuration changes made after deployment', () => fixture(async f => {
  prepareDeployment(f.options, f.backup)
  await activateDeployment(f.backup)
  writeFileSync(f.patch, '# later local configuration change\n')
  const currentPatch = readFileSync(f.patch)
  await rollbackDeployment(f.backup)
  assert.equal(JSON.parse(readFileSync(join(f.target, '.deployment.json'))).commit, oldCommit)
  assert.equal(readFileSync(join(f.target, 'README.md'), 'utf8'), 'original README.md\n')
  assert.deepEqual(readFileSync(f.patch), currentPatch)
  assert.equal(JSON.parse(readFileSync(join(f.backup, 'replaced/.deployment.json'))).commit, newCommit)
  await assert.rejects(rollbackDeployment(f.backup), /backup_not_active/)
}))

test('an import failure automatically restores the previous installation and keeps the failed candidate', () => fixture(async f => {
  const before = readFileSync(join(f.target, '.deployment.json'))
  prepareDeployment(f.options, f.backup)
  await assert.rejects(activateDeployment(f.backup, async () => { throw new Error('synthetic failure') }), /activation_failed_previous_restored/)
  assert.deepEqual(readFileSync(join(f.target, '.deployment.json')), before)
  assert.equal(JSON.parse(readFileSync(join(f.backup, 'candidate/.deployment.json'))).commit, newCommit)
}))

test('a failed rollback leaves the currently installed version in place', () => fixture(async f => {
  prepareDeployment(f.options, f.backup)
  await activateDeployment(f.backup)
  const before = readFileSync(join(f.target, '.deployment.json'))
  await assert.rejects(rollbackDeployment(f.backup, async () => { throw new Error('synthetic failure') }), /rollback_failed_current_restored/)
  assert.deepEqual(readFileSync(join(f.target, '.deployment.json')), before)
  await rollbackDeployment(f.backup)
}))

test('unknown installed files stop the update without removing or copying them', () => fixture(async f => {
  writeFileSync(join(f.target, 'local-settings.txt'), 'retain this local file\n')
  assert.throws(() => prepareDeployment(f.options, f.backup), /unknown_or_missing_installed_file/)
  assert.equal(readFileSync(join(f.target, 'local-settings.txt'), 'utf8'), 'retain this local file\n')
}))

test('locally modified installed code stops the update', () => fixture(async f => {
  writeFileSync(join(f.target, 'lib/client.js'), '// local edit\n')
  assert.throws(() => planDeployment(f.options), /installed_file_modified/)
}))

test('a concurrent configuration or installation change prevents activation', () => fixture(async f => {
  prepareDeployment(f.options, f.backup)
  writeFileSync(f.patch, '# edited after preparation\n')
  await assert.rejects(activateDeployment(f.backup), /installation_changed_during_deploy/)
  assert.equal(JSON.parse(readFileSync(join(f.target, '.deployment.json'))).commit, oldCommit)
}))

test('a changed candidate is refused before replacing the installed plugin', () => fixture(async f => {
  prepareDeployment(f.options, f.backup)
  writeFileSync(join(f.backup, 'candidate/lib/client.js'), '// changed staged file\n')
  await assert.rejects(activateDeployment(f.backup), /installed_file_modified/)
  assert.equal(JSON.parse(readFileSync(join(f.target, '.deployment.json'))).commit, oldCommit)
}))

test('rollback refuses an altered previous backup', () => fixture(async f => {
  prepareDeployment(f.options, f.backup)
  await activateDeployment(f.backup)
  writeFileSync(join(f.backup, 'previous/README.md'), 'changed\n')
  await assert.rejects(rollbackDeployment(f.backup), /installed_file_modified/)
  assert.equal(JSON.parse(readFileSync(join(f.target, '.deployment.json'))).commit, newCommit)
}))

test('linked installation directories and new unreviewed runtime files are refused', () => fixture(async f => {
  writeFileSync(join(f.source, 'lib/extra.js'), 'export const extra = true\n')
  assert.throws(() => planDeployment(f.options), /source_file_list_changed/)
  rmSync(join(f.source, 'lib/extra.js'))
  const displaced = join(f.root, 'displaced-lib')
  renameSync(join(f.target, 'lib'), displaced)
  symlinkSync(displaced, join(f.target, 'lib'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => planDeployment(f.options), /linked_path_refused/)
}))

test('backup directories inside either the source checkout or DSH home are refused', () => fixture(async f => {
  for (const parent of [f.source, f.dshHome]) {
    const nested = join(parent, 'backup')
    mkdirSync(nested)
    assert.throws(() => prepareDeployment(f.options, nested), /unsafe_backup_location/)
  }
}))

test('a commit that only changes tooling does not require replacing identical runtime files', () => fixture(async f => {
  writeFileSync(join(f.source, 'README.md'), 'original README.md\n')
  assert.equal(planDeployment(f.options).unchanged, true)
}))
