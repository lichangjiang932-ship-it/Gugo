import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createMcpConnectionSupervisor,
  MCP_CONNECTION_SUPERVISOR_DEFAULTS,
} from '../server/mcp/mcpConnectionSupervisor.js'

class FakeClock {
  constructor() {
    this.time = 0
    this.nextId = 1
    this.timers = new Map()
    this.scheduledDelays = []
  }

  now = () => this.time

  setTimeout = (fn, delay) => {
    const timer = {
      id: this.nextId++,
      at: this.time + Number(delay || 0),
      fn,
      unref() {},
    }
    this.scheduledDelays.push(Number(delay || 0))
    this.timers.set(timer.id, timer)
    return timer
  }

  clearTimeout = (timer) => {
    if (timer) this.timers.delete(timer.id)
  }

  async advance(ms) {
    const target = this.time + ms
    while (true) {
      const due = [...this.timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.time = due.at
      this.timers.delete(due.id)
      due.fn()
      await flushMicrotasks()
    }
    this.time = target
    await flushMicrotasks()
  }
}

class FakeTransport {
  constructor(label) {
    this.label = label
    this.alive = true
    this.stopCalls = 0
    this.handlers = {
      error: new Set(),
      close: new Set(),
      exit: new Set(),
    }
  }

  isAlive() { return this.alive }

  stop() {
    this.stopCalls += 1
    this.alive = false
  }

  onError(fn) { this.handlers.error.add(fn); return () => this.handlers.error.delete(fn) }
  onClose(fn) { this.handlers.close.add(fn); return () => this.handlers.close.delete(fn) }
  onExit(fn) { this.handlers.exit.add(fn); return () => this.handlers.exit.delete(fn) }

  fail(kind = 'error', message = `${this.label} failed`) {
    this.alive = false
    const error = new Error(message)
    const value = kind === 'error'
      ? error
      : { reason: error, intentional: false }
    for (const handler of this.handlers[kind]) handler(value)
  }
}

function fakeConnection(label, tools = []) {
  return { transport: new FakeTransport(label), tools }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

function supervisorOptions(clock, overrides = {}) {
  return {
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    options: overrides,
  }
}

test('K1: disconnect enters recovering state and reconnects after the first 500ms backoff', async () => {
  const clock = new FakeClock()
  const connections = []
  const states = []
  const supervisor = createMcpConnectionSupervisor({
    ...supervisorOptions(clock),
    connect: ({ generation }) => {
      const connection = fakeConnection(`generation-${generation}`)
      connections.push(connection)
      return connection
    },
    onStateChange: (state) => states.push(`${state.status}:${state.attempt}`),
  })
  const server = { id: 'server-a' }

  const first = await supervisor.ensure('user-a', server)
  first.transport.fail('exit')

  assert.equal(supervisor.getState('user-a', server.id).status, 'reconnecting')
  assert.equal(supervisor.getState('user-a', server.id).attempt, 1)
  assert.equal(first.transport.stopCalls, 1)

  const waitingEnsure = supervisor.ensure('user-a', server)
  await clock.advance(499)
  assert.equal(connections.length, 1)
  await clock.advance(1)
  const second = await waitingEnsure

  assert.equal(connections.length, 2)
  assert.equal(second, connections[1])
  assert.equal(supervisor.getState('user-a', server.id).status, 'connected')
  assert.deepEqual(states.slice(0, 4), [
    'connecting:0',
    'connected:0',
    'reconnecting:1',
    'reconnecting:1',
  ])

  // A late event from the disposed generation must not disturb the replacement.
  first.transport.fail('error', 'late old-generation error')
  assert.equal(supervisor.getState('user-a', server.id).status, 'connected')
  supervisor.shutdown()
})

test('K1: five failed reconnect attempts exhaust the budget and manual reconnect resets it', async () => {
  const clock = new FakeClock()
  let calls = 0
  let failReconnects = true
  const supervisor = createMcpConnectionSupervisor({
    ...supervisorOptions(clock),
    connect: () => {
      calls += 1
      if (calls > 1 && failReconnects) throw new Error(`connect failure ${calls - 1}`)
      return fakeConnection(`connection-${calls}`)
    },
  })
  const server = { id: 'budget-server' }
  const first = await supervisor.ensure('budget-user', server)
  first.transport.fail('close')

  for (const delay of [500, 1_000, 2_000, 4_000, 8_000]) {
    assert.equal(supervisor.getState('budget-user', server.id).status, 'reconnecting')
    await clock.advance(delay)
  }

  const failed = supervisor.getState('budget-user', server.id)
  assert.equal(calls, 6, 'one initial connection plus exactly five reconnect attempts')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.attempt, 5)
  await assert.rejects(
    supervisor.ensure('budget-user', server),
    (error) => error.code === 'mcp_connection_failed' && error.retryable === false,
  )

  failReconnects = false
  const manuallyReconnected = await supervisor.ensure('budget-user', server, { manual: true })
  assert.ok(manuallyReconnected.transport.isAlive())
  assert.equal(supervisor.getState('budget-user', server.id).status, 'connected')
  assert.equal(supervisor.getState('budget-user', server.id).attempt, 0)

  const retryDelays = clock.scheduledDelays.filter((delay) => delay < MCP_CONNECTION_SUPERVISOR_DEFAULTS.stableWindowMs)
  assert.deepEqual(retryDelays, [500, 1_000, 2_000, 4_000, 8_000])
  assert.equal(supervisor.delayForAttempt(10), 30_000, 'exponential backoff must cap at 30s')
  supervisor.shutdown()
})

test('K1: a 60s stable connection resets the retry budget', async () => {
  const clock = new FakeClock()
  const connections = []
  const supervisor = createMcpConnectionSupervisor({
    ...supervisorOptions(clock),
    connect: () => {
      const connection = fakeConnection(`stable-${connections.length + 1}`)
      connections.push(connection)
      return connection
    },
  })
  const server = { id: 'stable-server' }

  const first = await supervisor.ensure('stable-user', server)
  first.transport.fail()
  await clock.advance(500)
  assert.equal(supervisor.getState('stable-user', server.id).attempt, 1)

  await clock.advance(59_999)
  connections[1].transport.fail()
  assert.equal(supervisor.getState('stable-user', server.id).attempt, 2)
  await clock.advance(1_000)
  assert.equal(supervisor.getState('stable-user', server.id).attempt, 2)

  await clock.advance(60_000)
  assert.equal(supervisor.getState('stable-user', server.id).attempt, 0)
  connections[2].transport.fail()
  assert.equal(supervisor.getState('stable-user', server.id).attempt, 1)
  supervisor.shutdown()
})

test('K1: same server id is isolated by user and reconnect ensure never overlaps spawn', async () => {
  const clock = new FakeClock()
  const connections = new Map()
  const pendingReconnect = deferred()
  let activeConnects = 0
  let maxActiveConnects = 0
  let userACalls = 0
  const supervisor = createMcpConnectionSupervisor({
    ...supervisorOptions(clock),
    connect: async ({ userId, reconnecting }) => {
      activeConnects += 1
      maxActiveConnects = Math.max(maxActiveConnects, activeConnects)
      try {
        if (userId === 'user-a') {
          userACalls += 1
          if (reconnecting) return await pendingReconnect.promise
        }
        const connection = fakeConnection(`${userId}-${connections.size}`)
        connections.set(userId, connection)
        return connection
      } finally {
        activeConnects -= 1
      }
    },
  })
  const server = { id: 'shared-server-id' }
  const userAConnection = await supervisor.ensure('user-a', server)
  await supervisor.ensure('user-b', server)

  userAConnection.transport.fail()
  assert.equal(supervisor.getState('user-a', server.id).status, 'reconnecting')
  assert.equal(supervisor.getState('user-b', server.id).status, 'connected')

  await clock.advance(500)
  const waitingEnsure = supervisor.ensure('user-a', server)
  await flushMicrotasks()
  assert.equal(userACalls, 2)
  assert.equal(maxActiveConnects, 1)

  const recovered = fakeConnection('user-a-recovered')
  pendingReconnect.resolve(recovered)
  assert.equal(await waitingEnsure, recovered)
  assert.equal(maxActiveConnects, 1)
  assert.equal(supervisor.getState('user-b', server.id).status, 'connected')
  supervisor.shutdown()
})

test('K1: disconnect cancels pending backoff and shutdown cancels stable timers', async () => {
  const clock = new FakeClock()
  let calls = 0
  const supervisor = createMcpConnectionSupervisor({
    ...supervisorOptions(clock),
    connect: () => {
      calls += 1
      return fakeConnection(`cancel-${calls}`)
    },
  })
  const first = await supervisor.ensure('cancel-user', { id: 'cancel-server' })
  first.transport.fail()
  assert.equal(supervisor.disconnect('cancel-user', 'cancel-server'), true)
  await clock.advance(120_000)
  assert.equal(calls, 1)
  assert.equal(supervisor.getState('cancel-user', 'cancel-server'), null)

  await supervisor.ensure('other-user', { id: 'other-server' })
  assert.equal(supervisor.shutdown(), 1)
  await clock.advance(120_000)
  assert.equal(clock.timers.size, 0)
})

test('K1: reconnect tool snapshots are diffed and emit tools/change', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-mcp-supervisor-tools-'))
  process.env.APP_DATA_DIR = tempDir
  process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
  const [{ _mcpManagerInternals, onMcpToolsChange }, { getDynamicTool, unregisterByOrigin }] = await Promise.all([
    import('../server/mcp/mcpManager.js'),
    import('../server/services/toolRegistry.js'),
  ])
  const userId = 'tool-diff-user'
  const server = { id: 'tool-diff-server', name: 'Tool Diff', enabled: true }
  const events = []
  const unsubscribe = onMcpToolsChange((event) => events.push(event))
  const first = {
    tools: [
      { name: 'alpha', description: 'alpha v1', inputSchema: { type: 'object' } },
      { name: 'beta', description: 'beta v1', inputSchema: { type: 'object' } },
    ],
  }
  const second = {
    tools: [
      { name: 'beta', description: 'beta v2', inputSchema: { type: 'object' } },
      { name: 'gamma', description: 'gamma v1', inputSchema: { type: 'object' } },
    ],
  }

  _mcpManagerInternals.synchronizeToolsForConnection(userId, server, null, first)
  assert.ok(getDynamicTool('mcp__Tool_Diff__alpha', { userId }))
  assert.ok(getDynamicTool('mcp__Tool_Diff__beta', { userId }))

  const changes = _mcpManagerInternals.synchronizeToolsForConnection(userId, server, first, second)
  assert.deepEqual(changes, {
    added: ['mcp__Tool_Diff__gamma'],
    removed: ['mcp__Tool_Diff__alpha'],
    updated: ['mcp__Tool_Diff__beta'],
  })
  assert.equal(getDynamicTool('mcp__Tool_Diff__alpha', { userId }), null)
  assert.match(getDynamicTool('mcp__Tool_Diff__beta', { userId }).spec.function.description, /v2/)
  assert.ok(getDynamicTool('mcp__Tool_Diff__gamma', { userId }))
  assert.equal(events.at(-1).type, 'tools/change')
  assert.deepEqual(events.at(-1).added, ['mcp__Tool_Diff__gamma'])
  assert.deepEqual(events.at(-1).removed, ['mcp__Tool_Diff__alpha'])
  assert.deepEqual(events.at(-1).updated, ['mcp__Tool_Diff__beta'])

  unsubscribe()
  unregisterByOrigin('mcp', `${userId}:${server.id}`, { userId })
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('K1: reconnect rotates MCP registration identity even when the schema is unchanged', async () => {
  const [
    { _mcpManagerInternals },
    {
      getDynamicTool,
      getDynamicToolSpecRegistrationId,
      matchesDynamicToolRegistration,
      unregisterByOrigin,
    },
    { buildCurrentRegisteredToolSpec },
  ] = await Promise.all([
    import('../server/mcp/mcpManager.js'),
    import('../server/services/toolRegistry.js'),
    import('../server/mcp/mcpToolRegistry.js'),
  ])
  const userId = 'tool-generation-user'
  const server = { id: 'tool-generation-server', name: 'Generation Server', enabled: true }
  const tool = {
    name: 'lookup',
    description: 'stable schema',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  }
  const first = { tools: [tool] }
  const second = { tools: [{ ...tool }] }
  const fullName = 'mcp__Generation_Server__lookup'

  _mcpManagerInternals.synchronizeToolsForConnection(userId, server, null, first)
  const firstRegistration = getDynamicTool(fullName, { userId })
  const firstId = firstRegistration.registrationId
  const firstSpec = firstRegistration.spec
  assert.equal(getDynamicToolSpecRegistrationId(firstSpec), firstId)

  const changes = _mcpManagerInternals.synchronizeToolsForConnection(userId, server, first, second)
  assert.deepEqual(changes, { added: [], removed: [], updated: [fullName] })
  const secondRegistration = getDynamicTool(fullName, { userId })
  assert.notEqual(secondRegistration.registrationId, firstId)
  assert.equal(matchesDynamicToolRegistration(fullName, firstId, { userId }), false)
  assert.equal(getDynamicToolSpecRegistrationId(firstSpec), firstId)

  const rebuilt = buildCurrentRegisteredToolSpec({ userId, server, tool: second.tools[0], connection: second })
  assert.ok(rebuilt)
  assert.equal(getDynamicToolSpecRegistrationId(rebuilt), secondRegistration.registrationId)

  unregisterByOrigin('mcp', `${userId}:${server.id}`, { userId })
})

test('MCP tools that normalize to the same model-facing name fail closed', async () => {
  const [{ _mcpManagerInternals }, { getDynamicTool, unregisterByOrigin }] = await Promise.all([
    import('../server/mcp/mcpManager.js'),
    import('../server/services/toolRegistry.js'),
  ])
  const userId = 'tool-name-collision-user'
  const server = { id: 'tool-name-collision-server', name: 'Collision Server', enabled: true }
  const connection = {
    tools: [
      { name: 'read-file', inputSchema: { type: 'object' } },
      { name: 'read file', inputSchema: { type: 'object' } },
    ],
  }
  const fullName = 'mcp__Collision_Server__read_file'

  const changes = _mcpManagerInternals.synchronizeToolsForConnection(
    userId,
    server,
    null,
    connection,
  )
  assert.deepEqual(changes, { added: [], removed: [], updated: [] })
  assert.equal(connection._mcpToolRegistrations.size, 0)
  assert.equal(getDynamicTool(fullName, { userId }), null)

  unregisterByOrigin('mcp', `${userId}:${server.id}`, { userId })
})
