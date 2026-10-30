import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertDesktopClosed, checkDesktop, desktopProbe, findDesktop } from '../desktop-runtime.mjs'

// The real probe runs under Desktop's bundled Node, not the caller's Node 20.
const lacksDesktopHooks = typeof nodeModule.registerHooks !== 'function'

function fixture(run) {
  const base = join(homedir(), 'codex-temp')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'dsh-desktop-test-'))
  const install = join(root, 'custom Desktop installation')
  const executable = join(install, 'DeepSeek Harness.exe')
  const archive = join(install, 'resources/app.asar')
  const runtime = join(archive, 'dsh')
  const plugin = join(root, 'independent home/profiles/desktop/plugins/dsh-usage-report')
  const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
  const json = (file, value) => put(file, JSON.stringify(value))
  const coreFile = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json')
  const peerFile = join(runtime, 'node_modules/@deepseek-ai/schemastery/package.json')
  put(executable, 'synthetic executable placeholder; never executed')
  json(join(archive, 'package.json'), { name: '@deepseek-ai/dsh-desktop', version: '1.0.0' })
  json(coreFile, { name: '@deepseek-ai/dsh', version: '1.0.0' })
  json(peerFile, { name: '@deepseek-ai/schemastery', version: '1.0.0', type: 'module', exports: './index.js' })
  put(join(dirname(peerFile), 'index.js'), 'export const bundled = true\n')
  // A minimal semver fixture; the real Desktop probe uses Desktop's bundled semver.
  put(join(runtime, 'node_modules/semver/index.js'), 'module.exports = {satisfies: (version, range) => version === range}\n')
  json(join(plugin, 'package.json'), { name: 'dsh-usage-report', main: 'lib/index.js', type: 'module', peerDependencies: { '@deepseek-ai/schemastery': '1.0.0' } })
  put(join(plugin, 'lib/index.js'), `import {bundled} from '@deepseek-ai/schemastery';
    export const apply = () => {throw new Error('apply must never run during a check')};
    export const Config = () => ({currency: bundled ? 'USD' : 'INVALID'});`)
  const probe = (changes = {}) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'Object.defineProperty(process.versions, "electron", {value:"fixture"});\n' + desktopProbe], {
      input: JSON.stringify({ executable, plugin, checkPlugin: true, ...changes }), encoding: 'utf8',
      env: { ...process.env, DSH_HOME: join(root, 'unused check home') },
    })
    return { ...result, info: JSON.parse(result.stdout) }
  }
  try { run({ root, install, executable, archive, runtime, plugin, peerFile, coreFile, put, json, probe }) }
  finally {
    assert.equal(dirname(resolve(root)), resolve(base))
    assert.match(root.slice(base.length + 1), /^dsh-desktop-test-/)
    rmSync(root, { recursive: true, force: true })
  }
}

test('custom Desktop installation directories and executable paths resolve without shared CLI packages', () => fixture(f => {
  assert.equal(findDesktop(f.install), f.executable)
  assert.equal(findDesktop(f.executable), f.executable)
  assert.equal(findDesktop(undefined, { paths: [f.executable], installed: [] }), f.executable)
  assert.equal(findDesktop(undefined, { paths: [], installed: [f.executable] }), f.executable)
  assert.throws(() => findDesktop(undefined, { paths: [f.executable, 'another Desktop'], installed: [] }), /ambiguous/)
  assert.throws(() => findDesktop(join(f.root, 'missing')), /not_found/)
}))

test('Desktop must be fully closed before writes, regardless of the selected HTTP port', () => {
  assert.doesNotThrow(() => assertDesktopClosed({ running: 0 }))
  assert.throws(() => assertDesktopClosed({ running: 1 }), /desktop_still_running/)
})

test('Desktop probe loads bundled peers for an external plugin without applying it', { skip: lacksDesktopHooks }, () => fixture(f => {
  const result = f.probe()
  assert.equal(result.status, 0, result.stdout)
  assert.deepEqual(result.info, { version: '1.0.0', peers: 1, pluginChecked: true })
}))

test('Desktop probe ignores unrelated CLI peers under the data home', { skip: lacksDesktopHooks }, () => fixture(f => {
  const poison = join(f.plugin, 'node_modules/@deepseek-ai/schemastery')
  f.json(join(poison, 'package.json'), { name: '@deepseek-ai/schemastery', type: 'module', exports: './index.js' })
  f.put(join(poison, 'index.js'), 'throw new Error("unrelated CLI package must not load")')
  assert.equal(f.probe().status, 0)
}))

test('mismatched Desktop package versions and incompatible peers fail before importing plugin code', () => fixture(f => {
  f.json(f.coreFile, { name: '@deepseek-ai/dsh', version: '0.9.0' })
  assert.equal(f.probe().info.code, 'desktop_package_mismatch')
  f.json(f.coreFile, { name: '@deepseek-ai/dsh', version: '1.0.0' })
  f.json(f.peerFile, { name: '@deepseek-ai/schemastery', version: '0.9.0' })
  assert.equal(f.probe().info.code, 'desktop_incompatible_peer')
}))

test('plugin import diagnostics never echo raw exception messages', { skip: lacksDesktopHooks }, () => fixture(f => {
  f.put(join(f.plugin, 'lib/index.js'), 'throw new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC")')
  const result = f.probe()
  assert.equal(result.status, 1)
  assert.equal(result.info.code, 'desktop_import_check_failed')
  assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'), false)
}))

test('Electron checks are bounded, hidden, use isolated data paths and discard launch diagnostics', () => fixture(f => {
  const result = checkDesktop({ executable: f.executable, plugin: f.plugin }, (exe, args, options) => {
    assert.equal(exe, f.executable)
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
    assert.notEqual(options.env.DSH_HOME, process.env.DSH_HOME)
    assert.equal(options.env.NODE_OPTIONS, undefined)
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 30_000)
    return { status: 0, stdout: JSON.stringify({ version: '1.0.0', peers: 1, pluginChecked: true }) }
  })
  assert.equal(result.version, '1.0.0')
  assert.throws(() => checkDesktop({ executable: f.executable, plugin: f.plugin }, () => ({ status: 1, stdout: '', stderr: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' })), /^Error: desktop_runtime_check_failed$/)
}))
