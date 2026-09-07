import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parse } from 'acorn'
import {
  isLoopbackHostname,
  isSafeExternalUrl,
  isTrustedNavigation,
  resolveDesktopDevUrl,
} from '../desktop/security.js'
import {
  DEFAULT_DESKTOP_PORT,
  ensureDesktopRuntimeConfigFile,
  probeDesktopRuntimeMode,
  resolveDesktopDataPaths,
  resolveDesktopPluginRoots,
  resolveDesktopPort,
  resolveDesktopRuntimeConfigPath,
  waitForDesktopRuntimeFiles,
} from '../desktop/runtime.js'

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

test('desktop dev URL only accepts loopback HTTP origins', () => {
  assert.equal(resolveDesktopDevUrl('http://127.0.0.1:5175'), 'http://127.0.0.1:5175/')
  assert.equal(resolveDesktopDevUrl('http://localhost:5175/path'), 'http://localhost:5175/path')
  assert.equal(resolveDesktopDevUrl('https://example.com'), null)
  assert.equal(resolveDesktopDevUrl('file:///tmp/index.html'), null)
})

test('desktop loopback detection covers IPv4 and IPv6 without trusting wildcards', () => {
  assert.equal(isLoopbackHostname('127.12.4.9'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('0.0.0.0'), false)
  assert.equal(isLoopbackHostname('192.168.1.20'), false)
})

test('desktop navigation stays on the exact application origin', () => {
  const origin = 'http://127.0.0.1:43123'
  assert.equal(isTrustedNavigation(`${origin}/settings`, origin), true)
  assert.equal(isTrustedNavigation('http://127.0.0.1:43124/', origin), false)
  assert.equal(isTrustedNavigation('https://example.com/', origin), false)
  assert.equal(isTrustedNavigation('javascript:alert(1)', origin), false)
})

test('external links only allow HTTP and HTTPS', () => {
  assert.equal(isSafeExternalUrl('https://github.com/'), true)
  assert.equal(isSafeExternalUrl('https://user:secret@example.com/'), false)
  assert.equal(isSafeExternalUrl('mailto:test@example.com'), false)
  assert.equal(isSafeExternalUrl('file:///C:/Windows/System32'), false)
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false)
})

test('desktop runtime keeps a stable valid port and isolated data paths', () => {
  assert.equal(resolveDesktopPort(), DEFAULT_DESKTOP_PORT)
  assert.equal(resolveDesktopPort('6200'), 6200)
  assert.equal(resolveDesktopPort('0'), DEFAULT_DESKTOP_PORT)
  assert.equal(resolveDesktopPort('70000'), DEFAULT_DESKTOP_PORT)
  assert.deepEqual(resolveDesktopDataPaths('C:/Users/test/AppData/Roaming/Gugo'), {
    dataDir: path.resolve('C:/Users/test/AppData/Roaming/Gugo/server-data'),
    database: path.resolve('C:/Users/test/AppData/Roaming/Gugo/server-data/app.db'),
    artifacts: path.resolve('C:/Users/test/AppData/Roaming/Gugo/server-data/artifacts'),
  })
})

test('desktop runtime config is a fixed regular file inside application data', () => {
  const userData = 'C:/Users/test/AppData/Roaming/Gugo'
  const expected = path.join(path.resolve(userData, 'server-data'), 'runtime.json')
  assert.equal(resolveDesktopRuntimeConfigPath(userData), expected)
  assert.throws(() => resolveDesktopRuntimeConfigPath(''), /user data path is required/)

  const calls = []
  assert.equal(ensureDesktopRuntimeConfigFile({
    userData,
    mkdirSync: (...args) => calls.push(['mkdir', ...args]),
    writeFileSync: (...args) => calls.push(['write', ...args]),
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
  }), expected)
  assert.deepEqual(calls[0], ['mkdir', path.dirname(expected), { recursive: true }])
  assert.equal(calls[1][0], 'write')
  assert.equal(calls[1][1], expected)
  assert.equal(calls[1][3].flag, 'wx')

  assert.throws(() => ensureDesktopRuntimeConfigFile({
    userData,
    mkdirSync: () => {},
    writeFileSync: () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }) },
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true }),
  }), (error) => error?.code === 'INVALID_RUNTIME_CONFIG_FILE')
})

test('a desktop data-root override relocates database, artifacts, and editable config together', () => {
  const userData = path.resolve('desktop-fixture-user')
  const cwd = path.resolve('desktop-fixture-install')
  const options = { cwd, env: { APP_DATA_DIR: 'custom-data' } }
  const dataDir = path.join(cwd, 'custom-data')
  assert.deepEqual(resolveDesktopDataPaths(userData, options), {
    dataDir,
    database: path.join(dataDir, 'app.db'),
    artifacts: path.join(dataDir, 'artifacts'),
  })
  assert.equal(resolveDesktopRuntimeConfigPath(userData, options), path.join(dataDir, 'runtime.json'))
  const writes = []
  assert.equal(ensureDesktopRuntimeConfigFile({
    userData, ...options,
    mkdirSync: () => {},
    writeFileSync: (filePath) => writes.push(filePath),
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
  }), path.join(dataDir, 'runtime.json'))
  assert.deepEqual(writes, [path.join(dataDir, 'runtime.json')])
})

test('desktop storage keeps explicit database and artifact overrides anchored to the install root', () => {
  const cwd = path.resolve('desktop-fixture-install')
  const env = { APP_DATA_DIR: 'data', APP_DB_PATH: 'db/custom.db', ARTIFACT_DIR: 'files' }
  assert.deepEqual(resolveDesktopDataPaths('desktop-fixture-user', { env, cwd }), {
    dataDir: path.join(cwd, 'data'),
    database: path.join(cwd, 'db', 'custom.db'),
    artifacts: path.join(cwd, 'files'),
  })
  assert.deepEqual(env, { APP_DATA_DIR: 'data', APP_DB_PATH: 'db/custom.db', ARTIFACT_DIR: 'files' })
  assert.throws(() => resolveDesktopDataPaths('desktop-fixture-user', {
    cwd, env: { APP_DB_PATH: 'undefined' },
  }), (error) => error?.code === 'RUNTIME_STORAGE_PATH_INVALID')
})

test('desktop plugin discovery only returns existing, de-duplicated roots', () => {
  const existing = new Set([
    path.resolve('D:/destok/codex-plugins').toLowerCase(),
    path.resolve('C:/Users/test/codex-plugins').toLowerCase(),
  ])
  const roots = resolveDesktopPluginRoots({
    configured: JSON.stringify(['D:/destok/codex-plugins', 'D:/DESTOK/codex-plugins']),
    homeDir: 'C:/Users/test',
    platform: 'win32',
    existsSync: (candidate) => existing.has(path.resolve(candidate).toLowerCase()),
  })
  assert.deepEqual(roots, [
    path.resolve('D:/destok/codex-plugins'),
    path.resolve('C:/Users/test/codex-plugins'),
  ])
})

test('desktop runtime tolerates a short installer file-replacement window', async () => {
  const executablePath = 'D:/Apps/Gugo/Gugo.exe'
  const entryPath = 'D:/Apps/Gugo/resources/app.asar/server/start.js'
  const waited = []
  let replacementFinished = false

  await waitForDesktopRuntimeFiles({
    executablePath,
    entryPath,
    existsSync: (candidate) => replacementFinished
      && (candidate === executablePath || candidate === entryPath),
    delays: [25, 50],
    sleep: async (delay) => {
      waited.push(delay)
      replacementFinished = true
    },
  })

  assert.deepEqual(waited, [25])
})

test('desktop runtime reports a recoverable ENOENT when installed files stay missing', async () => {
  const executablePath = 'D:/Apps/Gugo/Gugo.exe'
  const entryPath = 'D:/Apps/Gugo/resources/app.asar/server/start.js'
  const waited = []

  await assert.rejects(
    waitForDesktopRuntimeFiles({
      executablePath,
      entryPath,
      existsSync: () => false,
      delays: [25, 50, 100],
      sleep: async (delay) => { waited.push(delay) },
    }),
    (error) => {
      assert.equal(error?.code, 'ENOENT')
      assert.match(error?.message || '', /安装文件不完整/)
      assert.match(error?.message || '', /重新安装或修复 Gugo/)
      assert.deepEqual(error?.missingPaths, [executablePath, entryPath])
      return true
    },
  )

  assert.deepEqual(waited, [25, 50, 100])
})

test('desktop runtime probe accepts a healthy application without probing recovery', async () => {
  const calls = []
  const mode = await probeDesktopRuntimeMode('http://127.0.0.1:5180', {
    fetchImpl: async (url) => {
      calls.push(url)
      return jsonResponse({ ok: true, version: 'test' })
    },
  })
  assert.equal(mode, 'runtime')
  assert.deepEqual(calls, ['http://127.0.0.1:5180/api/health'])
})

test('desktop runtime probe recognizes only the versioned recovery contract', async () => {
  const calls = []
  const mode = await probeDesktopRuntimeMode('http://127.0.0.1:5180/', {
    fetchImpl: async (url) => {
      calls.push(url)
      if (url.endsWith('/api/health')) return jsonResponse({ ok: false }, { status: 503 })
      return jsonResponse({
        ok: true,
        mode: 'runtime_config_recovery',
        protocolVersion: 1,
        restartRequired: true,
      })
    },
  })
  assert.equal(mode, 'recovery')
  assert.deepEqual(calls, [
    'http://127.0.0.1:5180/api/health',
    'http://127.0.0.1:5180/api/recovery/status',
  ])
})

test('desktop runtime probe rejects HTML, forged recovery responses, and network failures', async () => {
  const rejected = [
    new Response('<html>SPA fallback</html>', { headers: { 'content-type': 'text/html' } }),
    jsonResponse({ ok: true, mode: 'runtime_config_recovery', protocolVersion: 2, restartRequired: true }),
    jsonResponse({ ok: true, mode: 'runtime_config_recovery', protocolVersion: 1, restartRequired: false }),
  ]
  for (const recoveryResponse of rejected) {
    let call = 0
    assert.equal(await probeDesktopRuntimeMode('http://127.0.0.1:5180', {
      fetchImpl: async () => (++call === 1
        ? jsonResponse({ ok: false }, { status: 503 })
        : recoveryResponse),
    }), null)
  }
  assert.equal(await probeDesktopRuntimeMode('http://127.0.0.1:5180', {
    fetchImpl: async () => { throw new TypeError('offline') },
  }), null)
})

function desktopUpdateBoundarySources() {
  const source = readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8')
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const statusFunction = program.body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'sendUpdateStatus')
  const registerIpc = program.body.find((node) => node.type === 'FunctionDeclaration' && node.id.name === 'registerDesktopIpc')
  const installerRegistration = registerIpc.body.body.find((node) => {
    const call = node.expression
    return call?.type === 'CallExpression' && call.callee?.object?.name === 'ipcMain'
      && call.callee?.property?.name === 'handle' && call.arguments[0]?.value === 'desktop:install-update'
  })
  assert.ok(statusFunction)
  assert.ok(installerRegistration)
  const handler = installerRegistration.expression.arguments[1]
  return { status: source.slice(statusFunction.start, statusFunction.end), install: source.slice(handler.start, handler.end) }
}

function desktopUpdateBoundaryFixture(options = {}) {
  const sources = desktopUpdateBoundarySources()
  const calls = { sent: [], stopped: 0, installed: 0, scheduled: [], order: [] }
  const context = vm.createContext({
    updateReady: options.ready ?? true,
    allowQuit: false,
    desktopUpdateRuntime: options.missingRuntime ? null : { downloading: options.downloading ?? false },
    autoUpdater: {
      installerPath: options.missingInstaller ? null : 'synthetic-verified-installer.exe',
      downloadedUpdateHelper: options.missingHelper ? null : {
        downloadedFileInfo: options.missingMetadata ? null : { isAdminRightsRequired: false },
      },
      quitAndInstall() { calls.installed += 1; calls.order.push('install') },
    },
    mainWindow: options.noWindow ? null : {
      isDestroyed: () => Boolean(options.destroyedWindow),
      webContents: { send: (_channel, payload) => { calls.sent.push(payload); calls.order.push(payload.status) } },
    },
    assertTrustedIpc() {
      calls.order.push('trusted-ipc')
      if (options.untrusted) throw new Error('synthetic untrusted IPC')
    },
    async stopBackend() {
      calls.stopped += 1
      calls.order.push('stop-backend')
      if (options.stopError) throw options.stopError
    },
    setImmediate(callback) { calls.scheduled.push(callback) },
  })
  // Execute only the actual status function and IPC callback in an isolated
  // context. Never import main.js, instantiate Electron, or stop a real backend.
  vm.runInContext(`${sources.status}\nthis.installUpdate = (${sources.install});`, context)
  return { context, calls }
}

test('non-ready update statuses revoke stale readiness even without a live window', () => {
  for (const status of ['checking', 'available', 'downloading', 'error', 'current', 'installing']) {
    for (const windowState of [{}, { noWindow: true }, { destroyedWindow: true }]) {
      const { context, calls } = desktopUpdateBoundaryFixture(windowState)
      context.sendUpdateStatus(status)
      assert.equal(context.updateReady, false, status)
      assert.equal(calls.sent.length, windowState.noWindow || windowState.destroyedWindow ? 0 : 1)
    }
  }
})

test('a ready status cannot manufacture installer readiness without the verified event', () => {
  for (const ready of [false, true]) {
    const { context } = desktopUpdateBoundaryFixture({ ready })
    context.sendUpdateStatus('ready')
    assert.equal(context.updateReady, ready)
  }
})

test('the install IPC rejects stale or incomplete readiness before stopping the backend', async () => {
  for (const options of [
    { ready: false }, { missingRuntime: true }, { downloading: true },
    { missingInstaller: true }, { missingHelper: true }, { missingMetadata: true },
  ]) {
    const { context, calls } = desktopUpdateBoundaryFixture(options)
    const result = await context.installUpdate({})
    assert.equal(result.ready, false)
    assert.equal(context.updateReady, false)
    assert.equal(context.allowQuit, false)
    assert.equal(calls.stopped, 0)
    assert.equal(calls.installed, 0)
    assert.equal(calls.scheduled.length, 0)
    assert.deepEqual(calls.order, ['trusted-ipc'])
  }
})

test('the install IPC still checks the sender before any shutdown or installation', async () => {
  const { context, calls } = desktopUpdateBoundaryFixture({ untrusted: true })
  await assert.rejects(context.installUpdate({}), /synthetic untrusted IPC/)
  assert.equal(calls.stopped, 0)
  assert.equal(calls.installed, 0)
  assert.equal(calls.scheduled.length, 0)
})

test('only a verified idle update can stop the backend and schedule one installer', async () => {
  const { context, calls } = desktopUpdateBoundaryFixture()
  const result = await context.installUpdate({})
  assert.equal(result.ready, true)
  assert.equal(context.updateReady, false, 'installing must revoke the duplicate-click latch')
  assert.equal(context.allowQuit, true)
  assert.equal(calls.stopped, 1)
  assert.equal(calls.installed, 0)
  assert.equal(calls.scheduled.length, 1)
  assert.deepEqual(calls.order, ['trusted-ipc', 'installing', 'stop-backend'])
  assert.equal((await context.installUpdate({})).ready, false)
  assert.equal(calls.stopped, 1)
  calls.scheduled[0]()
  assert.equal(calls.installed, 1, 'the fixture calls a mock installer only')
})

test('a backend shutdown failure leaves no stale ready flag or scheduled installation', async () => {
  const { context, calls } = desktopUpdateBoundaryFixture({ stopError: new Error('synthetic stop failure') })
  const result = await context.installUpdate({})
  assert.equal(result.ready, false)
  assert.equal(context.updateReady, false)
  assert.equal(context.allowQuit, false)
  assert.equal(calls.stopped, 1)
  assert.equal(calls.installed, 0)
  assert.equal(calls.scheduled.length, 0)
  assert.equal(calls.sent.at(-1).status, 'error')
})
