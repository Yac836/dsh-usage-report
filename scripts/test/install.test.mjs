import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planDeployment, pluginFiles } from '../sync-deploy.mjs'

const project = fileURLToPath(new URL('../../', import.meta.url))

function fixture(run) {
  const base = join(homedir(), 'codex-temp')
  mkdirSync(base, { recursive: true })
  const temp = mkdtempSync(join(base, 'dsh-installer-test-'))
  const source = join(temp, 'source with spaces')
  const home = join(temp, 'isolated home')
  const patch = join(home, 'profiles/web/cordis.patch.yml')
  const target = join(dirname(patch), 'plugins/dsh-usage-report')
  try {
    for (const file of [...pluginFiles, 'scripts/install.mjs', 'scripts/sync-deploy.mjs', 'scripts/sync-deploy.ps1', 'scripts/desktop-runtime.mjs']) {
      mkdirSync(dirname(join(source, file)), { recursive: true })
      copyFileSync(join(project, file), join(source, file))
    }
    const git = (...args) => execFileSync('git', args, { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
    git('init', '--quiet')
    git('config', 'user.name', 'Installer fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('add', '.')
    git('commit', '--quiet', '-m', 'Synthetic installer fixture')
    git('remote', 'add', 'origin', 'https://github.com/Yac836/dsh-usage-report.git')
    mkdirSync(dirname(patch), { recursive: true })
    writeFileSync(patch, '# preserved synthetic configuration\n[]\n')
    const invoke = args => spawnSync(process.execPath, ['scripts/install.mjs', ...args], {
      cwd: source, encoding: 'utf8', env: { ...process.env, DSH_HOME: home },
    })
    run({ source, home, patch, target, temp, invoke, commit: git('rev-parse', 'HEAD') })
    assert.equal(readFileSync(patch, 'utf8'), '# preserved synthetic configuration\n[]\n')
  } finally {
    // Only this newly created fixture is owned by the test.
    assert.equal(dirname(resolve(temp)), resolve(base))
    assert.match(temp.slice(base.length + 1), /^dsh-installer-test-/)
    rmSync(temp, { recursive: true, force: true })
  }
}

test('invalid installer arguments fail without creating an installation or exposing values', () => fixture(f => {
  for (const args of [
    ['--chek'], ['--dry-run'], ['--check', 'false'], ['unexpected-positional'],
    ['--dsh'], ['--profile'], ['--dsh', '--check'], ['--profile', '--check'],
    ['--dsh='], ['--profile='], ['--check=false'], ['--check', '--check'],
    ['--profile', 'web', '--profile', 'other'], ['--dsh', f.home, '--dsh', f.home],
    ['--help', '--unknown'], ['--unknown=SYNTHETIC_PRIVATE_ARGUMENT'],
    ['--desktop'], ['--desktop='], ['--desktop', '--check'],
  ]) {
    const result = f.invoke(args)
    assert.equal(result.status, 1, JSON.stringify(args))
    assert.match(result.stderr, /invalid arguments/)
    assert.equal(result.stderr.includes('SYNTHETIC_PRIVATE_ARGUMENT'), false)
    assert.equal(existsSync(targetPlugins(f)), false)
  }
}))

const targetPlugins = f => dirname(f.target)

test('help exits without requiring an installed DSH home', () => fixture(f => {
  const result = f.invoke(['--dsh', join(f.temp, 'missing'), '--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage:/)
  assert.equal(existsSync(targetPlugins(f)), false)
}))

test('check validates paths containing spaces without writing plugin files', () => fixture(f => {
  const result = f.invoke(['--dsh', f.home, '--profile=web', '--check'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /dry run/)
  assert.equal(existsSync(targetPlugins(f)), false)
}))

test('valid installation produces an updater-compatible manifest and refuses a second install', () => fixture(f => {
  const result = f.invoke(['--dsh', f.home, '--profile', 'web'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(planDeployment({ source: f.source, dshHome: f.home, commit: f.commit }).unchanged, true)
  const marker = readFileSync(join(f.target, '.deployment.json'))
  assert.equal(f.invoke([]).status, 1)
  assert.deepEqual(readFileSync(join(f.target, '.deployment.json')), marker)
}))

test('Windows updater CheckOnly succeeds when GitHub CLI is unavailable', { skip: process.platform !== 'win32' }, () => fixture(f => {
  assert.equal(f.invoke([]).status, 0)
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', `
    $ErrorActionPreference = 'Stop'
    function Get-Command {
      [CmdletBinding()]param([string]$Name, $CommandType)
      if ($Name -eq 'gh') { throw 'GitHub CLI is unavailable in this fixture.' }
      Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
    }
    & $env:DSH_TEST_SCRIPT -CheckOnly -DshHome $env:DSH_HOME -BackupRoot $env:DSH_TEST_BACKUP
  `], {
    cwd: f.source, encoding: 'utf8',
    env: { ...process.env, DSH_HOME: f.home,
      DSH_TEST_SCRIPT: join(f.source, 'scripts/sync-deploy.ps1'), DSH_TEST_BACKUP: join(f.temp, 'backups') },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /Checks passed/)
  assert.equal(existsSync(join(f.temp, 'backups')), false)
}))
