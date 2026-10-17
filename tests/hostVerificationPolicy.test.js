import assert from 'node:assert/strict'
import { AsyncResource } from 'node:async_hooks'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

import { migrateToV79 } from '../server/migrations/v79SideEffectExecutions.js'
import { migrateToV92 } from '../server/migrations/v92HookSideEffectExecutions.js'
import { migrateToV96 } from '../server/migrations/v96SideEffectRecoveryPlans.js'
import {
  createSideEffectScope,
  createSideEffectExecutionLedger,
  SIDE_EFFECT_LEDGER_CONFLICT,
  SIDE_EFFECT_OUTCOME_UNKNOWN,
  sideEffectRecoveryBlock,
} from '../server/services/sideEffectExecutionLedger.js'
import { createSideEffectExecution } from '../server/services/loop/sideEffectExecution.js'

import {
  assertToolCall,
  beforeModelRequest,
  configureHostVerificationPolicy,
  isHostVerificationPolicyConfigured,
  projectToolSpecs,
} from '../server/core/hostVerificationPolicy.js'
import { fetchModelOutbound } from '../server/adapters/modelEndpoint.js'
import { callBackgroundModel } from '../server/adapters/modelProxy.js'
import { executeServerTool } from '../server/services/loop/heuristics/toolExecutor.js'
import { executeServerTool as compatibilityExecutor } from '../server/services/toolLoopHeuristics.js'
import { createTurnExecutionToolContextRuntime } from '../server/services/turnExecutionToolContextRuntime.js'
import { projectToolSpecsForRuntimePolicy, resolveTurnToolSpecs } from '../server/services/turnToolSpecs.js'
import { registerDynamicTool, unregisterDynamicTool } from '../server/utils/toolSchemaCatalog.js'
import { classifyToolRisk } from '../server/utils/approvalPolicy.js'

const spec = name => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
})
const hooks = overrides => ({
  projectToolSpecs: specs => specs,
  assertToolCall: () => {},
  beforeModelRequest: () => {},
  ...overrides,
})
const names = specs => specs.map(entry => entry.function.name)
const writableAccess = () => ({
  grants: [{ resourceType: 'directory', accessMode: 'read_write', available: true }],
  runtime: { localCodeExecutionEnabled: true },
})
const refusal = () => Object.assign(new Error('fixture host refusal'), {
  code: 'FIXTURE_HOST_DENIED', retryable: false, unsafeToReplay: true,
  modelRequestOutcome: 'not_sent',
})

function lease(t, overrides) {
  const { release } = configureHostVerificationPolicy(hooks(overrides))
  t.after(release)
  return release
}

test('unconfigured policy is a no-op and preserves the original dispatcher identity and resume support', async () => {
  const input = [spec('reflect'), spec('write_file')]
  assert.equal(projectToolSpecs(input), input)
  assert.equal(Object.isFrozen(input[0].function.parameters), false)
  assert.equal(assertToolCall('bash_exec', { command: 'unused' }), undefined)
  assert.equal(beforeModelRequest('https://offline.invalid/v1'), undefined)
  assert.equal(executeServerTool, compatibilityExecutor)
  assert.equal(executeServerTool.supportsIdempotentResume({ name: 'write_file', idempotencyKey: 'key' }), true)
  assert.equal(executeServerTool.supportsIdempotentResume({ name: 'bash_exec', idempotencyKey: 'key' }), false)
  assert.equal((await executeServerTool({ name: 'reflect', args: {
    observation: 'original dispatcher', next_step: 'done',
  } })).ok, true)
  let calls = 0
  await fetchModelOutbound('https://offline.invalid/v1', {}, {
    fetchImpl: async (_url, init) => {
      calls += 1
      assert.equal(init.redirect, 'manual')
      return new Response('{}')
    },
  })
  assert.equal(calls, 1)
})

test('configuration requires all three function hooks and rejects invalid leases atomically', t => {
  for (const input of [null, undefined, [], () => {}, {},
    hooks({ projectToolSpecs: null }), hooks({ assertToolCall: false }),
    hooks({ beforeModelRequest: 'not callable' })]) {
    assert.throws(() => configureHostVerificationPolicy(input), TypeError)
  }
  assert.equal(isHostVerificationPolicyConfigured(), false)
  const release = lease(t)
  assert.equal(isHostVerificationPolicyConfigured(), true)
  assert.throws(() => configureHostVerificationPolicy(hooks()), {
    code: 'HOST_VERIFICATION_POLICY_ALREADY_CONFIGURED',
  })
  assert.equal(release(), true)
  assert.equal(isHostVerificationPolicyConfigured(), false)
  assert.equal(release(), false)
})

test('lease snapshots only its three hooks and an old release cannot clear the next lease', t => {
  const seen = []
  const input = hooks({ beforeModelRequest(url) { seen.push([this.label, url]) } })
  input.label = 'first'
  Object.defineProperty(input, 'unused', { get() { throw new Error('unrelated property read') } })
  const { release: releaseFirst } = configureHostVerificationPolicy(input)
  t.after(releaseFirst)
  input.beforeModelRequest = () => { throw new Error('mutated hook') }
  beforeModelRequest('first-url')
  assert.equal(releaseFirst(), true)
  const releaseSecond = lease(t, { beforeModelRequest: url => seen.push(['second', url]) })
  assert.equal(releaseFirst(), false)
  beforeModelRequest('second-url')
  assert.deepEqual(seen, [['first', 'first-url'], ['second', 'second-url']])
  assert.equal(releaseSecond(), true)
  beforeModelRequest('unconfigured')
  assert.equal(seen.length, 2)
})

test('projection accepts only a reference subset and isolates returned-array mutation', t => {
  const input = [spec('read_file'), spec('write_file')]
  let returned
  lease(t, { projectToolSpecs: source => {
    assert.notEqual(source, input)
    assert.equal(source[0], input[0])
    assert.ok(Object.isFrozen(source))
    returned = [source[0]]
    return returned
  } })
  const result = projectToolSpecs(input)
  assert.deepEqual(result, [input[0]])
  assert.equal(result[0], input[0])
  returned.push(input[1])
  assert.deepEqual(result, [input[0]])
  assert.deepEqual(names(input), ['read_file', 'write_file'])
})

test('active projection cannot mutate a schema or its nested permissions in place', () => {
  for (const mutate of [
    source => { source[0].function.name = 'bash_exec' },
    source => { source[0].function.parameters.properties.injected = { type: 'string' } },
  ]) {
    const input = [spec('read_file')]
    const { release } = configureHostVerificationPolicy(hooks({ projectToolSpecs: source => {
      mutate(source)
      return source
    } }))
    try {
      assert.throws(() => projectToolSpecs(input), TypeError)
      assert.equal(input[0].function.name, 'read_file')
      assert.deepEqual(input[0].function.parameters.properties, {})
    } finally { release() }
  }
})

test('projection rejects injection, clones, duplicates, invalid shapes and async results', () => {
  const input = [spec('read_file')]
  const invalid = [
    () => [spec('bash_exec')],
    source => [structuredClone(source[0])],
    source => [source[0], source[0]],
    () => null,
    () => undefined,
    () => ({ 0: input[0], length: 1 }),
    () => new Array(1),
    async source => source,
    () => Promise.reject(refusal()),
    source => { source.push(spec('bash_exec')); return source },
  ]
  for (const project of invalid) {
    const { release } = configureHostVerificationPolicy(hooks({ projectToolSpecs: project }))
    try { assert.throws(() => projectToolSpecs(input)) }
    finally { release() }
  }
})

test('assertion hook errors propagate unchanged; false and async hooks fail closed', async () => {
  const denied = refusal()
  for (const name of ['assertToolCall', 'beforeModelRequest', 'projectToolSpecs']) {
    const { release } = configureHostVerificationPolicy(hooks({ [name]: () => { throw denied } }))
    try {
      const invoke = name === 'assertToolCall' ? () => assertToolCall('reflect', {})
        : name === 'beforeModelRequest' ? () => beforeModelRequest('url')
          : () => projectToolSpecs([spec('reflect')])
      assert.throws(invoke, error => error === denied)
    } finally { release() }
  }
  for (const name of ['assertToolCall', 'beforeModelRequest']) {
    for (const hook of [() => false, async () => {}, () => Promise.reject(denied)]) {
      const { release } = configureHostVerificationPolicy(hooks({ [name]: hook }))
      try {
        if (name === 'assertToolCall') {
          const result = await executeServerTool({ name: 'reflect', args: {} })
          assert.equal(result.ok, false)
          assert.equal(result.denied, true)
          assert.equal(result.policyDenied, true)
          assert.equal(result.retryable, false)
        } else {
          let sent = 0
          let started = 0
          await assert.rejects(fetchModelOutbound('https://offline.invalid/v1', {}, {
            onRequestStart: () => { started += 1 },
            fetchImpl: async () => { sent += 1; return new Response('{}') },
          }))
          assert.equal(sent, 0)
          assert.equal(started, 0)
        }
      } finally { release() }
    }
  }
})

test('runtime projection is additional subtraction, never permission or approval authority', t => {
  const input = ['read_file', 'write_file', 'bash_exec', 'web_search'].map(spec)
  const seen = []
  lease(t, { projectToolSpecs: source => {
    seen.push(names(source))
    return source.filter(entry => entry.function.name !== 'read_file')
  } })
  const projected = projectToolSpecsForRuntimePolicy(input, {
    permissionMode: 'plan', fileAccessStatus: writableAccess(),
    toolsConfig: { disabled: ['web_search'] }, userToolPermissions: {},
  })
  assert.deepEqual(seen, [['read_file']])
  assert.deepEqual(projected, [])
  assert.equal(classifyToolRisk('fetch_url', { method: 'POST', url: 'https://example.com' }, {
    permissionMode: 'plan', mode: 'unattended', origin: 'chat',
  }).denied, true)
  assert.equal(classifyToolRisk('fetch_url', { method: 'POST', url: 'https://example.com' }, {
    permissionMode: 'normal', mode: 'unattended', origin: 'chat',
  }).needsApproval, true)
})

test('normal, fallback, deferred and directory-restored catalogs all pass through the host projection', async t => {
  const input = ['read_file', 'write_file', 'bash_exec', 'list_directory'].map(spec)
  lease(t, { projectToolSpecs: source => source.filter(entry => entry.function.name === 'read_file') })
  let deferred
  const discovered = await resolveTurnToolSpecs({
    userId: null, baseSpecs: input, enabledConnectorTools: [],
    userToolPermissions: {}, fileAccessStatus: writableAccess(),
    onDeferredSpecs: value => { deferred = value },
  })
  assert.deepEqual(names(discovered), ['read_file'])
  assert.deepEqual(names(deferred), ['read_file'])
  for (const scenario of ['normal', 'fallback', 'deferred', 'restored']) {
    const runtime = createTurnExecutionToolContextRuntime({
      readApprovalMode: () => 'normal',
      readFileAccessStatus: writableAccess,
      resolveToolSpecs: async request => {
        if (scenario === 'fallback') throw new Error('offline discovery unavailable')
        request.onDeferredSpecs(input)
        return scenario === 'restored' ? request.baseSpecs : input
      },
    })
    const result = await runtime.resolve({
      content: 'Read the workspace.', baseToolSpecs: input,
      ...(scenario === 'restored' ? {
        resumeResolution: { type: 'directory_authorization', access_mode: 'read_write' },
        restoredCheckpointState: {
          approvalMode: 'normal', executionEnvironment: {
            toolCatalog: [{ name: 'read_file', spec: input[0] }],
          },
        },
        directoryAuthorizationToolSpecs: input,
      } : {}),
    })
    assert.deepEqual(names(result.resolvedToolSpecs), ['read_file'], scenario)
    assert.deepEqual(names(result.deferredToolSpecs), ['read_file'], scenario)
    assert.equal(result.resolvedToolSpecs[0], input[0])
  }
})

test('a projection failure cannot escape through optional-discovery fallback', async t => {
  const denied = refusal()
  lease(t, { projectToolSpecs: () => { throw denied } })
  const runtime = createTurnExecutionToolContextRuntime({
    readApprovalMode: () => 'normal', readFileAccessStatus: writableAccess,
    resolveToolSpecs: request => resolveTurnToolSpecs({ ...request, enabledConnectorTools: [] }),
  })
  await assert.rejects(runtime.resolve({
    content: 'Read files.', baseToolSpecs: [spec('read_file')],
  }), error => error === denied)
})

test('real executor refusal precedes plugin dispatch and every builtin side-effect branch', async t => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'gugo-host-policy-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const name = 'host_verification_side_effect_fixture'
  let effects = 0
  const args = { path: path.join(workspace, 'must-not-exist.txt'), content: 'forbidden' }
  registerDynamicTool({ name, origin: 'test', spec: spec(name), exec: async () => {
    effects += 1
    return { ok: true }
  } })
  t.after(() => unregisterDynamicTool(name))
  const denied = refusal()
  const seen = []
  const release = lease(t, { assertToolCall: (toolName, toolArgs) => {
    seen.push([toolName, toolArgs])
    throw denied
  } })
  for (const toolName of [name, 'write_file', 'bash_exec', 'bash_background', 'create_docx',
    'Agent', 'mcp__fixture__write', 'browser_click', 'fetch_url']) {
    assert.deepEqual(await executeServerTool({
      name: toolName, args, allowedArtifactTools: new Set(['create_docx']),
    }), {
      ok: false, code: denied.code, error: denied.message,
      retryable: false, denied: true, policyDenied: true,
    })
    assert.equal(seen.at(-1)[0], toolName)
    assert.equal(seen.at(-1)[1], args)
  }
  assert.equal(effects, 0)
  assert.deepEqual(readdirSync(workspace), [])
  release()
  assert.equal((await executeServerTool({ name, args })).ok, true)
  assert.equal(effects, 1)
})

test('a rejected real dispatch settles an already-executing ledger as failed, not unknown or replayable', async t => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateToV79(db)
  migrateToV92(db)
  migrateToV96(db)
  const ledger = createSideEffectExecutionLedger({ db })
  const toolName = 'host_verification_ledger_fixture'
  let effects = 0
  registerDynamicTool({ name: toolName, origin: 'test', spec: spec(toolName), exec: async () => {
    effects += 1
    return { ok: true }
  } })
  t.after(() => unregisterDynamicTool(toolName))
  const job = { id: 'host-verification-job', userId: 'host-verification-owner' }
  const step = { id: 'host-verification-step' }
  const execution = createSideEffectExecution({
    ledger, durableToolNames: new Set([toolName]), toolName,
    call: { id: 'host-call', idempotencyKey: 'host-call-key' },
    job, step, approvalOrigin: 'job', createScope: createSideEffectScope,
    recoveryBlock: sideEffectRecoveryBlock,
    conflictCode: SIDE_EFFECT_LEDGER_CONFLICT, unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
  })
  const args = {}
  const prepared = execution.prepare(args)
  execution.markExecuting(prepared.input)
  assert.equal(ledger.read(prepared.input).status, 'executing')
  lease(t, { assertToolCall: () => { throw refusal() } })
  const result = await executeServerTool({ name: toolName, args, job, step })
  assert.equal(result.policyDenied, true)
  execution.finish(prepared.input, result, value => value.ok === true)
  assert.equal(ledger.read(prepared.input).status, 'failed')
  const replay = execution.prepare(args)
  assert.equal(replay.replayed, true)
  assert.equal(replay.result.code, 'FIXTURE_HOST_DENIED')
  assert.equal(replay.result.retryable, false)
  assert.equal(effects, 0)
})

test('per-physical-fetch reservations include every manual redirect and reject request 13 before start', async t => {
  const events = []
  const denied = refusal()
  let reservations = 0
  lease(t, { beforeModelRequest: url => {
    if (reservations >= 12) throw denied
    reservations += 1
    events.push(['reserve', url])
    return reservations
  } })
  const fetchImpl = async (url, init) => {
    events.push(['fetch', url])
    assert.equal(init.redirect, 'manual')
    const hop = Number(new URL(url).searchParams.get('hop'))
    return hop < 2
      ? new Response(null, { status: 307, headers: { location: `?hop=${hop + 1}` } })
      : new Response('{}')
  }
  const options = { fetchImpl, onRequestStart: () => { events.push(['start']) } }
  for (let index = 0; index < 4; index += 1) {
    await fetchModelOutbound('https://offline.invalid/v1?hop=0', { method: 'POST', body: 'original' }, options)
  }
  assert.equal(reservations, 12)
  assert.equal(events.length, 36)
  for (let index = 0; index < events.length; index += 3) {
    assert.deepEqual(events.slice(index, index + 3).map(entry => entry[0]), ['reserve', 'start', 'fetch'])
    assert.equal(events[index][1], events[index + 2][1])
  }
  await assert.rejects(fetchModelOutbound('https://offline.invalid/v1?hop=0', {}, options), error => error === denied)
  assert.equal(events.length, 36)
  assert.equal(reservations, 12)
})

test('concurrent requests share one process reservation budget with no thirteenth start', async t => {
  let reservations = 0
  let started = 0
  let sent = 0
  lease(t, { beforeModelRequest: () => {
    if (reservations >= 12) throw refusal()
    reservations += 1
  } })
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => (
    fetchModelOutbound('https://offline.invalid/v1', {}, {
      onRequestStart: () => { started += 1 },
      fetchImpl: async () => { sent += 1; return new Response('{}') },
    })
  )))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 12)
  assert.equal(results.filter(result => result.status === 'rejected').length, 8)
  assert.equal(reservations, 12)
  assert.equal(started, 12)
  assert.equal(sent, 12)
})

test('a budget exhausted at a redirect stops that hop before onRequestStart or transport', async t => {
  const denied = refusal()
  let remaining = 1
  let started = 0
  let sent = 0
  lease(t, { beforeModelRequest: () => { if (!remaining--) throw denied } })
  await assert.rejects(fetchModelOutbound('https://offline.invalid/first', {}, {
    onRequestStart: () => { started += 1 },
    fetchImpl: async () => {
      sent += 1
      return new Response(null, { status: 302, headers: { location: '/second' } })
    },
  }), error => error === denied)
  assert.equal(started, 1)
  assert.equal(sent, 1)
})

test('host checks retain injected DNS pinning, redirect semantics and all transport options', async t => {
  const events = []
  const body = 'original-body'
  const controller = new AbortController()
  const header = 'fixture-header'
  lease(t, { beforeModelRequest: url => { events.push(['reserve', url]) } })
  const result = await fetchModelOutbound('https://model.invalid/first', {
    method: 'POST', body, signal: controller.signal, headers: { 'x-fixture': header },
  }, {
    config: { baseUrl: 'https://model.invalid/v1' },
    lookup: async hostname => {
      events.push(['dns', hostname])
      return [{ address: '93.184.216.34', family: 4 }]
    },
    onRequestStart: () => { events.push(['start']) },
    fetchImpl: async (url, init) => {
      events.push(['fetch', url])
      assert.equal(init.redirect, 'manual')
      assert.equal(init.signal, controller.signal)
      assert.equal(typeof init.dispatcher?.dispatch, 'function')
      assert.equal(new Headers(init.headers).get('x-fixture'), header)
      if (url.endsWith('/first')) {
        assert.equal(init.method, 'POST')
        assert.equal(init.body, body)
        return new Response(null, { status: 303, headers: { location: '/second' } })
      }
      assert.equal(init.method, 'GET')
      assert.equal(init.body, undefined)
      return new Response('fixture-result')
    },
  })
  assert.equal(await result.text(), 'fixture-result')
  assert.deepEqual(events.map(entry => entry[0]), ['dns', 'reserve', 'start', 'fetch', 'dns', 'reserve', 'start', 'fetch'])
})

test('without a lease explicit global fetch keeps the original proxy and caller-dispatcher behavior', async t => {
  const originalFetch = globalThis.fetch
  const originalProxy = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://proxy.invalid:3128'
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalProxy === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = originalProxy
  })
  const seen = []
  globalThis.fetch = async (_url, init) => {
    seen.push(init.dispatcher)
    return new Response('{}')
  }
  const ownDispatcher = { fixture: true }
  const url = 'https://93.184.216.34/v1'
  await fetchModelOutbound(url, {}, { fetchImpl: globalThis.fetch })
  assert.equal(seen.at(-1), undefined)
  await fetchModelOutbound(url, { dispatcher: ownDispatcher }, { fetchImpl: globalThis.fetch })
  assert.equal(seen.at(-1), ownDispatcher)
  await fetchModelOutbound(url, {}, { fetchImpl: globalThis.fetch, onRequestStart: () => {} })
  assert.equal(typeof seen.at(-1)?.dispatch, 'function', 'existing onRequestStart wrapper keeps its DNS pin')
})

test('the existing DNS and redirect security gates remain stricter than an allowing host policy', async t => {
  let reserved = 0
  let sent = 0
  lease(t, { beforeModelRequest: () => { reserved += 1 } })
  await assert.rejects(fetchModelOutbound('https://model.invalid/v1', {}, {
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    fetchImpl: async () => { sent += 1 },
  }), { code: 'OUTBOUND_ADDRESS_DENIED' })
  assert.equal(reserved, 0)
  assert.equal(sent, 0)
  await assert.rejects(fetchModelOutbound('https://model.invalid/first', {}, {
    fetchImpl: async () => {
      sent += 1
      return new Response(null, { status: 307, headers: { location: 'https://other.invalid/second' } })
    },
  }), { code: 'OUTBOUND_REDIRECT_CROSS_ORIGIN' })
  assert.equal(reserved, 1)
  assert.equal(sent, 1)
})

test('explicit process scope reaches pre-existing async resources and background-model requests without ALS', async t => {
  const outside = new AsyncResource('host-verification-pre-existing-http-resource')
  t.after(() => outside.emitDestroy())
  let reserved = 0
  let sent = 0
  const release = lease(t, { beforeModelRequest: () => { reserved += 1; throw refusal() } })
  const fetchImpl = async () => { sent += 1; return new Response('{}') }
  await assert.rejects(outside.runInAsyncScope(() => fetchModelOutbound('https://offline.invalid/v1', {}, { fetchImpl })),
    { code: 'FIXTURE_HOST_DENIED' })
  await assert.rejects(callBackgroundModel({
    messages: [{ role: 'user', content: 'offline fixture' }],
    env: { MODEL_BASE_URL: 'https://offline.invalid/v1', MODEL_NAME: 'offline-fixture', MODEL_API_KEY: 'fixture' },
    fetchImpl,
  }), { code: 'FIXTURE_HOST_DENIED' })
  assert.equal(reserved, 2)
  assert.equal(sent, 0)
  release()
  await outside.runInAsyncScope(() => fetchModelOutbound('https://offline.invalid/v1', {}, { fetchImpl }))
  assert.equal(sent, 1)
  assert.equal(reserved, 2)
})
