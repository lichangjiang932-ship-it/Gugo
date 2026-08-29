export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000
export const DEFAULT_SIGNATURE_TIMEOUT_MS = 5_000
export const DEFAULT_VERSION_TIMEOUT_MS = 3_000
export const DEFAULT_EXIT_TIMEOUT_MS = 5_000
export const DEFAULT_TERMINATE_TIMEOUT_MS = 20_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
export const MAX_HANDSHAKE_TIMEOUT_MS = 30_000
export const MAX_STAGE_TIMEOUT_MS = 30_000
export const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024

const FAILURE_STAGES = new Set([
  'discovery',
  'signature',
  'version',
  'spawn',
  'handshake',
  'runtime',
  'shutdown',
])

export const CODEX_APP_SERVER_REASON = Object.freeze({
  NOT_STARTED: 'CODEX_APP_SERVER_NOT_STARTED',
  DISABLED: 'CODEX_APP_SERVER_DISABLED',
  STARTING: 'CODEX_APP_SERVER_STARTING',
  READY: 'CODEX_APP_SERVER_READY',
  CLI_NOT_FOUND: 'CODEX_CLI_NOT_FOUND',
  CLI_PATH_INVALID: 'CODEX_CLI_PATH_INVALID',
  CLI_SIGNATURE_INVALID: 'CODEX_CLI_SIGNATURE_INVALID',
  CLI_VERSION_INVALID: 'CODEX_CLI_VERSION_INVALID',
  SPAWN_FAILED: 'CODEX_APP_SERVER_SPAWN_FAILED',
  HANDSHAKE_TIMEOUT: 'CODEX_APP_SERVER_HANDSHAKE_TIMEOUT',
  PROTOCOL_INVALID: 'CODEX_APP_SERVER_PROTOCOL_INVALID',
  INITIALIZE_REJECTED: 'CODEX_APP_SERVER_INITIALIZE_REJECTED',
  REQUEST_TIMEOUT: 'CODEX_APP_SERVER_REQUEST_TIMEOUT',
  REQUEST_REJECTED: 'CODEX_APP_SERVER_REQUEST_REJECTED',
  PROCESS_EXITED: 'CODEX_APP_SERVER_PROCESS_EXITED',
  START_ABORTED: 'CODEX_APP_SERVER_START_ABORTED',
  TERMINATION_FAILED: 'CODEX_APP_SERVER_TERMINATION_FAILED',
  STOPPED: 'CODEX_APP_SERVER_STOPPED',
})

export function publicCodexAppServerSnapshot({
  enabled = true,
  configured = false,
  discovered = false,
  signatureValid = false,
  version = null,
  ready = false,
  failureStage = null,
  reasonCode = CODEX_APP_SERVER_REASON.NOT_STARTED,
} = {}) {
  return Object.freeze({
    enabled: enabled === true,
    configured: configured === true,
    discovered: discovered === true,
    signatureValid: signatureValid === true,
    version: typeof version === 'string' && version ? version : null,
    ready: ready === true,
    failureStage: FAILURE_STAGES.has(failureStage) ? failureStage : null,
    reasonCode: typeof reasonCode === 'string' && reasonCode
      ? reasonCode
      : CODEX_APP_SERVER_REASON.NOT_STARTED,
  })
}

export function codexEnvValue(env, name, platform = process.platform) {
  if (!env || typeof env !== 'object') return ''
  if (platform !== 'win32') return String(env[name] || '')
  const target = name.toLowerCase()
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === target)
  return String(entry?.[1] || '')
}

export function normalizeCodexStageTimeout(value, fallback, maximum = MAX_STAGE_TIMEOUT_MS) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.max(1, Math.min(maximum, parsed))
}

export function createCodexRuntimeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function knownCodexReason(value, fallback) {
  return Object.values(CODEX_APP_SERVER_REASON).includes(value) ? value : fallback
}

export function fallbackCodexReasonForStage(stage) {
  if (stage === 'signature') return CODEX_APP_SERVER_REASON.CLI_SIGNATURE_INVALID
  if (stage === 'version') return CODEX_APP_SERVER_REASON.CLI_VERSION_INVALID
  if (stage === 'spawn') return CODEX_APP_SERVER_REASON.SPAWN_FAILED
  if (stage === 'handshake') return CODEX_APP_SERVER_REASON.PROTOCOL_INVALID
  return CODEX_APP_SERVER_REASON.CLI_NOT_FOUND
}
