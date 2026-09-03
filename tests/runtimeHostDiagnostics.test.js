import assert from 'node:assert/strict'
import test from 'node:test'
import { getRuntimeHostDiagnostics } from '../server/services/runtimeHostDiagnostics.js'

test('runtime host diagnostics expose only public readiness booleans', () => {
  const diagnostics = getRuntimeHostDiagnostics({
    readPersistenceStatus: () => ({
      configured: true,
      adapterId: 'private-adapter-id',
      source: 'private.source',
    }),
    readCompactionStatus: () => ({
      configured: true,
      portId: 'private-port-id',
      source: 'private.source',
    }),
    readCodexStatus: () => ({
      enabled: true,
      configured: true,
      discovered: true,
      signatureValid: true,
      ready: true,
      protocolReady: true,
      source: 'desktop-install',
      version: '0.150.0-alpha.8',
      failureStage: null,
      reasonCode: 'CODEX_APP_SERVER_READY',
      executablePath: 'C:\\private\\codex.exe',
      stderr: 'private child output',
      protocolState: { initialized: true },
    }),
    readLspStatus: () => ({
      enabled: true,
      providerCount: 2,
      reason: 'query_failed',
      code: 'LSP_PROCESS_FAILED',
      command: 'C:\\private\\typescript-language-server.exe',
      args: ['--stdio'],
      env: { PRIVATE_TOKEN: 'secret' },
      cwd: 'C:\\private-workspace',
      sourcePath: 'C:\\private-workspace\\source.ts',
    }),
  })

  assert.deepEqual(diagnostics, {
    turnHost: {
      ready: true,
      persistenceConfigured: true,
      compactionArchiveConfigured: true,
    },
    codexHost: {
      enabled: true,
      configured: true,
      discovered: true,
      signatureValid: true,
      version: '0.150.0-alpha.8',
      ready: true,
      failureStage: null,
      reasonCode: 'CODEX_APP_SERVER_READY',
    },
    lspHost: {
      enabled: true,
      providerCount: 2,
      reason: 'query_failed',
      code: 'LSP_PROCESS_FAILED',
    },
  })
  assert.equal(Object.isFrozen(diagnostics), true)
  assert.equal(Object.isFrozen(diagnostics.turnHost), true)
  assert.equal(Object.isFrozen(diagnostics.codexHost), true)
  assert.equal(Object.isFrozen(diagnostics.lspHost), true)
  assert.deepEqual(Object.keys(diagnostics.codexHost), [
    'enabled',
    'configured',
    'discovered',
    'signatureValid',
    'version',
    'ready',
    'failureStage',
    'reasonCode',
  ])
  const serialized = JSON.stringify(diagnostics)
  assert.equal(serialized.includes('executablePath'), false)
  assert.equal(serialized.includes('stderr'), false)
  assert.equal(serialized.includes('protocol'), false)
  assert.equal(serialized.includes('source'), false)
  assert.equal(serialized.includes('command'), false)
  assert.equal(serialized.includes('args'), false)
  assert.equal(serialized.includes('PRIVATE_TOKEN'), false)
  assert.equal(serialized.includes('cwd'), false)
})

test('runtime host diagnostics fail closed when either required host port is missing', () => {
  const diagnostics = getRuntimeHostDiagnostics({
    readPersistenceStatus: () => ({ configured: true }),
    readCompactionStatus: () => ({ configured: false }),
    readCodexStatus: () => ({
      enabled: false,
      reasonCode: 'CODEX_APP_SERVER_DISABLED',
    }),
    readLspStatus: () => ({
      enabled: false,
      providerCount: 0,
      reason: 'not_configured',
      code: null,
    }),
  })

  assert.deepEqual(diagnostics, {
    turnHost: {
      ready: false,
      persistenceConfigured: true,
      compactionArchiveConfigured: false,
    },
    codexHost: {
      enabled: false,
      configured: false,
      discovered: false,
      signatureValid: false,
      version: null,
      ready: false,
      failureStage: null,
      reasonCode: 'CODEX_APP_SERVER_DISABLED',
    },
    lspHost: {
      enabled: false,
      providerCount: 0,
      reason: 'not_configured',
      code: null,
    },
  })
})

test('runtime host diagnostics sanitize invalid Codex diagnostic values', () => {
  const diagnostics = getRuntimeHostDiagnostics({
    readPersistenceStatus: () => ({ configured: false }),
    readCompactionStatus: () => ({ configured: false }),
    readCodexStatus: () => ({
      enabled: 'yes',
      configured: 1,
      discovered: {},
      signatureValid: 'true',
      version: 'private path C:\\codex.exe',
      ready: false,
      failureStage: 'private-internal-stage',
      reasonCode: 'PRIVATE_FAILURE',
    }),
    readLspStatus: () => ({
      enabled: 'yes',
      providerCount: 999,
      reason: 'C:\\private\\source.ts',
      code: 'PRIVATE_FAILURE_C:\\private\\command.exe',
      command: 'C:\\private\\command.exe',
    }),
  })

  assert.deepEqual(diagnostics.codexHost, {
    enabled: false,
    configured: false,
    discovered: false,
    signatureValid: false,
    version: null,
    ready: false,
    failureStage: null,
    reasonCode: 'CODEX_APP_SERVER_PROTOCOL_INVALID',
  })
  assert.deepEqual(diagnostics.lspHost, {
    enabled: false,
    providerCount: 0,
    reason: 'not_started',
    code: null,
  })
})

test('runtime host diagnostics distinguish public LSP lifecycle and query states', () => {
  const fixtures = [
    {
      status: { enabled: false, providerCount: 0, reason: 'not_configured', code: null },
      expected: { enabled: false, providerCount: 0, reason: 'not_configured', code: null },
    },
    {
      status: { enabled: false, providerCount: 0, reason: 'invalid_config', code: 'LSP_CONFIG_INVALID' },
      expected: { enabled: false, providerCount: 0, reason: 'invalid_config', code: 'LSP_CONFIG_INVALID' },
    },
    {
      status: {
        enabled: false,
        providerCount: 0,
        reason: 'provider_initialization_failed',
        code: 'LSP_PROVIDER_INIT_FAILED',
      },
      expected: {
        enabled: false,
        providerCount: 0,
        reason: 'provider_initialization_failed',
        code: 'LSP_PROVIDER_INIT_FAILED',
      },
    },
    {
      status: { enabled: true, providerCount: 1, reason: 'query_failed', code: 'LSP_TIMEOUT' },
      expected: { enabled: true, providerCount: 1, reason: 'query_failed', code: 'LSP_TIMEOUT' },
    },
    {
      status: {
        enabled: true,
        providerCount: 1,
        reason: 'query_failed',
        code: 'LSP_PROCESS_BACKOFF',
      },
      expected: {
        enabled: true,
        providerCount: 1,
        reason: 'query_failed',
        code: 'LSP_PROCESS_BACKOFF',
      },
    },
  ]

  for (const { status, expected } of fixtures) {
    const diagnostics = getRuntimeHostDiagnostics({
      readPersistenceStatus: () => ({ configured: false }),
      readCompactionStatus: () => ({ configured: false }),
      readCodexStatus: () => ({
        enabled: false,
        reasonCode: 'CODEX_APP_SERVER_DISABLED',
      }),
      readLspStatus: () => status,
    })
    assert.deepEqual(diagnostics.lspHost, expected)
  }
})

test('runtime host diagnostics reject invalid status readers without touching the host', () => {
  assert.throws(
    () => getRuntimeHostDiagnostics({ readPersistenceStatus: null }),
    /readers must be functions/,
  )
  assert.throws(
    () => getRuntimeHostDiagnostics({ readCodexStatus: null }),
    /readers must be functions/,
  )
  assert.throws(
    () => getRuntimeHostDiagnostics({ readLspStatus: null }),
    /readers must be functions/,
  )
})
