/**
 * @local/dsh-ian-daemon — Host half.
 *
 * Gives DeepSeek Harness three things it does not ship with:
 *
 *  1. **Boot autostart.** A systemd *user* service (`dsh-ian-daemon.service`) runs a
 *     generated supervisor script at login/boot. Enabling it needs no root; for
 *     it to start without an interactive login the user must linger, which this
 *     plugin also arranges (`loginctl enable-linger`).
 *  2. **Crash / corruption self-recovery.** The supervisor validates the composed
 *     profile config before every start (restoring the last known-good snapshot
 *     when it is broken), measures how long each run stayed up, and counts rapid
 *     failures in a rolling window. After `failureThreshold` of them it boots the
 *     pristine safe profile, writes an incident report and notifies the desktop.
 *     systemd adds a second layer: if the supervisor itself keeps dying, the
 *     unit's `OnFailure=` starts `dsh-ian-daemon-safemode.service`.
 *  3. **A manual restart button.** The Client half renders "重启" in the composer
 *     dock and calls this half over HTTP.
 *
 * Everything is plain JavaScript over node builtins: the bundle declares no
 * dependency, so it activates in any profile that installs it.
 *
 * Host entry points (`POST`/`GET /dsh-ian-daemon/...`):
 *   GET  status      full state snapshot (systemd, supervisor, incident, paths)
 *   POST restart     restart now (systemd when managed, detached relaunch else)
 *   POST install     (re)write the supervisor/units, daemon-reload, enable
 *   POST uninstall   disable and remove the units (reports are kept)
 *   POST repair      run the config integrity check/restore immediately
 *   POST reset       clear safe mode (+ optional restart)
 *   POST selftest    prove this session can start/stop a systemd unit
 *   GET  log         text tail of the supervisor log
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync, unlinkSync, copyFileSync, cpSync, renameSync, statSync, openSync, readSync, closeSync, chmodSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_NAME = '@local/dsh-ian-daemon'
const ROUTE_PREFIX = '/dsh-ian-daemon'

const SYSTEMD_DEST = 'org.freedesktop.systemd1'
const MANAGER_PATH = '/org/freedesktop/systemd1'
const MANAGER_IFACE = 'org.freedesktop.systemd1.Manager'
const UNIT_IFACE = 'org.freedesktop.systemd1.Unit'

/** `systemctl --user` is unusable in namespaced/restricted sessions; the same manager answers on D-Bus. */
const BUS_UNREACHABLE = /Failed to connect|Cannot autolaunch|Failed to talk to init daemon|Connection refused|No such file or directory|没有可用的数据|无法连接|拒绝连接/i

/**
 * Every generated file carries one of these markers. The legacy one is kept so
 * the rename from the project's former name (dsh-autostart) never mistakes its
 * own older files for a foreign unit it must not touch.
 */
const GENERATED_MARKERS = ['@local/dsh-ian-daemon', '@local/dsh-autostart']

/** Filesystem copies that make a profile composable; they are what "corruption" means here. */
const CONFIG_FILES = ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']

// ---------------------------------------------------------------------------
// generic helpers
// ---------------------------------------------------------------------------

/** Run a command, capturing output; never rejects. */
function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000
  const env = options.env ?? process.env
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), failed: true })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ code: -2, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]`, failed: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish({ code: -1, stdout, stderr: String(error?.message ?? error), failed: true }))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr, failed: false }))
  })
}

function readText(path, fallback = undefined) {
  try { return readFileSync(path, 'utf8') } catch { return fallback }
}

function writeIfChanged(path, content, mode) {
  const current = readText(path)
  if (current === content) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  if (mode !== undefined) {
    try { chmodSync(path, mode) } catch { /* best effort on odd filesystems */ }
  }
  return true
}

function ensureDir(path) {
  try { mkdirSync(path, { recursive: true }) } catch { /* reported by the caller's next write */ }
}

/** Replace `@@TOKEN@@` placeholders in a shipped template. */
function render(template, values) {
  return template.replace(/@@([A-Z_]+)@@/g, (match, key) => {
    const value = values[key]
    if (value === undefined) return match
    return String(value).replace(/[\r\n]+/g, ' ')
  })
}

function template(name) {
  const path = join(PACKAGE_DIR, name)
  const text = readText(path)
  if (text === undefined) throw new Error(`${PKG_NAME}: shipped template is missing: ${path}`)
  return text
}

function expandHome(value, home) {
  const text = String(value)
  if (text === '~') return home
  if (text.startsWith('~/')) return join(home, text.slice(2))
  return text
}

function asString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asNumber(value, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** `/proc/self/cgroup` names the unit that owns this process, when systemd owns it. */
function selfCgroup() {
  try { return readFileSync('/proc/self/cgroup', 'utf8') } catch { return '' }
}

/**
 * Locate the `dsh` entry script to bake into the generated unit.
 *
 * The launcher is often a shim (`dsh`, or an fnm multishell symlink under
 * `/run/user/...`) whose target is what survives a reboot, so symlinks are
 * resolved first; a plain path is accepted when nothing resolved to `bin.js`.
 * Exported because this is the one piece of the plugin that depends on how the
 * running Harness was launched, and it is worth unit-testing.
 *
 * @param {string[]} argv - a `process.argv`-shaped array.
 * @param {string} [explicitPath] - the configured `cliPath`, used first and as the last resort.
 * @returns {string} an existing path, or the explicit value when nothing resolved.
 */
export function resolveDshCli(argv, explicitPath = '') {
  if (typeof explicitPath === 'string' && explicitPath !== '' && existsSync(explicitPath)) return explicitPath
  const resolved = []
  for (const candidate of (Array.isArray(argv) ? argv : []).slice(1)) {
    if (typeof candidate !== 'string' || candidate === '' || !candidate.includes('/')) continue
    try { resolved.push(realpathSync(candidate)) } catch { resolved.push(candidate) }
  }
  for (const candidate of resolved) {
    if (/(^|[/\\])bin\.js$/.test(candidate) && existsSync(candidate)) return candidate
  }
  for (const candidate of resolved) {
    if (/(^|[/\\])(dsh|dsh\.js)$/.test(candidate) && existsSync(candidate)) return candidate
  }
  return typeof explicitPath === 'string' ? explicitPath : ''
}

function tailFile(path, lines, maxBytes = 128 * 1024) {
  try {
    const size = statSync(path).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    const fd = openSync(path, 'r')
    try { readSync(fd, buffer, 0, length, size - length) } finally { closeSync(fd) }
    const text = buffer.toString('utf8')
    const parts = text.split('\n')
    return parts.slice(Math.max(0, parts.length - lines - 1)).join('\n')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// systemd access: `systemctl --user` first, D-Bus (`busctl --user`) as fallback
// ---------------------------------------------------------------------------

/**
 * Run `systemctl --user ...`; resolves to `null` when the tool exists but the
 * user manager cannot be reached over the local transport, which is the signal
 * to retry the same operation on D-Bus.
 */
async function systemctl(args) {
  const result = await run('systemctl', ['--user', ...args])
  if (result.failed || BUS_UNREACHABLE.test(result.stderr)) return null
  return result
}

/** `busctl --user call <manager> <method> [signature args...]`. */
async function managerCall(method, signature = '', args = []) {
  const argv = ['--user', 'call', SYSTEMD_DEST, MANAGER_PATH, MANAGER_IFACE, method]
  if (signature !== '') argv.push(signature, ...args)
  return await run('busctl', argv)
}

async function busProperty(objectPath, iface, property) {
  return await run('busctl', ['--user', 'get-property', SYSTEMD_DEST, objectPath, iface, property])
}

/** Pull the first `"quoted"` value (string or object path) out of busctl output. */
function busString(text) {
  const match = /"([^"]*)"/.exec(String(text ?? ''))
  return match === null ? undefined : match[1]
}

function busBoolean(text) {
  const match = /\b(true|false|yes|no)\b/.exec(String(text ?? ''))
  return match === null ? undefined : match[1] === 'true' || match[1] === 'yes'
}

/** Unit object path on the manager (`dsh-ian-daemon.service` → `/org/.../unit/dsh_2dharness_2eservice`). */
async function unitObjectPath(unit) {
  const reply = await managerCall('GetUnit', 's', [unit])
  if (reply.code !== 0) return undefined
  return busString(reply.stdout)
}

// ---------------------------------------------------------------------------
// manager
// ---------------------------------------------------------------------------

export function createManager(ctx, rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const home = homedir()
  const dshHome = expandHome(asString(config.dshHome, process.env.DSH_HOME || join(home, '.dsh')), home)
  const homeDir = expandHome(asString(config.homeDir, ''), home) || join(dshHome, 'ian-daemon')
  const userName = (() => { try { return userInfo().username } catch { return process.env.USER || '' } })()

  const settings = {
    unitName: asString(config.unitName, 'dsh-ian-daemon.service'),
    safeUnitName: asString(config.safeUnitName, 'dsh-ian-daemon-safemode.service'),
    selfTestUnit: asString(config.selfTestUnit, 'dsh-ian-daemon-selftest.service'),
    profile: asString(config.profile, process.env.DSH_PROFILE || 'web'),
    safeProfile: asString(config.safeProfile, 'dsh-safe'),
    safeTemplate: asString(config.safeTemplate, process.env.DSH_PROFILE || 'web'),
    unitDir: expandHome(asString(config.unitDir, join(home, '.config', 'systemd', 'user')), home),
    port: asNumber(config.port, 0),
    host: asString(config.host, ''),
    extraAppArgs: Array.isArray(config.extraAppArgs) ? config.extraAppArgs.map(String) : [],
    failureWindowSeconds: asNumber(config.failureWindowSeconds, 600),
    failureThreshold: Math.max(2, asNumber(config.failureThreshold, 3)),
    healthySeconds: asNumber(config.healthySeconds, 120),
    maxBackoffSeconds: asNumber(config.maxBackoffSeconds, 120),
    installOnActivate: asBoolean(config.installOnActivate, true),
    startAtBoot: asBoolean(config.startAtBoot, true),
    enableLinger: asBoolean(config.enableLinger, true),
    notify: asBoolean(config.notify, true),
    nodeBin: asString(config.nodeBin, process.execPath),
    cliPath: expandHome(asString(config.cliPath, ''), home),
    // Names this project used before it was called dsh-ian-daemon. They are
    // migrated away automatically on install (see migrateLegacy).
    legacyUnitNames: Array.isArray(config.legacyUnitNames)
      ? config.legacyUnitNames.map(String)
      : ['dsh-harness.service', 'dsh-harness-safemode.service', 'dsh-autostart-selftest.service'],
    legacyHomeDir: expandHome(asString(config.legacyHomeDir, ''), home) || join(dshHome, 'autostart'),
  }

  const paths = {
    homeDir,
    binDir: join(homeDir, 'bin'),
    supervisor: join(homeDir, 'bin', 'supervisor.sh'),
    relaunch: join(homeDir, 'bin', 'relaunch.sh'),
    stateDir: join(homeDir, 'state'),
    reportDir: join(homeDir, 'reports'),
    logDir: join(homeDir, 'logs'),
    backupDir: join(homeDir, 'backup'),
    supervisorLog: join(homeDir, 'logs', 'supervisor.log'),
    dshLog: join(homeDir, 'logs', 'dsh.out.log'),
    profileDir: join(dshHome, 'profiles', settings.profile),
  }

  /** Resolved by the launcher only after the whole tree mounted: the shell's
   * `/api` route is registered after that, so a reload before it cannot connect. */
  let readiness = { ready: false, at: undefined }

  function watchReadiness() {
    const service = typeof ctx.get === 'function' ? ctx.get('appReady') : undefined
    if (service === undefined || typeof service.onReady !== 'function') {
      readiness = { ready: true, at: new Date().toISOString(), absent: true }
      return
    }
    try {
      service.onReady(() => { readiness = { ready: true, at: new Date().toISOString() } })
    } catch (error) {
      readiness = { ready: true, at: new Date().toISOString(), error: String(error?.message ?? error) }
    }
  }

  const logger = ctx.logger ?? console
  let activated = false
  let disposed = false
  let livePort = 0
  let cachedBackend

  function info(message) {
    try { logger.info?.(`${PKG_NAME}: ${message}`) } catch { /* logging must never break the plugin */ }
  }

  function warn(message) {
    try { logger.warn?.(`${PKG_NAME}: ${message}`) } catch { /* ignore */ }
  }

  // --- command lines -------------------------------------------------------

  function resolveCliPath() {
    // The launcher may be a shim (`dsh`) symlinking to lib/bin.js, and an fnm
    // multishell symlink disappears with its shell: resolve the real target.
    return resolveDshCli(process.argv, settings.cliPath)
  }

  function appArgs() {
    const args = ['--no-open']
    const port = livePort || settings.port
    if (port > 0) args.push('--port', String(port))
    if (settings.host !== '') args.push('--host', settings.host)
    args.push(...settings.extraAppArgs)
    return args
  }

  function nodeBin() {
    if (existsSync(settings.nodeBin)) return settings.nodeBin
    // The fnm-installed node path is version-pinned; survive an upgrade by
    // falling back to another installed version before any system node.
    const candidates = []
    try {
      const root = join(home, '.local', 'share', 'fnm', 'node-versions')
      for (const entry of readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        candidates.push(join(root, entry, 'installation', 'bin', 'node'))
      }
    } catch { /* fnm is not installed */ }
    candidates.push('/usr/bin/node', '/usr/local/bin/node')
    for (const candidate of candidates) if (existsSync(candidate)) return candidate
    return settings.nodeBin
  }

  function templateValues() {
    return {
      HOME_DIR: paths.homeDir,
      NODE_BIN: nodeBin(),
      DSH_CLI: resolveCliPath(),
      DSH_HOME: dshHome,
      PROFILE: settings.profile,
      SAFE_PROFILE: settings.safeProfile,
      SAFE_TEMPLATE: settings.safeTemplate,
      APP_ARGS: appArgs().join(' '),
      UNIT_NAME: settings.unitName,
      SAFE_UNIT: settings.safeUnitName,
      MAIN_UNIT: settings.unitName,
      FAIL_WINDOW: settings.failureWindowSeconds,
      FAIL_THRESHOLD: settings.failureThreshold,
      HEALTHY_SECONDS: settings.healthySeconds,
      MAX_BACKOFF: settings.maxBackoffSeconds,
      NOTIFY: settings.notify ? 1 : 0,
      PATH: `${dirname(nodeBin())}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    }
  }

  // --- systemd operations --------------------------------------------------

  async function backend() {
    if (cachedBackend !== undefined) return cachedBackend
    const probe = await systemctl(['is-system-running'])
    if (probe !== null) {
      cachedBackend = 'systemctl'
      return cachedBackend
    }
    const bus = await run('busctl', ['--user', 'get-property', SYSTEMD_DEST, MANAGER_PATH, MANAGER_IFACE, 'Version'])
    cachedBackend = bus.code === 0 ? 'busctl' : 'none'
    return cachedBackend
  }

  async function daemonReload() {
    const direct = await systemctl(['daemon-reload'])
    if (direct !== null && direct.code === 0) return { ok: true, via: 'systemctl' }
    const bus = await managerCall('Reload')
    if (bus.code === 0) return { ok: true, via: 'busctl' }
    return { ok: false, via: 'none', error: (direct?.stderr || bus.stderr || '').trim() }
  }

  async function unitVerb(verb, unit) {
    const direct = await systemctl([verb === 'StartUnit' ? 'start' : verb === 'StopUnit' ? 'stop' : 'restart', unit])
    if (direct !== null) {
      return { ok: direct.code === 0, via: 'systemctl', error: direct.stderr.trim() }
    }
    const bus = await managerCall(verb, 'ss', [unit, 'replace'])
    return { ok: bus.code === 0, via: 'busctl', error: bus.stderr.trim() }
  }

  async function activeState(unit) {
    const direct = await systemctl(['is-active', unit])
    if (direct !== null) {
      const state = direct.stdout.trim() || (direct.code === 0 ? 'active' : 'inactive')
      return { state, via: 'systemctl' }
    }
    const objectPath = await unitObjectPath(unit)
    if (objectPath === undefined) return { state: 'unknown', via: 'busctl' }
    const reply = await busProperty(objectPath, UNIT_IFACE, 'ActiveState')
    return { state: busString(reply.stdout) ?? 'unknown', via: 'busctl' }
  }

  async function mainPid(unit) {
    const direct = await systemctl(['show', unit, '-p', 'MainPID'])
    if (direct !== null) {
      const match = /MainPID=(\d+)/.exec(direct.stdout)
      return match === null ? undefined : Number.parseInt(match[1], 10)
    }
    const objectPath = await unitObjectPath(unit)
    if (objectPath === undefined) return undefined
    const reply = await busProperty(objectPath, UNIT_IFACE, 'MainPID')
    const match = /(\d+)/.exec(reply.stdout)
    return match === null ? undefined : Number.parseInt(match[1], 10)
  }

  function unitPath(unit) { return join(settings.unitDir, unit) }

  function wantsPath(unit) { return join(settings.unitDir, 'default.target.wants', unit) }

  function isInstalled(unit) { return existsSync(unitPath(unit)) }

  function isEnabled(unit) {
    try { return lstatSync(wantsPath(unit)).isSymbolicLink() } catch { return false }
  }

  function enable(unit) {
    ensureDir(dirname(wantsPath(unit)))
    if (isEnabled(unit)) return false
    try {
      symlinkSync(join('..', unit), wantsPath(unit))
      return true
    } catch (error) {
      warn(`could not create ${wantsPath(unit)}: ${error?.message ?? error}`)
      return false
    }
  }

  function disable(unit) {
    try {
      if (isEnabled(unit)) { unlinkSync(wantsPath(unit)); return true }
    } catch (error) {
      warn(`could not remove ${wantsPath(unit)}: ${error?.message ?? error}`)
    }
    return false
  }

  async function lingerEnabled() {
    const result = await run('loginctl', ['show-user', userName, '-p', 'Linger'])
    if (result.code !== 0) return undefined
    return /Linger=yes/.test(result.stdout)
  }

  async function enableLinger() {
    const current = await lingerEnabled()
    if (current === true) return { ok: true, changed: false }
    const result = await run('loginctl', ['enable-linger', userName])
    const after = await lingerEnabled()
    return {
      ok: after === true,
      changed: after === true,
      error: result.code === 0 ? undefined : (result.stderr || result.stdout).trim(),
    }
  }

  // --- install / uninstall -------------------------------------------------

  function writeSupervisor() {
    const values = templateValues()
    const script = render(template('supervisor.sh'), values)
    const helper = template('relaunch.sh')
    const changed = []
    if (writeIfChanged(paths.supervisor, script, 0o755)) changed.push('supervisor.sh')
    if (writeIfChanged(paths.relaunch, helper, 0o755)) changed.push('relaunch.sh')
    return changed
  }

  function writeUnits() {
    const values = templateValues()
    const changed = []
    const main = render(template('units/dsh-ian-daemon.service.in'), values)
    const safe = render(template('units/dsh-ian-daemon-safemode.service.in'), values)
    if (writeIfChanged(unitPath(settings.unitName), main, 0o644)) changed.push(settings.unitName)
    if (writeIfChanged(unitPath(settings.safeUnitName), safe, 0o644)) changed.push(settings.safeUnitName)
    return changed
  }

  function isGeneratedUnit(unit) {
    const text = readText(unitPath(unit))
    return text !== undefined && GENERATED_MARKERS.some((marker) => text.includes(marker))
  }

  function migrateForeignUnit() {
    // Never silently adopt a unit this plugin did not write.
    const existing = readText(unitPath(settings.unitName))
    if (existing === undefined) return []
    if (GENERATED_MARKERS.some((marker) => existing.includes(marker))) return []
    const suffix = '.pre-dsh-ian-daemon'
    if (existsSync(`${unitPath(settings.unitName)}${suffix}`)) return []
    try {
      copyFileSync(unitPath(settings.unitName), `${unitPath(settings.unitName)}${suffix}`)
      return [`a unit file already existed and was kept as ${settings.unitName}${suffix}`]
    } catch (error) {
      return [`a foreign ${settings.unitName} exists and could not be backed up: ${error?.message ?? error}`]
    }
  }

  /**
   * One-shot migration from the project's former name: carry the data directory
   * over and retire the units it used to install. Only units this project wrote
   * (marker check) are touched, and the new unit is written and enabled by
   * install() around this call, so no boot is ever left without an owner.
   */
  function migrateLegacy() {
    const done = []
    const legacy = settings.legacyHomeDir
    if (legacy !== homeDir && existsSync(legacy) && !existsSync(homeDir)) {
      try {
        try {
          renameSync(legacy, homeDir)
        } catch (error) {
          // rename() cannot cross filesystems; copy+delete is the fallback.
          if (existsSync(homeDir)) throw error
          cpSync(legacy, homeDir, { recursive: true })
          rmSync(legacy, { recursive: true, force: true })
        }
        done.push(`moved ${legacy} -> ${homeDir}`)
      } catch (error) {
        warn(`could not move ${legacy} to ${homeDir}: ${error?.message ?? error}`)
      }
    }
    for (const unit of settings.legacyUnitNames) {
      if (unit === settings.unitName || unit === settings.safeUnitName) continue
      try {
        if (!isInstalled(unit)) continue
        if (!isGeneratedUnit(unit)) {
          done.push(`left ${unit} alone (not written by this project)`)
          continue
        }
        if (isEnabled(unit)) {
          disable(unit)
          done.push(`disabled ${unit}`)
        }
        rmSync(unitPath(unit))
        done.push(`removed ${unit}`)
      } catch (error) {
        warn(`could not retire ${unit}: ${error?.message ?? error}`)
      }
    }
    if (done.length > 0) info(`migrated from the former name: ${done.join('; ')}`)
    return done
  }

  async function install({ start = false, linger = true } = {}) {
    const result = { ok: true, backend: await backend(), changed: [], warnings: [], steps: [] }
    const finish = (value) => {
      // Keep the last outcome so /status can explain why autostart is not ready.
      try {
        ensureDir(paths.stateDir)
        writeFileSync(join(paths.stateDir, 'install.json'), `${JSON.stringify({
          at: new Date().toISOString(),
          ok: value.ok === true,
          error: value.error,
          changed: value.changed,
          backend: value.backend,
        }, null, 2)}\n`, 'utf8')
      } catch { /* reporting is best effort */ }
      return value
    }
    // Retire the names this project used before it was renamed. This runs
    // BEFORE any directory is created, otherwise the new home would already
    // exist and the legacy data could not be moved into it.
    result.migrated = migrateLegacy()
    try {
      ensureDir(paths.binDir)
      ensureDir(paths.stateDir)
      ensureDir(paths.reportDir)
      ensureDir(paths.logDir)
      ensureDir(paths.backupDir)
      ensureDir(settings.unitDir)
    } catch (error) {
      return finish({ ok: false, error: `cannot create the autostart directories: ${error?.message ?? error}` })
    }

    result.warnings.push(...migrateForeignUnit())
    // A unit whose ExecStart expands to nothing LOOKS installed while never
    // starting (`node ""` even exits 0), so refuse to write one.
    if (resolveCliPath() === '') {
      return finish({ ok: false, error: 'the dsh CLI path could not be resolved; set config.cliPath explicitly' })
    }
    if (!existsSync(nodeBin())) {
      return finish({ ok: false, error: `the node binary does not exist: ${nodeBin()}; set config.nodeBin explicitly` })
    }
    try {
      result.changed.push(...writeSupervisor(), ...writeUnits())
    } catch (error) {
      return finish({ ok: false, error: `cannot write the supervisor/units: ${error?.message ?? error}` })
    }

    if (result.changed.length > 0 || result.migrated.length > 0) {
      const reload = await daemonReload()
      result.steps.push({ step: 'daemon-reload', ...reload })
      if (!reload.ok) {
        result.ok = false
        result.warnings.push(`systemd did not reload its units: ${reload.error || 'unknown error'}`)
      }
    }

    if (settings.startAtBoot) {
      if (enable(settings.unitName)) result.steps.push({ step: 'enable', unit: settings.unitName, ok: true })
      result.enabled = isEnabled(settings.unitName)
    } else {
      result.enabled = false
    }

    if (linger && settings.enableLinger) {
      const lingerResult = await enableLinger()
      result.steps.push({ step: 'linger', ...lingerResult })
      result.linger = lingerResult.ok
      if (!lingerResult.ok) {
        result.warnings.push('loginctl could not enable lingering, so the service starts at login rather than at boot')
      }
    }

    if (start && !isManagedByUnit()) {
      const started = await unitVerb('StartUnit', settings.unitName)
      result.steps.push({ step: 'start', unit: settings.unitName, ...started })
      if (!started.ok) result.ok = false
    }

    result.paths = { ...paths, unit: unitPath(settings.unitName), safeUnit: unitPath(settings.safeUnitName) }
    result.health = healthStatus()
    return finish(result)
  }

  async function uninstall({ purge = false } = {}) {
    const result = { ok: true, warnings: [], steps: [] }
    if (isManagedByUnit()) {
      result.warnings.push('this process is the running service; it keeps running until it exits or the unit is stopped')
    }
    if (isEnabled(settings.unitName)) {
      disable(settings.unitName)
      result.steps.push({ step: 'disable', unit: settings.unitName, ok: true })
    }
    for (const unit of [settings.unitName, settings.safeUnitName, settings.selfTestUnit]) {
      try {
        if (isInstalled(unit)) { rmSync(unitPath(unit)); result.steps.push({ step: 'remove', unit, ok: true }) }
      } catch (error) {
        result.ok = false
        result.warnings.push(`could not remove ${unit}: ${error?.message ?? error}`)
      }
    }
    const reload = await daemonReload()
    result.steps.push({ step: 'daemon-reload', ...reload })
    if (!reload.ok) result.ok = false
    if (purge) {
      try {
        rmSync(join(homeDir, 'bin'), { recursive: true, force: true })
        result.steps.push({ step: 'purge-scripts', ok: true })
      } catch (error) {
        result.warnings.push(`could not remove ${join(homeDir, 'bin')}: ${error?.message ?? error}`)
      }
    }
    result.paths = paths
    return result
  }

  // --- integrity check / repair -------------------------------------------

  async function composeCheck() {
    const cli = resolveCliPath()
    if (cli === '') return { ok: false, error: 'the dsh CLI path could not be resolved; set config.cliPath' }
    const result = await run(nodeBin(), [cli, '--profile', settings.profile, '--dump-config'], { timeoutMs: 60000 })
    return { ok: result.code === 0, error: result.code === 0 ? undefined : tailText(result.stderr, 400) }
  }

  function tailText(text, length) {
    const value = String(text ?? '').trim()
    return value.length > length ? `…${value.slice(-length)}` : value
  }

  function snapshotConfig() {
    ensureDir(paths.backupDir)
    const copied = []
    for (const file of CONFIG_FILES) {
      const source = join(paths.profileDir, file)
      if (!existsSync(source)) continue
      try {
        copyFileSync(source, join(paths.backupDir, file))
        copied.push(file)
      } catch { /* a single unreadable file must not abort the rest */ }
    }
    if (copied.length > 0) {
      try { writeFileSync(join(paths.backupDir, '.snapshot-at'), new Date().toISOString(), 'utf8') } catch { /* ignore */ }
    }
    return copied
  }

  function restoreConfig() {
    const restored = []
    for (const file of CONFIG_FILES) {
      const backup = join(paths.backupDir, file)
      if (!existsSync(backup)) continue
      try {
        copyFileSync(backup, join(paths.profileDir, file))
        restored.push(file)
      } catch { /* ignore */ }
    }
    return restored
  }

  function quarantineConfig() {
    const dir = join(paths.reportDir, `broken-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    ensureDir(dir)
    const kept = []
    for (const file of CONFIG_FILES) {
      const source = join(paths.profileDir, file)
      if (!existsSync(source)) continue
      try {
        copyFileSync(source, join(dir, file))
        kept.push(file)
      } catch { /* ignore */ }
    }
    return { dir, kept }
  }

  /** Validate the profile config; restore the last known-good snapshot when it is broken. */
  async function repair({ fix = true } = {}) {
    const first = await composeCheck()
    if (first.ok) {
      const copied = snapshotConfig()
      return { ok: true, action: 'none', message: `profile '${settings.profile}' composes correctly`, snapshot: copied }
    }

    if (!fix) return { ok: false, action: 'none', detail: first.error }

    const hasBackup = existsSync(join(paths.backupDir, 'cordis.patch.yml'))
    if (!hasBackup) {
      return { ok: false, action: 'none', detail: first.error, message: 'no known-good snapshot to restore; safe mode will be used' }
    }

    const kept = quarantineConfig()
    const restored = restoreConfig()
    const second = await composeCheck()
    if (second.ok) {
      return {
        ok: true,
        action: 'restored',
        restored,
        quarantine: kept.dir,
        detail: first.error,
        message: `the profile config was invalid and has been restored from the last known-good snapshot (broken copies kept in ${kept.dir})`,
      }
    }
    return { ok: false, action: 'failed', restored, quarantine: kept.dir, detail: second.error, message: 'restoring the snapshot did not make the profile composable; safe mode is required' }
  }

  // --- supervisor state ----------------------------------------------------

  function readStateFile(name, fallback = '') {
    return readText(join(paths.stateDir, name), fallback)?.trim() ?? fallback
  }

  function supervisorState() {
    const numeric = (name) => {
      const value = Number.parseInt(readStateFile(name, ''), 10)
      return Number.isFinite(value) ? value : undefined
    }
    let incident = null
    const raw = readText(join(paths.stateDir, 'incident.json'))
    if (raw !== undefined && raw.trim() !== '') {
      try { incident = JSON.parse(raw) } catch { incident = { at: undefined, kind: 'unknown', message: raw.slice(0, 400) } }
    }
    return {
      installed: existsSync(paths.supervisor),
      mode: readStateFile('mode', 'normal') === 'safe' ? 'safe' : 'normal',
      failures: numeric('failures') ?? 0,
      lastStart: numeric('last_start'),
      lastExit: numeric('last_exit'),
      incident,
      previousIncident: existsSync(join(paths.reportDir, 'latest.md')),
    }
  }

  /**
   * Inspect the GENERATED supervisor, not just the files' existence: an
   * autostart that looks installed while its baked node/cli paths are gone is
   * exactly the failure that once made the service stop silently.
   */
  function healthStatus() {
    const script = readText(paths.supervisor)
    const read = (key, env) => {
      if (script === undefined) return undefined
      const match = new RegExp(`${key}="\\$\\{${env}:-([^}]*)\\}"`).exec(script)
      return match === null ? undefined : match[1]
    }
    const node = read('NODE_BIN', 'DSH_IAN_DAEMON_NODE')
    const cli = read('DSH_CLI', 'DSH_IAN_DAEMON_CLI')
    const appArgs = read('APP_ARGS', 'DSH_IAN_DAEMON_APP_ARGS')
    const nodeExists = typeof node === 'string' && node !== '' && existsSync(node)
    const cliExists = typeof cli === 'string' && cli !== '' && existsSync(cli)
    return {
      ok: script !== undefined && nodeExists && cliExists && isInstalled(settings.unitName),
      script: script !== undefined,
      unitInstalled: isInstalled(settings.unitName),
      generated: { node, cli, appArgs },
      nodeExists,
      cliExists,
    }
  }

  /** Proof, reported by the browser, that the restart control really rendered. */
  function clientState() {
    const raw = readText(join(paths.stateDir, 'client.json'))
    if (raw === undefined || raw.trim() === '') return { mounted: false }
    try { return { mounted: true, ...JSON.parse(raw) } } catch { return { mounted: false } }
  }

  /** One line per restart-lifecycle step, from both the page and this half. */
  const CLIENT_EVENTS_FILE = 'client-events.jsonl'
  const CLIENT_EVENTS_MAX = 200

  function recordEvent(source, event, data) {
    try {
      ensureDir(paths.stateDir)
      const file = join(paths.stateDir, CLIENT_EVENTS_FILE)
      const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, source, event, data })}\n`
      let text = `${readText(file, '') ?? ''}${line}`
      const lines = text.split('\n').filter((entry) => entry !== '')
      if (lines.length > CLIENT_EVENTS_MAX) text = `${lines.slice(-CLIENT_EVENTS_MAX).join('\n')}\n`
      writeFileSync(file, text, 'utf8')
    } catch { /* diagnostics are best effort */ }
  }

  /** At most one heartbeat per 20s: proves the page is still polling. */
  function recordHeartbeat() {
    try {
      const file = join(paths.stateDir, 'client-heartbeat.json')
      const previous = readJson(file)
      const last = typeof previous?.at === 'string' ? Date.parse(previous.at) : 0
      if (Number.isFinite(last) && Date.now() - last < 20000) return
      ensureDir(paths.stateDir)
      writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid }, null, 2)}\n`, 'utf8')
    } catch { /* diagnostics are best effort */ }
  }

  function clientHeartbeat() {
    return readJson(join(paths.stateDir, 'client-heartbeat.json')) ?? null
  }

  function clientEvents(limit = 10) {
    const text = readText(join(paths.stateDir, CLIENT_EVENTS_FILE), '')
    const lines = (text ?? '').split('\n').filter((entry) => entry !== '')
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return { raw: line.slice(0, 200) } }
    })
  }

  function clearSafeMode() {
    const removed = []
    for (const name of ['mode', 'failures', 'window_start', 'incident.json']) {
      const path = join(paths.stateDir, name)
      try {
        if (existsSync(path)) { rmSync(path); removed.push(name) }
      } catch { /* ignore */ }
    }
    return removed
  }

  // --- restart -------------------------------------------------------------

  function isManagedByUnit() {
    // cgroup v2 writes `0::/user.slice/…/dsh-ian-daemon.service` while the unit runs us.
    return selfCgroup().includes(settings.unitName)
  }

  function capturedArgv() {
    const argv = process.argv.slice(1).filter((arg) => typeof arg === 'string')
    if (argv.length > 0 && /(^|[/\\])bin\.js$/.test(argv[0])) return argv
    const cli = resolveCliPath()
    return cli === '' ? [] : [cli, settings.profile, ...appArgs()]
  }

  function spawnRelaunch({ useSystemd }) {
    const command = [nodeBin(), ...capturedArgv()]
    const args = [
      paths.relaunch,
      String(process.pid),
      useSystemd ? 'systemd' : 'exec',
      settings.unitName,
      process.cwd(),
      ...command,
    ]
    const child = spawn('/bin/bash', args, { detached: true, stdio: 'ignore', env: process.env })
    child.unref()
    return { pid: child.pid, useSystemd, command: command.join(' ') }
  }

  async function planRestart() {
    if (isManagedByUnit()) {
      return { action: 'systemd', unit: settings.unitName, backend: await backend(), message: `restarting ${settings.unitName} through systemd` }
    }
    const enabled = isEnabled(settings.unitName)
    const spawned = spawnRelaunch({ useSystemd: enabled })
    return {
      action: enabled ? 'systemd-handoff' : 'relaunch',
      helperPid: spawned.pid,
      message: enabled
        ? `autostart is enabled: exiting now and letting ${settings.unitName} take over`
        : 'autostart is not enabled: relaunching the same command line detached',
    }
  }

  async function performRestart(plan) {
    recordEvent('host', 'restart:perform', { action: plan.action, unit: settings.unitName, managed: isManagedByUnit() })
    if (plan.action === 'systemd') {
      const result = await (async () => {
        const direct = await systemctl(['restart', settings.unitName])
        if (direct !== null) return { ok: direct.code === 0, via: 'systemctl', error: direct.stderr.trim() }
        const bus = await managerCall('RestartUnit', 'ss', [settings.unitName, 'replace'])
        return { ok: bus.code === 0, via: 'busctl', error: bus.stderr.trim() }
      })()
      recordEvent('host', 'restart:result', result)
      if (!result.ok) {
        warn(`restart failed (${result.via}): ${result.error || 'unknown error'}`)
        return result
      }
      return result
    }
    info(`handing over to ${paths.relaunch} (${plan.action})`)
    recordEvent('host', 'restart:handover', { helper: paths.relaunch })
    const force = setTimeout(() => process.exit(0), 8000)
    force.unref?.()
    process.kill(process.pid, 'SIGTERM')
    return { ok: true, via: 'relaunch' }
  }

  // --- selftest ------------------------------------------------------------

  /** Prove that this session can actually load, start and stop a systemd user unit. */
  async function selftest() {
    const unit = settings.selfTestUnit
    const steps = []
    const record = (step, detail) => steps.push({ step, ...detail })
    const back = await backend()
    record('backend', { ok: back !== 'none', via: back })
    if (back === 'none') return { ok: false, steps, message: 'neither systemctl --user nor the systemd D-Bus manager can be reached' }

    try {
      writeIfChanged(unitPath(unit), template('units/dsh-ian-daemon-selftest.service.in'), 0o644)
      record('write-unit', { ok: true, path: unitPath(unit) })
    } catch (error) {
      return { ok: false, steps, message: `cannot write the selftest unit: ${error?.message ?? error}` }
    }

    record('daemon-reload', await daemonReload())
    const started = await unitVerb('StartUnit', unit)
    record('start', started)
    if (!started.ok) {
      record('cleanup', await cleanupSelfTest(unit))
      return { ok: false, steps, message: `systemd refused to start the selftest unit: ${started.error || 'unknown error'}` }
    }

    let state = 'unknown'
    for (let attempt = 0; attempt < 10; attempt += 1) {
      state = (await activeState(unit)).state
      if (state === 'active') break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    record('active', { ok: state === 'active', state })

    const stopped = await unitVerb('StopUnit', unit)
    record('stop', stopped)
    record('cleanup', await cleanupSelfTest(unit))
    return { ok: state === 'active' && stopped.ok, steps, message: state === 'active' ? 'systemd user units can be started and stopped from this session' : `the selftest unit never became active (state ${state})` }
  }

  async function cleanupSelfTest(unit) {
    try { if (isInstalled(unit)) rmSync(unitPath(unit)) } catch { /* ignore */ }
    const reload = await daemonReload()
    return { ok: reload.ok, via: reload.via }
  }

  // --- status --------------------------------------------------------------

  async function status() {
    const back = await backend()
    const unit = settings.unitName
    const installed = isInstalled(unit)
    const enabled = isEnabled(unit)
    let active = { state: 'unknown', via: back }
    let pid
    if (installed) {
      active = await activeState(unit)
      pid = await mainPid(unit)
    }
    const linger = settings.enableLinger ? await lingerEnabled() : undefined
    return {
      ok: true,
      plugin: PKG_NAME,
      version: readJson(join(PACKAGE_DIR, 'package.json'))?.version,
      time: new Date().toISOString(),
      process: {
        pid: process.pid,
        ppid: process.ppid,
        cwd: process.cwd(),
        execPath: process.execPath,
        cgroup: selfCgroup().trim(),
        managedByUnit: isManagedByUnit(),
        argv: process.argv.slice(1).filter((arg) => typeof arg === 'string'),
      },
      systemd: {
        backend: back,
        available: back !== 'none',
        unitDir: settings.unitDir,
        unit,
        installed,
        enabled,
        activeState: active.state,
        activeVia: active.via,
        mainPid: pid,
        safeUnit: settings.safeUnitName,
        safeUnitInstalled: isInstalled(settings.safeUnitName),
      },
      linger,
      profile: settings.profile,
      safeProfile: settings.safeProfile,
      appArgs: appArgs(),
      supervisor: supervisorState(),
      client: clientState(),
      clientHeartbeat: clientHeartbeat(),
      clientEvents: clientEvents(),
      ready: readiness.ready,
      readyAt: readiness.at,
      health: healthStatus(),
      lastInstall: readJson(join(paths.stateDir, 'install.json')),
      paths,
      config: {
        failureThreshold: settings.failureThreshold,
        failureWindowSeconds: settings.failureWindowSeconds,
        healthySeconds: settings.healthySeconds,
        installOnActivate: settings.installOnActivate,
        startAtBoot: settings.startAtBoot,
      },
    }
  }

  function readJson(path) {
    const raw = readText(path)
    if (raw === undefined) return undefined
    try { return JSON.parse(raw) } catch { return undefined }
  }

  // --- http ------------------------------------------------------------------

  function sendJson(res, code, body) {
    const text = `${JSON.stringify(body, null, 2)}\n`
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  function sendText(res, code, text) {
    res.writeHead(code, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  function mutating(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed', expected: 'POST' })
      return false
    }
    // A custom header keeps a stray cross-site form/img from restarting the app.
    if (String(req.headers['x-dsh-ian-daemon'] ?? '') !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing-x-dsh-ian-daemon-header' })
      return false
    }
    return true
  }

  function query(req) {
    try { return new URL(req.url ?? '/', 'http://127.0.0.1') } catch { return new URL(`${ROUTE_PREFIX}/status`, 'http://127.0.0.1') }
  }

  function routes() {
    return [
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: async (req, res) => {
          try {
            // The page polls with hb=1; curl/agents do not, so only real pages
            // move the liveness timestamp.
            if (query(req).searchParams.get('hb') === '1') recordHeartbeat()
            sendJson(res, 200, await status())
          } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/log`,
        handler: (req, res) => {
          const lines = Math.min(2000, Math.max(1, asNumber(query(req).searchParams.get('lines'), 200)))
          const source = query(req).searchParams.get('source') === 'dsh' ? paths.dshLog : paths.supervisorLog
          sendText(res, 200, tailFile(source, lines) || `${source} is empty\n`)
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/mounted`,
        handler: (req, res) => {
          if (!mutating(req, res)) return
          let body = ''
          req.on('data', (chunk) => { if (body.length < 120) body += chunk })
          req.on('end', () => {
            let previous = 0
            try { previous = Number(clientState().count) || 0 } catch { previous = 0 }
            const record = { at: new Date().toISOString(), where: String(body).slice(0, 40), count: previous + 1, pid: process.pid }
            try {
              ensureDir(paths.stateDir)
              writeFileSync(join(paths.stateDir, 'client.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
            } catch { /* the beacon is best effort */ }
            sendJson(res, 200, { ok: true, recorded: record })
          })
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/event`,
        handler: (req, res) => {
          if (!mutating(req, res)) return
          let body = ''
          req.on('data', (chunk) => { if (body.length < 400) body += chunk })
          req.on('end', () => {
            const text = String(body)
            const space = text.indexOf(' ')
            const event = (space === -1 ? text : text.slice(0, space)).slice(0, 60) || 'unknown'
            let data
            if (space !== -1) {
              try { data = JSON.parse(text.slice(space + 1)) } catch { data = { raw: text.slice(space + 1, 200) } }
            }
            recordEvent('client', event, data)
            sendJson(res, 200, { ok: true })
          })
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/restart`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try {
            const plan = await planRestart()
            recordEvent('host', 'restart:plan', { action: plan.action, unit: settings.unitName, managed: isManagedByUnit() })
            sendJson(res, 202, { ok: true, plan, note: 'the page will answer again once the new process is up' })
            // Long enough for the 202 to reach the browser on loopback, short
            // enough not to be felt: the earlier 700ms was pure added latency.
            setTimeout(() => { performRestart(plan).catch((error) => warn(`restart failed: ${error?.message ?? error}`)) }, 250)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/install`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try { sendJson(res, 200, await install({ start: false })) } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/uninstall`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try { sendJson(res, 200, await uninstall({ purge: query(req).searchParams.get('purge') === '1' })) } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/repair`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try { sendJson(res, 200, await repair({ fix: true })) } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/reset`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try {
            const removed = clearSafeMode()
            const restart = query(req).searchParams.get('restart') === '1'
            const plan = restart ? await planRestart() : undefined
            sendJson(res, restart ? 202 : 200, { ok: true, cleared: removed, plan })
            if (plan !== undefined) {
              // Long enough for the 202 to reach the browser on loopback, short
            // enough not to be felt: the earlier 700ms was pure added latency.
            setTimeout(() => { performRestart(plan).catch((error) => warn(`restart failed: ${error?.message ?? error}`)) }, 250)
            }
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/selftest`,
        handler: async (req, res) => {
          if (!mutating(req, res)) return
          try { sendJson(res, 200, await selftest()) } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
        },
      },
    ]
  }

  // --- lifecycle -----------------------------------------------------------

  function bindPort(port) {
    if (Number.isFinite(port) && port > 0) livePort = port
  }

  async function activate() {
    if (activated || disposed) return
    activated = true
    watchReadiness()
    if (!settings.installOnActivate) {
      info('activation: installOnActivate=false, only reporting status')
      return
    }
    const result = await install({ start: false })
    if (result.ok) {
      info(`autostart ready: unit=${settings.unitName} enabled=${result.enabled === true} linger=${result.linger ?? 'unchanged'} changed=[${(result.changed ?? []).join(', ')}]`)
    } else {
      warn(`autostart install incomplete: ${result.error ?? (result.warnings ?? []).join('; ')}`)
    }
  }

  function dispose() {
    disposed = true
    activated = false
  }

  return { bindPort, activate, dispose, routes, status, install, uninstall, repair, selftest, planRestart, performRestart, clearSafeMode, settings, paths }
}

// ---------------------------------------------------------------------------
// cordis plugin face
// ---------------------------------------------------------------------------

export const name = PKG_NAME

export function apply(ctx, config) {
  const manager = createManager(ctx, config)
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      manager.bindPort(webCtx.webServer?.port)
      manager.activate().catch((error) => {
        try { webCtx.logger?.warn?.(`${PKG_NAME}: activation failed: ${error?.message ?? error}`) } catch { /* ignore */ }
      })
      return () => manager.dispose()
    }, 'dsh-ian-daemon: activation')

    webCtx.effect(() => {
      const disposers = manager.routes().map((route) => webCtx.webServer.register(route))
      return () => { for (const dispose of disposers.reverse()) dispose() }
    }, 'dsh-ian-daemon: http routes')
  })
}
