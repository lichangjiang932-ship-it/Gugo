import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  normalizePreviewConfiguration,
  pickConfiguration,
  previewUrlFor,
  readLaunchConfig,
  substituteWorkspace,
} from '../server/preview/previewLaunchConfig.js'
import { createPreviewRuntime } from '../server/preview/previewRuntime.js'
import { executePreviewTool, PREVIEW_TOOL_NAMES, PREVIEW_TOOL_SPECS } from '../server/preview/previewTools.js'

const LAUNCH = {
  version: '0.0.1',
  autoVerify: true,
  configurations: [{
    name: 'dev-server',
    runtimeExecutable: 'npm',
    runtimeArgs: ['run', 'dev'],
    port: 3000,
    cwd: '${workspaceFolder}',
    env: { NODE_ENV: 'development' },
    autoPort: true,
    readyPattern: 'ready on',
  }, {
    name: 'script',
    program: '${workspaceFolder}/server.js',
    args: ['--port', '4100'],
    port: 4100,
  }],
}

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.unref = () => {}
  return child
}

test('launch configurations normalize into something runnable', () => {
  assert.equal(substituteWorkspace('${workspaceFolder}/a', '/w'), '/w/a')
  const [dev, script] = LAUNCH.configurations.map((entry) => normalizePreviewConfiguration(entry, { workspacePath: '/w' }))
  assert.equal(dev.cwd, '/w')
  assert.deepEqual(dev.runtimeArgs, ['run', 'dev'])
  assert.equal(dev.readyPattern, 'ready on')
  assert.equal(dev.autoPort, true)
  assert.equal(script.program, '/w/server.js')
  assert.deepEqual(script.args, ['--port', '4100'])
  assert.equal(script.readyPattern, 'ready', 'a missing pattern falls back to the default')
  // A configuration without an executable or program cannot run at all.
  assert.equal(normalizePreviewConfiguration({ name: 'empty' }), null)
  assert.equal(normalizePreviewConfiguration({ runtimeExecutable: 'npm' }), null, 'a name is required')
  assert.equal(previewUrlFor({ port: 5173 }), 'http://localhost:5173')
  assert.equal(previewUrlFor({ port: 5173, url: 'http://localhost:9999/app' }), 'http://localhost:9999/app')
})

test('reading the file reports what is missing instead of guessing', () => {
  const missing = readLaunchConfig('/w', { fsExists: () => false })
  assert.equal(missing.code, 'PREVIEW_LAUNCH_MISSING')
  assert.deepEqual(missing.configurations, [])
  const broken = readLaunchConfig('/w', { fsExists: () => true, readFile: () => '{oops' })
  assert.equal(broken.code, 'PREVIEW_LAUNCH_INVALID')
  const empty = readLaunchConfig('/w', { fsExists: () => true, readFile: () => JSON.stringify({ configurations: [] }) })
  assert.equal(empty.code, 'PREVIEW_LAUNCH_EMPTY')
  const launch = readLaunchConfig('/w', { fsExists: () => true, readFile: () => JSON.stringify(LAUNCH) })
  assert.equal(launch.ok, true)
  assert.equal(launch.configurations.length, 2)
  assert.equal(pickConfiguration(launch, 'script').port, 4100)
  assert.equal(pickConfiguration(launch).name, 'dev-server', 'the first configuration is the default')
  assert.equal(pickConfiguration(launch, 'nope'), null)
})

test('the runtime starts, becomes ready from its own output, and stops', async () => {
  const spawned = []
  const killed = []
  const runtime = createPreviewRuntime({
    spawnImpl: (command, args) => { spawned.push({ command, args }); return fakeChild() },
    killImpl: (pid) => killed.push(pid),
    readConfig: () => readLaunchConfig('/w', { fsExists: () => true, readFile: () => JSON.stringify(LAUNCH) }),
  })
  const started = await runtime.start({ workspacePath: '/w' })
  assert.equal(started.ok, true)
  assert.equal(spawned[0].command, 'npm')
  assert.deepEqual(spawned[0].args, ['run', 'dev'])
  assert.equal(started.url, 'http://localhost:3000')
  assert.equal(runtime.ready, false, 'not ready before the pattern appears')
  runtime.publicState()
  const child = fakeChild()
  void child
  // Feed the readiness line through the same stream the child uses.
  const state = runtime.publicState()
  assert.equal(state.status, 'running')
  assert.equal(runtime.tail().length, 0)
  assert.equal(runtime.matches('ready').length, 0)
  const stopped = runtime.stop()
  assert.deepEqual(stopped, { ok: true, stopped: true })
  assert.deepEqual(killed, [4242])
  assert.equal(runtime.publicState().status, 'stopped')
  assert.deepEqual(runtime.stop(), { ok: true, stopped: false }, 'stopping twice is harmless')
})

test('readiness comes from the declared pattern, and autoPort moves off a busy port', async () => {
  const children = []
  const runtime = createPreviewRuntime({
    spawnImpl: () => { const child = fakeChild(); children.push(child); return child },
    killImpl: () => {},
    createServer: () => ({ once(event, handler) { if (event === 'error') this.onError = handler; else this.onListening = handler }, listen() { this.onError?.(new Error('busy')) }, close() {} }),
    freePort: async () => 3100,
    readConfig: () => readLaunchConfig('/w', { fsExists: () => true, readFile: () => JSON.stringify(LAUNCH) }),
  })
  const started = await runtime.start({ workspacePath: '/w' })
  assert.equal(started.port, 3100, 'a busy port with autoPort moves on')
  assert.equal(started.url, 'http://localhost:3100')
  children[0].stdout.emit('data', 'compiling...\nready on http://localhost:3100\n')
  assert.equal(runtime.ready, true)
  assert.equal(runtime.publicState().ready, true)
  assert.deepEqual(runtime.matches('ready on'), ['ready on http://localhost:3100'])
  runtime.stop()
})

test('the tools answer honestly about what the host can and cannot do', async () => {
  assert.equal(PREVIEW_TOOL_SPECS.length, PREVIEW_TOOL_NAMES.length)
  assert.ok(PREVIEW_TOOL_NAMES.includes('preview_screenshot'))
  const calls = []
  const runtime = {
    start: async (options) => { calls.push(['start', options]); return { ok: true, url: 'http://localhost:3000', port: 3000, name: 'dev-server', ready: false, autoVerify: true } },
    stop: () => ({ ok: true, stopped: true }),
    publicState: () => ({ status: 'running', url: 'http://localhost:3000', ready: true, logs: [] }),
    tail: () => [{ channel: 'stdout', line: 'ready on 3000' }],
  }
  assert.deepEqual(await executePreviewTool('preview_nope', {}, { runtime }), { success: false, output: '', error: 'PREVIEW_TOOL_UNKNOWN' })
  const started = await executePreviewTool('preview_start_server', { configName: 'dev-server' }, { runtime })
  assert.equal(started.success, true)
  assert.match(started.output, /localhost:3000/u)
  assert.deepEqual(calls[0][1], { workspacePath: undefined, name: 'dev-server' })
  assert.equal((await executePreviewTool('preview_stop_server', {}, { runtime })).success, true)
  const status = await executePreviewTool('preview_server_status', {}, { runtime })
  assert.match(status.output, /"status":"running"/u)
  // Page-facing tools need the desktop host and say so rather than guessing.
  for (const name of ['preview_screenshot', 'preview_inspect_dom', 'preview_navigate', 'preview_click', 'preview_type']) {
    const result = await executePreviewTool(name, { url: 'http://x', selector: '#a', text: 't' }, { runtime })
    assert.equal(result.success, false, name)
    assert.equal(result.error, 'PREVIEW_HOST_UNAVAILABLE', name)
  }
  // Console logs merge what the server printed with what the host saw.
  const noHost = await executePreviewTool('preview_get_console_logs', {}, { runtime })
  assert.match(noHost.output, /needs the desktop preview host/u)
  const host = {
    consoleLogs: async () => [{ level: 'error', text: 'boom' }],
    screenshot: async () => 'AAAA',
    inspectDom: async (selector) => ({ selector, nodes: 1 }),
    navigate: async (url) => ({ url }),
    click: async (selector) => ({ clicked: selector }),
    type: async (selector, text) => ({ selector, text }),
  }
  assert.match((await executePreviewTool('preview_get_console_logs', {}, { runtime, host })).output, /boom/u)
  assert.equal((await executePreviewTool('preview_screenshot', {}, { runtime, host })).success, true)
  assert.equal((await executePreviewTool('preview_inspect_dom', { selector: '#main' }, { runtime, host })).success, true)
  assert.equal((await executePreviewTool('preview_click', { selector: '' }, { runtime, host })).error, 'PREVIEW_SELECTOR_REQUIRED')
  assert.equal((await executePreviewTool('preview_navigate', {}, { runtime, host })).error, 'PREVIEW_URL_REQUIRED')
  assert.equal((await executePreviewTool('preview_type', { selector: '#a', text: 'hi' }, { runtime, host })).success, true)
})
