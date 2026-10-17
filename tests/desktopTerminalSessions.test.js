import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import {
  ensureTerminalSession,
  getTerminalSession,
  killTerminalSession,
  resetTerminalSessions,
  subscribeTerminalSession,
  terminalSessionKey,
  writeTerminalSession,
} from '../src/lib/desktopTerminalSessions.js'

function createHost() {
  const dataHandlers = []
  const exitHandlers = []
  const state = { starts: [], writes: [], resizes: [], kills: [] }
  let resolveStart = null
  const host = {
    start(options) {
      state.starts.push(options)
      return new Promise((resolve) => {
        resolveStart = () => resolve({
          ok: true,
          id: 'terminal-1',
          cwd: options.cwd || '',
          shell: 'C:\\Windows\\cmd.exe',
          cols: 90,
          rows: 30,
        })
      })
    },
    write(id, data) { state.writes.push([id, data]); return Promise.resolve({ ok: true }) },
    resize(id, cols, rows) { state.resizes.push([id, cols, rows]); return Promise.resolve({ ok: true }) },
    kill(id) { state.kills.push(id); return Promise.resolve({ ok: true }) },
    onData(handler) { dataHandlers.push(handler); return () => dataHandlers.splice(dataHandlers.indexOf(handler), 1) },
    onExit(handler) { exitHandlers.push(handler); return () => exitHandlers.splice(exitHandlers.indexOf(handler), 1) },
  }
  return {
    host,
    state,
    resolveStart: () => resolveStart?.(),
    emitData: (payload) => { for (const handler of [...dataHandlers]) handler(payload) },
    emitExit: (payload) => { for (const handler of [...exitHandlers]) handler(payload) },
  }
}

afterEach(() => resetTerminalSessions())

test('one project gets one shell even when two callers ask at the same time', async () => {
  const fake = createHost()
  const first = ensureTerminalSession({ key: terminalSessionKey('C:/one'), cwd: 'C:/one', host: fake.host })
  const second = ensureTerminalSession({ key: terminalSessionKey('C:/one'), cwd: 'C:/one', host: fake.host })
  await Promise.resolve()
  assert.equal(fake.state.starts.length, 1)
  fake.resolveStart()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, b)
  assert.equal(a.id, 'terminal-1')
})

test('output printed before the start reply is replayed to the first subscriber', async () => {
  const fake = createHost()
  const pending = ensureTerminalSession({ cwd: '', host: fake.host })
  await Promise.resolve()
  fake.emitData({ id: 'terminal-1', chunk: 'banner\r\n' })
  fake.resolveStart()
  const session = await pending
  assert.equal(session.id, 'terminal-1')

  const attachment = subscribeTerminalSession('__default__', {})
  assert.equal(attachment.replay, 'banner\r\n')
  fake.emitData({ id: 'terminal-1', chunk: 'prompt> ' })
  assert.equal(fake.state.writes.length, 0)
  assert.equal(attachment.replay, 'banner\r\n', 'the snapshot is what was missed before attaching')
})

test('a detached shell keeps buffering and refuses input once it exits', async () => {
  const fake = createHost()
  const pending = ensureTerminalSession({ cwd: '', host: fake.host })
  await Promise.resolve()
  fake.resolveStart()
  await pending
  const attachment = subscribeTerminalSession('__default__', {})
  attachment.detach()
  fake.emitData({ id: 'terminal-1', chunk: 'kept\r\n' })
  const again = subscribeTerminalSession('__default__', {})
  assert.match(again.replay, /kept/)

  fake.emitExit({ id: 'terminal-1', exitCode: 0 })
  assert.equal(getTerminalSession('').exited, true)
  assert.equal(writeTerminalSession('', 'x'), false)
  assert.deepEqual(fake.state.writes, [])
})

test('kill removes the session; a successful restart starts a new one', async () => {
  const fake = createHost()
  const pending = ensureTerminalSession({ cwd: 'C:/one', host: fake.host })
  await Promise.resolve()
  fake.resolveStart()
  await pending
  assert.equal(killTerminalSession('C:/one'), true)
  assert.equal(getTerminalSession('C:/one'), null)
  assert.deepEqual(fake.state.kills, ['terminal-1'])
})

test('the replay buffer is bounded and resumes on a clean line', async () => {
  const fake = createHost()
  const pending = ensureTerminalSession({ cwd: '', host: fake.host })
  await Promise.resolve()
  fake.resolveStart()
  await pending
  subscribeTerminalSession('__default__', {})
  fake.emitData({ id: 'terminal-1', chunk: `${'x'.repeat(250_000)}\nTAIL` })
  const attachment = subscribeTerminalSession('__default__', {})
  assert.ok(attachment.replay.length < 250_000)
  assert.equal(attachment.replay, 'TAIL')
})
