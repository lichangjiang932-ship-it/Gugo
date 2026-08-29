import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { constants as fsConstants, readFileSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'

import {
  CODEX_APP_SERVER_REASON,
  closeCodexAppServerRuntime,
  createCodexCliExecutableSnapshot,
  createCodexCliExecutableSnapshotAsync,
  getCodexAppServerStatus,
  parseCodexCliVersion,
  resolveCodexCliExecutable,
  resolveCodexCliExecutableAsync,
  resolveWindowsPowerShellExecutable,
  startCodexAppServerRuntime,
  verifyCodexCliAuthenticode,
} from '../server/services/codexAppServerRuntime.js'

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

const PUBLIC_STATUS_KEYS = [
  'configured',
  'discovered',
  'enabled',
  'failureStage',
  'ready',
  'reasonCode',
  'signatureValid',
  'version',
]

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function fakeChild(onMessage = () => {}) {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  let pending = ''
  let exited = false
  child.emitExit = (code = 0, signal = null) => {
    if (exited) return
    exited = true
    child.emit('exit', code, signal)
  }
  child.stdin.on('data', (chunk) => {
    pending += chunk.toString('utf8')
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (!line) continue
      try {
        Promise.resolve(onMessage(JSON.parse(line), child)).catch((error) => child.emit('error', error))
      } catch (error) {
        child.emit('error', error)
      }
    }
  })
  return child
}

function emitSuccessfulInitialize(message, child) {
  if (message.method !== 'initialize') return
  child.stdout.write(`${JSON.stringify({
    id: message.id,
    result: { userAgent: 'codex-test', platformFamily: 'windows' },
  })}\n`)
}

function successfulStartOptions(overrides = {}) {
  return {
    cwd: 'D:\\workspace',
    env: { CODEX_APP_SERVER_ENABLED: '1' },
    platform: 'win32',
    resolveExecutable: () => ({
      configured: false,
      found: true,
      path: 'C:\\Codex\\codex.exe',
      source: 'desktop-install',
      reasonCode: null,
    }),
    snapshotExecutable: (executable) => ({ path: executable, cleanup() {} }),
    verifySignature: async () => true,
    readVersion: async () => '0.150.0-alpha.8',
    spawnImpl: () => fakeChild(emitSuccessfulInitialize),
    terminate: async ({ child }) => {
      child.emitExit()
      return true
    },
    handshakeTimeoutMs: 500,
    signatureTimeoutMs: 500,
    versionTimeoutMs: 500,
    exitTimeoutMs: 100,
    ...overrides,
  }
}

async function resetRuntime() {
  await closeCodexAppServerRuntime({
    terminate: async ({ child }) => {
      child?.emitExit?.()
      return true
    },
    exitTimeoutMs: 100,
  })
}

test('Codex CLI discovery honors explicit, Gugo env, Codex env, desktop, then PATH order', () => {
  const available = new Set([
    'C:\\explicit\\codex.exe',
    'C:\\gugo-env\\codex.exe',
    'C:\\codex-env\\codex.exe',
    'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe',
    'D:\\bin\\codex.exe',
  ].map((value) => value.toLowerCase()))
  const isExecutable = (value) => available.has(String(value).toLowerCase())
  const env = {
    GUGO_CODEX_CLI_PATH: 'C:\\gugo-env\\codex.exe',
    CODEX_CLI_PATH: 'C:\\codex-env\\codex.exe',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    PATH: 'relative;D:\\bin',
  }

  assert.equal(resolveCodexCliExecutable({
    explicitPath: 'C:\\explicit\\codex.exe', env, platform: 'win32', isExecutable,
  }).source, 'explicit')
  assert.equal(resolveCodexCliExecutable({ env, platform: 'win32', isExecutable }).source, 'gugo-environment')
  assert.equal(resolveCodexCliExecutable({
    env: { ...env, GUGO_CODEX_CLI_PATH: '' }, platform: 'win32', isExecutable,
  }).source, 'codex-environment')
  assert.equal(resolveCodexCliExecutable({
    env: { ...env, GUGO_CODEX_CLI_PATH: '', CODEX_CLI_PATH: '' },
    platform: 'win32',
    isExecutable,
  }).source, 'desktop-install')
  assert.equal(resolveCodexCliExecutable({
    env: { PATH: 'relative;D:\\bin' }, platform: 'win32', isExecutable,
  }).source, 'path')
})

test('asynchronous Codex CLI discovery supports lookup and cooperative cancellation', async () => {
  const explicitPath = 'C:\\Codex\\codex.exe'
  const found = await resolveCodexCliExecutableAsync({
    explicitPath,
    platform: 'win32',
    isExecutable: async (candidate) => candidate === explicitPath,
  })
  assert.equal(found.found, true)
  assert.equal(found.path, explicitPath)
  assert.equal(found.source, 'explicit')

  const controller = new AbortController()
  const probeStarted = deferred()
  const releaseProbe = deferred()
  const cancelled = resolveCodexCliExecutableAsync({
    explicitPath,
    platform: 'win32',
    signal: controller.signal,
    isExecutable: async () => {
      probeStarted.resolve()
      await releaseProbe.promise
      return true
    },
  })
  await probeStarted.promise
  controller.abort()
  releaseProbe.resolve()
  await assert.rejects(cancelled, (error) => error?.name === 'AbortError')
})

test('configured Windows paths fail closed unless they are absolute native exe files', () => {
  for (const explicitPath of [
    'codex.exe',
    'C:\\tools\\codex.cmd',
    'C:\\tools\\codex.ps1',
    '\\\\attacker\\share\\codex.exe',
    '\\\\?\\C:\\tools\\codex.exe',
    '\\\\.\\C:\\tools\\codex.exe',
    '\\rooted\\codex.exe',
    'C:\\tools\\codex.exe:payload.exe',
  ]) {
    const invalid = resolveCodexCliExecutable({
      explicitPath,
      env: { PATH: 'D:\\bin' },
      platform: 'win32',
      isExecutable: () => true,
    })
    assert.equal(invalid.found, false)
    assert.equal(invalid.configured, true)
    assert.equal(invalid.source, 'explicit')
    assert.equal(invalid.reasonCode, CODEX_APP_SERVER_REASON.CLI_PATH_INVALID)
  }
  assert.equal(parseCodexCliVersion('codex-cli 0.150.0-alpha.8\n'), '0.150.0-alpha.8')
  assert.equal(parseCodexCliVersion('not-codex 0.150.0'), null)

  const probes = []
  const undiscovered = resolveCodexCliExecutable({
    env: {
      LOCALAPPDATA: '\\\\attacker\\desktop-share',
      PATH: '\\\\attacker\\path-share',
    },
    platform: 'win32',
    isExecutable: (candidate) => {
      probes.push(candidate)
      return true
    },
  })
  assert.equal(undiscovered.found, false)
  assert.equal(undiscovered.reasonCode, CODEX_APP_SERVER_REASON.CLI_NOT_FOUND)
  assert.deepEqual(probes, [])
})

test('Windows executable snapshots copy only codex.exe into a verified private directory', () => {
  const source = 'C:\\Codex\\codex.exe'
  const tempRoot = 'C:\\Users\\tester\\AppData\\Local\\Temp'
  const directory = `${tempRoot}\\gugo-codex-random`
  const snapshotPath = `${directory}\\codex.exe`
  const copies = []
  const removedFiles = []
  const removedDirectories = []

  const snapshot = createCodexCliExecutableSnapshot(source, {
    platform: 'win32',
    tempRoot,
    realpath: (candidate) => candidate,
    mkdtemp(prefix) {
      assert.equal(prefix, `${tempRoot}\\gugo-codex-`)
      return directory
    },
    copyFile(from, to, flags) {
      copies.push({ from, to, flags })
    },
    isExecutable: (candidate) => candidate === snapshotPath,
    removeFile: (candidate) => removedFiles.push(candidate),
    removeDirectory: (candidate) => removedDirectories.push(candidate),
  })

  assert.equal(snapshot.path, snapshotPath)
  assert.deepEqual(copies, [{
    from: source,
    to: snapshotPath,
    flags: fsConstants.COPYFILE_EXCL,
  }])
  snapshot.cleanup()
  snapshot.cleanup()
  assert.deepEqual(removedFiles, [snapshotPath])
  assert.deepEqual(removedDirectories, [directory])

  assert.equal(createCodexCliExecutableSnapshot(source, {
    platform: 'win32',
    tempRoot: '\\\\attacker\\share',
    realpath: (candidate) => candidate,
    mkdtemp: () => { throw new Error('must not create a remote snapshot') },
  }), null)
  assert.equal(createCodexCliExecutableSnapshot(source, {
    platform: 'win32',
    tempRoot,
    realpath: (candidate) => candidate === source ? '\\\\attacker\\share\\codex.exe' : candidate,
    mkdtemp: () => { throw new Error('must not snapshot a remote canonical source') },
  }), null)
})

test('asynchronous executable snapshot removes partial output after copy cancellation', async () => {
  const source = 'C:\\Codex\\codex.exe'
  const tempRoot = 'C:\\Temp'
  const directory = 'C:\\Temp\\gugo-codex-random'
  const snapshotPath = `${directory}\\codex.exe`
  const controller = new AbortController()
  const copyStarted = deferred()
  const releaseCopy = deferred()
  const removedFiles = []
  const removedDirectories = []

  const operation = createCodexCliExecutableSnapshotAsync(source, {
    platform: 'win32',
    tempRoot,
    signal: controller.signal,
    realpath: async (candidate) => candidate,
    mkdtemp: async () => directory,
    copyFile: async () => {
      copyStarted.resolve()
      await releaseCopy.promise
    },
    isExecutable: async () => true,
    removeFile: async (candidate) => { removedFiles.push(candidate) },
    removeDirectory: async (candidate) => { removedDirectories.push(candidate) },
  })
  await copyStarted.promise
  controller.abort()
  releaseCopy.resolve()

  assert.equal(await operation, null)
  assert.deepEqual(removedFiles, [snapshotPath])
  assert.deepEqual(removedDirectories, [directory])
})

test('system PowerShell resolution uses the Windows object manager instead of environment roots', () => {
  const probes = []
  const resolved = resolveWindowsPowerShellExecutable({
    realpath(value) {
      probes.push(value)
      return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    },
    isExecutable: () => true,
  })

  assert.equal(resolved, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(probes, [
    String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`,
  ])
  assert.equal(resolveWindowsPowerShellExecutable({
    realpath: () => 'C:\\attacker\\powershell.cmd',
    isExecutable: () => true,
  }), null)
})

test('Authenticode validation accepts only Valid OpenAI publishers without command interpolation', async () => {
  const calls = []
  const verifyOutput = (output) => verifyCodexCliAuthenticode('C:\\private path\\codex.exe', {
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    env: {
      PATH: 'C:\\attacker',
      PSModulePath: 'C:\\attacker\\modules',
      COR_ENABLE_PROFILING: '1',
      COR_PROFILER: '{00000000-0000-0000-0000-000000000000}',
      COR_PROFILER_PATH: 'C:\\attacker\\profiler.dll',
      DOTNET_STARTUP_HOOKS: 'C:\\attacker\\hook.dll',
    },
    execFileImpl(executable, args, options, callback) {
      calls.push({ executable, args, options })
      callback(null, output)
    },
  })
  const openAiPublisher = Buffer.from('OpenAI OpCo, LLC').toString('base64')
  const lookalikePublisher = Buffer.from('OpenAI Helper Evil LLC').toString('base64')

  assert.equal(await verifyOutput(`Valid\t${openAiPublisher}\n`), true)
  assert.equal(await verifyOutput(`Valid\t${lookalikePublisher}\n`), false)
  assert.equal(await verifyOutput(`HashMismatch\t${openAiPublisher}\n`), false)
  assert.equal(calls[0].options.shell, false)
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), [
    'GUGO_CODEX_SIGNATURE_MODULE',
    'GUGO_CODEX_SIGNATURE_TARGET',
  ])
  assert.equal(calls[0].options.env.GUGO_CODEX_SIGNATURE_TARGET, 'C:\\private path\\codex.exe')
  assert.match(
    calls[0].options.env.GUGO_CODEX_SIGNATURE_MODULE,
    /Microsoft\.PowerShell\.Security\.psd1$/u,
  )
  assert.equal(calls[0].args.some((value) => value.includes('private path')), false)
})

test('app-server discovery and process launch require an explicit enabled value of one', async () => {
  await resetRuntime()
  let discoveries = 0
  let spawns = 0
  const disabledValues = [undefined, '', '0', 'true', 'yes', '01']

  for (const value of disabledValues) {
    const env = {}
    if (value !== undefined) env.CODEX_APP_SERVER_ENABLED = value
    const status = await startCodexAppServerRuntime({
      cwd: 'D:\\workspace',
      env,
      explicitPath: 'C:\\Codex\\codex.exe',
      platform: 'win32',
      resolveExecutable: () => {
        discoveries += 1
        throw new Error('disabled app-server must not perform discovery')
      },
      spawnImpl: () => {
        spawns += 1
        throw new Error('disabled app-server must not spawn')
      },
    })

    assert.deepEqual(status, {
      enabled: false,
      configured: true,
      discovered: false,
      signatureValid: false,
      version: null,
      ready: false,
      failureStage: null,
      reasonCode: CODEX_APP_SERVER_REASON.DISABLED,
    })
  }

  assert.equal(discoveries, 0)
  assert.equal(spawns, 0)

  const enabled = await startCodexAppServerRuntime(successfulStartOptions({
    env: { CODEX_APP_SERVER_ENABLED: ' 1 ' },
  }))
  assert.equal(enabled.ready, true)
  assert.equal(enabled.reasonCode, CODEX_APP_SERVER_REASON.READY)
  await resetRuntime()
})

test('a pre-aborted first caller performs no discovery or snapshot work', async () => {
  await resetRuntime()
  const controller = new AbortController()
  controller.abort()
  let discoveries = 0
  let snapshots = 0
  let spawns = 0

  const status = await startCodexAppServerRuntime(successfulStartOptions({
    signal: controller.signal,
    resolveExecutable: () => {
      discoveries += 1
      return {
        configured: false,
        found: true,
        path: 'C:\\Codex\\codex.exe',
        source: 'test',
        reasonCode: null,
      }
    },
    snapshotExecutable: () => {
      snapshots += 1
      return { path: 'C:\\Codex\\codex.exe', cleanup() {} }
    },
    spawnImpl: () => {
      spawns += 1
      return fakeChild(emitSuccessfulInitialize)
    },
  }))
  await nextTurn()

  assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.START_ABORTED)
  assert.equal(discoveries, 0)
  assert.equal(snapshots, 0)
  assert.equal(spawns, 0)
})

test('cancelling asynchronous discovery aborts its stage and blocks later stages', async () => {
  await resetRuntime()
  const controller = new AbortController()
  const discoveryStarted = deferred()
  const releaseDiscovery = deferred()
  let discoverySignal = null
  let snapshots = 0
  let signatures = 0
  let spawns = 0

  const started = startCodexAppServerRuntime(successfulStartOptions({
    signal: controller.signal,
    resolveExecutable: async ({ signal }) => {
      discoverySignal = signal
      discoveryStarted.resolve()
      await releaseDiscovery.promise
      return {
        configured: false,
        found: true,
        path: 'C:\\Codex\\codex.exe',
        source: 'test',
        reasonCode: null,
      }
    },
    snapshotExecutable: () => {
      snapshots += 1
      return { path: 'C:\\Codex\\codex.exe', cleanup() {} }
    },
    verifySignature: async () => {
      signatures += 1
      return true
    },
    spawnImpl: () => {
      spawns += 1
      return fakeChild(emitSuccessfulInitialize)
    },
  }))
  await discoveryStarted.promise
  controller.abort()
  const status = await started
  releaseDiscovery.resolve()
  await nextTurn()

  assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.START_ABORTED)
  assert.equal(discoverySignal.aborted, true)
  assert.equal(snapshots, 0)
  assert.equal(signatures, 0)
  assert.equal(spawns, 0)
})

test('snapshot timeout aborts the stage and cleans one late handle exactly once', async () => {
  await resetRuntime()
  const snapshotStarted = deferred()
  const releaseSnapshot = deferred()
  let snapshotSignal = null
  let cleanups = 0
  let signatures = 0
  let versions = 0
  let spawns = 0

  const started = startCodexAppServerRuntime(successfulStartOptions({
    signatureTimeoutMs: 20,
    snapshotExecutable: async (_executable, { signal }) => {
      snapshotSignal = signal
      snapshotStarted.resolve()
      await releaseSnapshot.promise
      return {
        path: 'C:\\Temp\\gugo-codex-late\\codex.exe',
        cleanup() { cleanups += 1 },
      }
    },
    verifySignature: async () => {
      signatures += 1
      return true
    },
    readVersion: async () => {
      versions += 1
      return '0.150.0'
    },
    spawnImpl: () => {
      spawns += 1
      return fakeChild(emitSuccessfulInitialize)
    },
  }))
  await snapshotStarted.promise
  const status = await started
  assert.equal(snapshotSignal.aborted, true)
  releaseSnapshot.resolve()
  await nextTurn()
  await nextTurn()

  assert.equal(status.failureStage, 'signature')
  assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.CLI_SIGNATURE_INVALID)
  assert.equal(cleanups, 1)
  assert.equal(signatures, 0)
  assert.equal(versions, 0)
  assert.equal(spawns, 0)
})

test('cancellation after version settlement cannot cross the spawn boundary', async () => {
  await resetRuntime()
  const controller = new AbortController()
  let spawns = 0
  const status = await startCodexAppServerRuntime(successfulStartOptions({
    signal: controller.signal,
    readVersion: () => ({
      then(resolve) {
        resolve('0.150.0')
        queueMicrotask(() => controller.abort())
      },
    }),
    spawnImpl: () => {
      spawns += 1
      return fakeChild(emitSuccessfulInitialize)
    },
  }))
  await nextTurn()

  assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.START_ABORTED)
  assert.equal(spawns, 0)
})

test('signature failure stops before version probing and process spawn', async () => {
  await resetRuntime()
  const calls = []
  const status = await startCodexAppServerRuntime(successfulStartOptions({
    verifySignature: async () => {
      calls.push('signature')
      return false
    },
    readVersion: async () => {
      calls.push('version')
      return '0.150.0'
    },
    spawnImpl: () => {
      calls.push('spawn')
      return fakeChild()
    },
  }))

  assert.deepEqual(calls, ['signature'])
  assert.equal(status.failureStage, 'signature')
  assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.CLI_SIGNATURE_INVALID)
  assert.deepEqual(Object.keys(status).sort(), PUBLIC_STATUS_KEYS)
})

test('signature, version, and spawn use one snapshot that is cleaned only after proven exit', async () => {
  await resetRuntime()
  const snapshotPath = 'C:\\Temp\\gugo-codex-random\\codex.exe'
  const calls = []
  let child
  let cleanups = 0
  const status = await startCodexAppServerRuntime(successfulStartOptions({
    snapshotExecutable(executable) {
      calls.push(['snapshot', executable])
      return {
        path: snapshotPath,
        cleanup() { cleanups += 1 },
      }
    },
    verifySignature: async (executable) => {
      calls.push(['signature', executable])
      return true
    },
    readVersion: async (executable) => {
      calls.push(['version', executable])
      return '0.150.0-alpha.8'
    },
    spawnImpl: (executable) => {
      calls.push(['spawn', executable])
      child = fakeChild(emitSuccessfulInitialize)
      return child
    },
  }))

  assert.equal(status.ready, true)
  assert.deepEqual(calls, [
    ['snapshot', 'C:\\Codex\\codex.exe'],
    ['signature', snapshotPath],
    ['version', snapshotPath],
    ['spawn', snapshotPath],
  ])
  assert.equal(cleanups, 0)

  assert.equal(await closeCodexAppServerRuntime({
    terminate: async () => true,
    exitTimeoutMs: 20,
  }), false)
  assert.equal(cleanups, 0)
  assert.equal(await closeCodexAppServerRuntime({
    terminate: async () => {
      child.emitExit()
      return true
    },
    exitTimeoutMs: 100,
  }), true)
  assert.equal(cleanups, 1)
})

test('app-server publishes readiness only after initialize succeeds and initialized is sent', async () => {
  await resetRuntime()
  const messages = []
  let child
  let releaseInitialize
  const allowInitialize = new Promise((resolve) => { releaseInitialize = resolve })
  const started = startCodexAppServerRuntime(successfulStartOptions({
    spawnImpl(executable, args, options) {
      assert.equal(executable, 'C:\\Codex\\codex.exe')
      assert.deepEqual(args, ['app-server'])
      assert.equal(options.shell, false)
      assert.equal(options.windowsHide, true)
      child = fakeChild(async (message, runningChild) => {
        messages.push(message)
        if (message.method !== 'initialize') return
        await allowInitialize
        emitSuccessfulInitialize(message, runningChild)
      })
      return child
    },
  }))

  await nextTurn()
  assert.equal(getCodexAppServerStatus().ready, false)
  assert.equal(getCodexAppServerStatus().reasonCode, CODEX_APP_SERVER_REASON.STARTING)
  releaseInitialize()
  const status = await started
  assert.deepEqual(status, {
    enabled: true,
    configured: false,
    discovered: true,
    signatureValid: true,
    version: '0.150.0-alpha.8',
    ready: true,
    failureStage: null,
    reasonCode: CODEX_APP_SERVER_REASON.READY,
  })
  assert.equal(messages[0].method, 'initialize')
  assert.equal(messages[0].params.clientInfo.name, 'gugo')
  assert.equal(messages[0].params.clientInfo.version, PACKAGE_VERSION)
  assert.equal(messages[1].method, 'initialized')

  assert.equal(await closeCodexAppServerRuntime({
    terminate: async ({ child: target }) => {
      target.emitExit()
      return true
    },
    exitTimeoutMs: 100,
  }), true)
  assert.equal(getCodexAppServerStatus().reasonCode, CODEX_APP_SERVER_REASON.STOPPED)
})

test('an unset handshake timeout uses the default instead of collapsing to one millisecond', async () => {
  await resetRuntime()
  const options = successfulStartOptions({
    env: {
      CODEX_APP_SERVER_ENABLED: '1',
      CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS: '',
    },
    spawnImpl: () => fakeChild((message, child) => {
      if (message.method !== 'initialize') return
      setTimeout(() => emitSuccessfulInitialize(message, child), 20)
    }),
  })
  delete options.handshakeTimeoutMs

  const status = await startCodexAppServerRuntime(options)
  assert.equal(status.ready, true)
  await resetRuntime()
})

test('global start singleflight launches exactly one app-server process', async () => {
  await resetRuntime()
  let releaseSignature
  const signatureGate = new Promise((resolve) => { releaseSignature = resolve })
  let spawns = 0
  const options = successfulStartOptions({
    verifySignature: () => signatureGate,
    spawnImpl: () => {
      spawns += 1
      return fakeChild(emitSuccessfulInitialize)
    },
  })
  const first = startCodexAppServerRuntime(options)
  const second = startCodexAppServerRuntime(options)
  assert.equal(first, second)
  releaseSignature(true)
  const [firstStatus, secondStatus] = await Promise.all([first, second])
  assert.equal(firstStatus.ready, true)
  assert.equal(secondStatus.ready, true)
  assert.equal(spawns, 1)
  await resetRuntime()
})

test('singleflight start callers have independent cancellation signals', async () => {
  await resetRuntime()
  let releaseSignature
  const signatureGate = new Promise((resolve) => { releaseSignature = resolve })
  let spawns = 0
  const firstController = new AbortController()
  const secondController = new AbortController()
  const options = successfulStartOptions({
    verifySignature: () => signatureGate,
    spawnImpl: () => {
      spawns += 1
      return fakeChild(emitSuccessfulInitialize)
    },
  })

  const first = startCodexAppServerRuntime({ ...options, signal: firstController.signal })
  const second = startCodexAppServerRuntime({ ...options, signal: secondController.signal })
  firstController.abort(new DOMException('private first caller reason', 'AbortError'))

  const firstStatus = await first
  assert.equal(firstStatus.ready, false)
  assert.equal(firstStatus.reasonCode, CODEX_APP_SERVER_REASON.START_ABORTED)

  releaseSignature(true)
  const secondStatus = await second
  assert.equal(secondStatus.ready, true)
  assert.equal(spawns, 1)
  assert.equal(getCodexAppServerStatus().reasonCode, CODEX_APP_SERVER_REASON.READY)
  await resetRuntime()
})

test('a pre-aborted singleflight joiner never inherits another caller ready result', async () => {
  await resetRuntime()
  let releaseSignature
  const signatureGate = new Promise((resolve) => { releaseSignature = resolve })
  const options = successfulStartOptions({ verifySignature: () => signatureGate })
  const first = startCodexAppServerRuntime(options)
  const controller = new AbortController()
  controller.abort()
  const cancelled = await startCodexAppServerRuntime({ ...options, signal: controller.signal })
  assert.equal(cancelled.ready, false)
  assert.equal(cancelled.reasonCode, CODEX_APP_SERVER_REASON.START_ABORTED)

  releaseSignature(true)
  assert.equal((await first).ready, true)
  await resetRuntime()
})

test('initialize and initialized writes share one handshake deadline', async () => {
  await resetRuntime()
  const startedAt = Date.now()
  let writes = 0
  const status = await startCodexAppServerRuntime(successfulStartOptions({
    spawnImpl: () => {
      const child = fakeChild()
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          writes += 1
          const message = JSON.parse(chunk.toString('utf8'))
          if (message.method === 'initialize') {
            callback()
            setTimeout(() => emitSuccessfulInitialize(message, child), 180)
          }
          // Keep the initialized notification callback pending. It must only
          // receive the time left from the original handshake deadline.
        },
      })
      return child
    },
    terminate: async ({ child }) => {
      child.emitExit()
      return true
    },
    handshakeTimeoutMs: 250,
  }))
  const elapsedMs = Date.now() - startedAt

  assert.equal(writes, 2)
  assert.equal(status.failureStage, 'handshake')
  assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.HANDSHAKE_TIMEOUT)
  assert.ok(elapsedMs < 360, `handshake exceeded its shared deadline: ${elapsedMs}ms`)
  await resetRuntime()
})

test('close during start aborts the handshake, proves exit, and never leaves STARTING', async () => {
  await resetRuntime()
  let child
  const options = successfulStartOptions({
    spawnImpl: () => {
      child = fakeChild()
      return child
    },
    terminate: async ({ child: target }) => {
      target.emitExit()
      return true
    },
    handshakeTimeoutMs: 2_000,
  })
  const started = startCodexAppServerRuntime(options)
  await nextTurn()
  const closed = closeCodexAppServerRuntime({ exitTimeoutMs: 100 })
  const [startStatus, closeResult] = await Promise.all([started, closed])

  assert.equal(startStatus.reasonCode, CODEX_APP_SERVER_REASON.STOPPED)
  assert.equal(closeResult, true)
  assert.equal(getCodexAppServerStatus().reasonCode, CODEX_APP_SERVER_REASON.STOPPED)
  assert.equal(getCodexAppServerStatus().ready, false)
  assert.ok(child)
})

test('asynchronous spawn ENOENT is classified as spawn failure and leaves no stuck runtime', async () => {
  await resetRuntime()
  let terminations = 0
  const status = await startCodexAppServerRuntime(successfulStartOptions({
    spawnImpl: () => {
      const child = fakeChild()
      delete child.pid
      setImmediate(() => {
        const error = new Error('private ENOENT detail')
        error.code = 'ENOENT'
        child.emit('error', error)
        child.emit('close', -4058, null)
      })
      return child
    },
    terminate: async () => {
      terminations += 1
      return false
    },
  }))

  assert.equal(status.failureStage, 'spawn')
  assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.SPAWN_FAILED)
  assert.equal(terminations, 0)
  assert.equal(JSON.stringify(status).includes('private'), false)

  const restarted = await startCodexAppServerRuntime(successfulStartOptions())
  assert.equal(restarted.ready, true)
  await resetRuntime()
})

test('a malformed response wins over a stalled stdin callback without unhandled rejection', async () => {
  await resetRuntime()
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const status = await startCodexAppServerRuntime(successfulStartOptions({
      spawnImpl: () => {
        const child = fakeChild()
        child.stdin = new Writable({
          write() {
            // Deliberately never complete the write callback.
          },
        })
        setImmediate(() => child.stdout.write('{bad json}\n'))
        return child
      },
      terminate: async ({ child }) => {
        child.emitExit()
        return true
      },
      handshakeTimeoutMs: 80,
    }))

    assert.equal(status.failureStage, 'handshake')
    assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    await resetRuntime()
  }
})

test('a protocol fatal wins while the initialized write callback is stalled', async () => {
  await resetRuntime()
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    let writes = 0
    const status = await startCodexAppServerRuntime(successfulStartOptions({
      spawnImpl: () => {
        const child = fakeChild()
        child.stdin = new Writable({
          write(chunk, _encoding, callback) {
            writes += 1
            const message = JSON.parse(chunk.toString('utf8'))
            if (writes === 1) {
              callback()
              setImmediate(() => emitSuccessfulInitialize(message, child))
              return
            }
            assert.equal(message.method, 'initialized')
            setImmediate(() => child.stdout.write('{bad json}\n'))
            // Deliberately leave the second write callback pending.
          },
        })
        return child
      },
      terminate: async ({ child }) => {
        child.emitExit()
        return true
      },
      handshakeTimeoutMs: 80,
    }))

    assert.equal(writes, 2)
    assert.equal(status.failureStage, 'handshake')
    assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    await resetRuntime()
  }
})

test('a protocol line over 1 MiB is rejected before newline buffering can grow', async () => {
  await resetRuntime()
  let terminated = 0
  const status = await startCodexAppServerRuntime(successfulStartOptions({
    spawnImpl: () => fakeChild((message, child) => {
      if (message.method === 'initialize') child.stdout.write(Buffer.alloc((1024 * 1024) + 1, 0x78))
    }),
    terminate: async ({ child }) => {
      terminated += 1
      child.emitExit()
      return true
    },
  }))

  assert.equal(status.ready, false)
  assert.equal(status.failureStage, 'handshake')
  assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
  assert.equal(terminated, 1)
})

test('one-byte stdout fragments use bounded line storage', async () => {
  await resetRuntime()
  const originalConcat = Buffer.concat
  let largestConcatInput = 0
  Buffer.concat = function boundedConcat(chunks, ...args) {
    largestConcatInput = Math.max(largestConcatInput, chunks.length)
    return originalConcat.call(Buffer, chunks, ...args)
  }
  try {
    const singleBytes = Array.from({ length: 256 }, (_, value) => Buffer.from([value]))
    const status = await startCodexAppServerRuntime(successfulStartOptions({
      spawnImpl: () => fakeChild((message, child) => {
        if (message.method !== 'initialize') return
        const response = Buffer.from(`${JSON.stringify({
          id: message.id,
          result: { userAgent: 'x'.repeat(256 * 1024) },
        })}\n`)
        for (const value of response) child.stdout.emit('data', singleBytes[value])
      }),
    }))

    assert.equal(status.ready, true)
    assert.ok(largestConcatInput < 64, `retained ${largestConcatInput} stdout fragments`)
  } finally {
    Buffer.concat = originalConcat
    await resetRuntime()
  }
})

test('permanent process listeners convert post-ready child errors into stable runtime status', async () => {
  await resetRuntime()
  let child
  const status = await startCodexAppServerRuntime(successfulStartOptions({
    spawnImpl: () => {
      child = fakeChild(emitSuccessfulInitialize)
      return child
    },
    terminate: async ({ child: target }) => {
      target.emitExit()
      return true
    },
  }))
  assert.equal(status.ready, true)

  child.emit('error', new Error('private spawn detail'))
  await nextTurn()
  await nextTurn()
  const failed = getCodexAppServerStatus()
  assert.equal(failed.ready, false)
  assert.equal(failed.failureStage, 'runtime')
  assert.equal(failed.reasonCode, CODEX_APP_SERVER_REASON.PROCESS_EXITED)
  assert.equal(JSON.stringify(failed).includes('private'), false)
})

test('close does not publish STOPPED when termination fails or exit is unproven', async () => {
  await resetRuntime()
  await startCodexAppServerRuntime(successfulStartOptions())
  assert.equal(await closeCodexAppServerRuntime({
    terminate: async () => false,
    exitTimeoutMs: 20,
  }), false)
  assert.equal(getCodexAppServerStatus().reasonCode, CODEX_APP_SERVER_REASON.TERMINATION_FAILED)
  assert.equal(getCodexAppServerStatus().ready, false)

  assert.equal(await closeCodexAppServerRuntime({
    terminate: async () => true,
    exitTimeoutMs: 20,
  }), false)
  assert.equal(getCodexAppServerStatus().reasonCode, CODEX_APP_SERVER_REASON.TERMINATION_FAILED)
  assert.equal(getCodexAppServerStatus().ready, false)

  assert.equal(await closeCodexAppServerRuntime({
    terminate: async ({ child }) => {
      child.emitExit()
      return true
    },
    exitTimeoutMs: 100,
  }), true)
  assert.equal(getCodexAppServerStatus().reasonCode, CODEX_APP_SERVER_REASON.STOPPED)
})

test('close signal bounds a hung terminator and releases later shutdown attempts', async () => {
  await resetRuntime()
  await startCodexAppServerRuntime(successfulStartOptions())
  const controller = new AbortController()
  const closing = closeCodexAppServerRuntime({
    terminate: async () => new Promise(() => {}),
    exitTimeoutMs: 2_000,
    signal: controller.signal,
  })
  controller.abort()
  assert.equal(await closing, false)
  assert.equal(getCodexAppServerStatus().reasonCode, CODEX_APP_SERVER_REASON.TERMINATION_FAILED)
  assert.equal(await closeCodexAppServerRuntime({
    terminate: async ({ child }) => {
      child.emitExit()
      return true
    },
    exitTimeoutMs: 100,
  }), true)
})

test('slow successful termination uses its own budget before exit proof', async () => {
  await resetRuntime()
  await startCodexAppServerRuntime(successfulStartOptions())
  const startedAt = Date.now()
  const closed = await closeCodexAppServerRuntime({
    terminate: async ({ child }) => {
      await new Promise((resolve) => setTimeout(resolve, 35))
      child.emitExit()
      return true
    },
    terminateTimeoutMs: 100,
    exitTimeoutMs: 20,
  })
  assert.equal(closed, true)
  assert.ok(Date.now() - startedAt >= 30)
  assert.equal(getCodexAppServerStatus().reasonCode, CODEX_APP_SERVER_REASON.STOPPED)
})

test('close signal bounds joining an existing fatal runtime disposal', async () => {
  await resetRuntime()
  let child
  let releaseTermination
  await startCodexAppServerRuntime(successfulStartOptions({
    spawnImpl: () => {
      child = fakeChild(emitSuccessfulInitialize)
      return child
    },
    terminate: async () => new Promise((resolve) => {
      releaseTermination = () => {
        child.emitExit()
        resolve(true)
      }
    }),
  }))
  child.emit('error', new Error('fatal runtime failure'))
  await nextTurn()

  const controller = new AbortController()
  const closing = closeCodexAppServerRuntime({
    terminate: async () => true,
    signal: controller.signal,
  })
  controller.abort()
  assert.equal(await closing, false)
  assert.equal(getCodexAppServerStatus().reasonCode, CODEX_APP_SERVER_REASON.TERMINATION_FAILED)

  releaseTermination()
  await nextTurn()
  await nextTurn()
  assert.equal((await startCodexAppServerRuntime(successfulStartOptions())).ready, true)
  await resetRuntime()
})

test('request-shaped envelopes cannot impersonate initialize responses', async () => {
  await resetRuntime()
  const status = await startCodexAppServerRuntime(successfulStartOptions({
    spawnImpl: () => fakeChild((message, child) => {
      if (message.method !== 'initialize') return
      child.stdout.write(`${JSON.stringify({
        id: message.id,
        method: 'account/read',
        result: { userAgent: 'forged' },
      })}\n`)
    }),
  }))
  assert.equal(status.ready, false)
  assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
})

test('initialize rejection is redacted to the eight-field public diagnostic shape', async () => {
  await resetRuntime()
  let terminated = 0
  const status = await startCodexAppServerRuntime(successfulStartOptions({
    env: {
      CODEX_APP_SERVER_ENABLED: '1',
      GUGO_CODEX_CLI_PATH: 'C:\\private\\codex.exe',
    },
    spawnImpl: () => fakeChild((message, child) => {
      if (message.method !== 'initialize') return
      child.stdout.write(`${JSON.stringify({
        id: message.id,
        error: { code: -32600, message: 'secret internal failure' },
      })}\n`)
    }),
    terminate: async ({ child }) => {
      terminated += 1
      child.emitExit()
      return true
    },
  }))

  assert.equal(status.ready, false)
  assert.equal(status.configured, true)
  assert.equal(status.reasonCode, CODEX_APP_SERVER_REASON.INITIALIZE_REJECTED)
  assert.equal(terminated, 1)
  assert.deepEqual(Object.keys(status).sort(), PUBLIC_STATUS_KEYS)
  assert.equal(JSON.stringify(status).includes('private'), false)
  assert.equal(JSON.stringify(status).includes('secret'), false)
})
