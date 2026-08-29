import { getCompactionArchivePortStatus } from '../core/compactionArchivePort.js'
import { getTurnPersistenceAdapterStatus } from '../core/turnPersistenceAdapter.js'
import {
  CODEX_APP_SERVER_REASON,
  getCodexAppServerStatus,
} from './codexAppServerRuntime.js'
import {
  getLspRuntimeStatus,
  LSP_RUNTIME_CODE,
  LSP_RUNTIME_REASON,
} from './lspRuntime.js'

const CODEX_REASON_CODES = new Set(Object.values(CODEX_APP_SERVER_REASON))
const CODEX_FAILURE_STAGES = new Set([
  'discovery',
  'signature',
  'version',
  'spawn',
  'handshake',
  'runtime',
  'shutdown',
])
const LSP_REASONS = new Set(Object.values(LSP_RUNTIME_REASON))
const LSP_CONFIG_FAILURE_CODES = new Set([
  LSP_RUNTIME_CODE.CONFIG_INVALID,
  LSP_RUNTIME_CODE.COMMAND_NOT_ALLOWED,
])
const LSP_INITIALIZATION_FAILURE_CODES = new Set([
  LSP_RUNTIME_CODE.PROVIDER_FACTORY_INVALID,
  LSP_RUNTIME_CODE.PROVIDER_INIT_FAILED,
  LSP_RUNTIME_CODE.CONFLICT,
  LSP_RUNTIME_CODE.INVALID_PROVIDER,
])
const LSP_QUERY_FAILURE_CODES = new Set([
  LSP_RUNTIME_CODE.PROCESS_FAILED,
  LSP_RUNTIME_CODE.PROCESS_EXITED,
  LSP_RUNTIME_CODE.TRANSPORT_FAILED,
  LSP_RUNTIME_CODE.TIMEOUT,
  LSP_RUNTIME_CODE.SERVER_ERROR,
  LSP_RUNTIME_CODE.RESPONSE_TOO_LARGE,
  LSP_RUNTIME_CODE.MALFORMED_RESPONSE,
  LSP_RUNTIME_CODE.PROVIDER_FAILED,
])

function publicCodexHostStatus(status) {
  const reasonCode = CODEX_REASON_CODES.has(status?.reasonCode)
    ? status.reasonCode
    : CODEX_APP_SERVER_REASON.PROTOCOL_INVALID
  const ready = status?.ready === true
  return Object.freeze({
    enabled: status?.enabled === true,
    configured: status?.configured === true,
    discovered: status?.discovered === true,
    signatureValid: status?.signatureValid === true,
    version: typeof status?.version === 'string'
      && /^[0-9][0-9A-Za-z.+-]{0,63}$/u.test(status.version)
      ? status.version
      : null,
    ready,
    failureStage: !ready && CODEX_FAILURE_STAGES.has(status?.failureStage)
      ? status.failureStage
      : null,
    reasonCode,
  })
}

function publicLspHostStatus(status) {
  const reason = LSP_REASONS.has(status?.reason)
    ? status.reason
    : LSP_RUNTIME_REASON.NOT_STARTED
  const validProviderCount = Number.isSafeInteger(status?.providerCount)
    && status.providerCount >= 1
    && status.providerCount <= 8

  if (reason === LSP_RUNTIME_REASON.CONFIGURED) {
    return status?.enabled === true && validProviderCount
      ? Object.freeze({ enabled: true, providerCount: status.providerCount, reason, code: null })
      : Object.freeze({ enabled: false, providerCount: 0, reason: LSP_RUNTIME_REASON.NOT_STARTED, code: null })
  }
  if (reason === LSP_RUNTIME_REASON.QUERY_FAILED) {
    return status?.enabled === true && validProviderCount
      ? Object.freeze({
          enabled: true,
          providerCount: status.providerCount,
          reason,
          code: LSP_QUERY_FAILURE_CODES.has(status?.code) ? status.code : null,
        })
      : Object.freeze({ enabled: false, providerCount: 0, reason: LSP_RUNTIME_REASON.NOT_STARTED, code: null })
  }

  const failureCodes = reason === LSP_RUNTIME_REASON.INVALID_CONFIG
    ? LSP_CONFIG_FAILURE_CODES
    : reason === LSP_RUNTIME_REASON.PROVIDER_INITIALIZATION_FAILED
      ? LSP_INITIALIZATION_FAILURE_CODES
      : null
  return Object.freeze({
    enabled: false,
    providerCount: 0,
    reason,
    code: failureCodes?.has(status?.code) ? status.code : null,
  })
}

/**
 * Return a public, read-only host health snapshot without acquiring a lease or
 * initializing TurnEngine. Adapter identities, sources, paths, and audit data
 * intentionally stay on the server side.
 */
export function getRuntimeHostDiagnostics({
  readPersistenceStatus = getTurnPersistenceAdapterStatus,
  readCompactionStatus = getCompactionArchivePortStatus,
  readCodexStatus = getCodexAppServerStatus,
  readLspStatus = getLspRuntimeStatus,
} = {}) {
  if (typeof readPersistenceStatus !== 'function'
    || typeof readCompactionStatus !== 'function'
    || typeof readCodexStatus !== 'function'
    || typeof readLspStatus !== 'function') {
    throw new TypeError('runtime host diagnostics readers must be functions')
  }

  const persistenceConfigured = readPersistenceStatus()?.configured === true
  const compactionArchiveConfigured = readCompactionStatus()?.configured === true

  return Object.freeze({
    turnHost: Object.freeze({
      ready: persistenceConfigured && compactionArchiveConfigured,
      persistenceConfigured,
      compactionArchiveConfigured,
    }),
    codexHost: publicCodexHostStatus(readCodexStatus()),
    lspHost: publicLspHostStatus(readLspStatus()),
  })
}
