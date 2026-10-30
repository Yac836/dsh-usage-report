/** Read-only checks using Desktop's own Electron Node mode, including ASAR support. */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const executableName = 'DeepSeek Harness.exe'
const fail = code => { throw new Error(code) }

function plain(path) {
  for (let at = resolve(path); ; at = dirname(at)) {
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) fail('desktop_linked_path')
    if (dirname(at) === at) return resolve(path)
  }
}

function windowsFacts() {
  // Only executable/install paths are collected. Never read process command lines or credentials.
  const script = `$ErrorActionPreference='Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $running=@(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction Stop)
    $paths=@($running | ForEach-Object { $_.ExecutablePath } | Where-Object { $_ } | Sort-Object -Unique)
    $keys=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
    $installed=@(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DeepSeek Harness*' -and $_.InstallLocation } | ForEach-Object { Join-Path $_.InstallLocation 'DeepSeek Harness.exe' })
    @{running=$running.Count; paths=$paths; installed=$installed} | ConvertTo-Json -Compress`
  try {
    const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const facts = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (!Number.isInteger(facts.running) || !Array.isArray(facts.paths) || !Array.isArray(facts.installed)) fail('desktop_process_check_failed')
    return facts
  } catch { fail('desktop_process_check_failed') }
}

export function assertDesktopClosed(facts = windowsFacts()) {
  if (facts.running !== 0) fail('desktop_still_running')
}

export function findDesktop(explicit, facts) {
  if (explicit) {
    const selected = resolve(explicit)
    const exe = basename(selected).toLowerCase() === executableName.toLowerCase() ? selected : join(selected, executableName)
    plain(exe)
    if (!existsSync(exe) || !statSync(exe).isFile()) fail('desktop_executable_not_found')
    plain(join(dirname(exe), 'resources', 'app.asar'))
    if (!existsSync(join(dirname(exe), 'resources', 'app.asar'))) fail('desktop_archive_not_found')
    return exe
  }
  facts ??= windowsFacts()
  const running = [...new Set(facts.paths)]
  if (running.length > 1) fail('desktop_installation_ambiguous')
  if (running.length === 1) return findDesktop(running[0])
  const registered = [...new Set(facts.installed.filter(path => existsSync(path)))]
  if (registered.length > 1) fail('desktop_installation_ambiguous')
  if (registered.length === 1) return findDesktop(registered[0])
  const candidates = [...new Set([
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', executableName),
    ...(process.env.ProgramFiles ? [join(process.env.ProgramFiles, 'DeepSeek Harness', executableName)] : []),
  ].filter(path => existsSync(path)))]
  if (candidates.length !== 1) fail(candidates.length ? 'desktop_installation_ambiguous' : 'desktop_executable_not_found')
  return findDesktop(candidates[0])
}

// No app boot, apply(), profile loading, or credential reading. The import only verifies exports.
export const desktopProbe = String.raw`
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let stage = 'node';
try {
  if (!process.versions.electron) throw new Error('desktop_node_mode_required');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const archive = join(dirname(input.executable), 'resources', 'app.asar');
  const read = path => JSON.parse(readFileSync(path, 'utf8').trimStart());
  stage = 'metadata';
  const desktop = read(join(archive, 'package.json'));
  const runtime = join(archive, 'dsh');
  const anchor = pathToFileURL(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')).href;
  const core = read(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  if (desktop.name !== '@deepseek-ai/dsh-desktop' || core.name !== '@deepseek-ai/dsh' || core.version !== desktop.version) throw new Error('desktop_package_mismatch');
  const manifest = read(join(input.plugin, 'package.json'));
  if (manifest.name !== 'dsh-usage-report' || manifest.main !== 'lib/index.js') throw new Error('wrong_source_package');
  stage = 'semver';
  const semver = (await import(pathToFileURL(join(runtime, 'node_modules', 'semver', 'index.js')).href)).default;
  const peers = Object.entries(manifest.peerDependencies || {});
  stage = 'peers';
  for (const [name, range] of peers) {
    if (!new RegExp('^(?:@[a-z0-9._~-]+/)?[a-z0-9._~-]+$', 'i').test(name)) throw new Error('desktop_invalid_peer');
    const peer = read(join(runtime, 'node_modules', name, 'package.json'));
    if (peer.name !== name || !semver.satisfies(peer.version, range, {includePrerelease:true})) throw new Error('desktop_incompatible_peer');
  }
  if (input.checkPlugin) {
    stage = 'import';
    if (typeof nodeModule.registerHooks !== 'function') throw new Error('desktop_node_hooks_unavailable');
    const prefix = pathToFileURL(resolve(input.plugin) + '/').href;
    const normalized = url => process.platform === 'win32' ? url.toLowerCase() : url;
    const names = peers.map(([name]) => name);
    const hook = nodeModule.registerHooks({resolve(specifier, context, nextResolve) {
      if (context.parentURL && normalized(context.parentURL).startsWith(normalized(prefix)) && names.some(name => specifier === name || specifier.startsWith(name + '/'))) {
        return nextResolve(specifier, {...context, parentURL:anchor});
      }
      return nextResolve(specifier, context);
    }});
    try {
      const plugin = await import(pathToFileURL(join(input.plugin, 'lib/index.js')).href);
      if (typeof plugin.apply !== 'function' || plugin.Config({}).currency !== 'USD') throw new Error('desktop_plugin_exports_invalid');
    } finally { hook.deregister(); }
  }
  console.log(JSON.stringify({version:core.version, peers:peers.length, pluginChecked:input.checkPlugin}));
} catch (error) {
  const code = /^[a-z_]+$/.test(error?.message || '') ? error.message : 'desktop_' + stage + '_check_failed';
  console.log(JSON.stringify({code}));
  process.exitCode = 1;
}`

export function checkDesktop({ executable, plugin, checkPlugin = true }, launch = spawnSync) {
  executable = findDesktop(executable)
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(tmpdir(), 'dsh-desktop-import-' + randomUUID()) }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  delete environment.ELECTRON_NO_ASAR
  const result = launch(executable, ['--input-type=module', '-e', desktopProbe], {
    input: JSON.stringify({ executable, plugin: resolve(plugin), checkPlugin }),
    encoding: 'utf8', env: environment, windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024,
  })
  let info
  try { info = JSON.parse(result.stdout) } catch { fail('desktop_runtime_check_failed') }
  if (result.status !== 0) fail(/^[a-z_]+$/.test(info?.code || '') ? info.code : 'desktop_runtime_check_failed')
  if (typeof info.version !== 'string' || !Number.isInteger(info.peers) || info.pluginChecked !== checkPlugin) fail('desktop_runtime_check_failed')
  return { executable, ...info }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [plugin, explicit] = process.argv.slice(2)
    const executable = findDesktop(explicit)
    console.log(JSON.stringify(checkDesktop({ executable, plugin })))
  } catch (error) {
    const code = /^[a-z_]+$/.test(error?.message || '') ? error.message : 'desktop_runtime_check_failed'
    console.error(JSON.stringify({ code }))
    process.exitCode = 1
  }
}
