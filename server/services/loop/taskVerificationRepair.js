import { redactSensitiveText } from '../../utils/toolCallHarness.js'

const TASK_VERIFICATION_REPAIR_MARKER = '[TASK VERIFICATION REPAIR REQUIRED]'
const MAX_TASK_VERIFICATION_FAILURES = 3
const MAX_PENDING_TASK_VERIFICATIONS = 8

const TASK_CHECK_KINDS = new Set(['test', 'lint', 'build', 'check', 'typecheck'])
const NON_VERDICT_CODES = new Set([
  'approval_denied',
  'tool_budget_exceeded',
  'tool_execution_skipped',
  'tool_execution_superseded_by_steering',
  'tool_arguments_invalid',
  'tool_arguments_validation_failed',
  'tool_call_parse_error',
  'side_effect_outcome_unknown',
  'side_effect_ledger_conflict',
])

function normalizeCheckKind(value) {
  const kind = String(value || '').trim().toLowerCase()
  return TASK_CHECK_KINDS.has(kind) ? kind : ''
}

function commandCheckKind(segment) {
  const value = String(segment || '').trim()
  const packageScript = value.match(
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(test|lint|build|check|typecheck)(?:\s+[^\r\n]*)?$/iu,
  )
  if (packageScript) return normalizeCheckKind(packageScript[1])
  if (/^(?:pytest|vitest|jest)(?:\s+[^\r\n]*)?$/iu.test(value)
    || /^cargo\s+test(?:\s+[^\r\n]*)?$/iu.test(value)
    || /^go\s+test(?:\s+[^\r\n]*)?$/iu.test(value)
    || /^dotnet\s+test(?:\s+[^\r\n]*)?$/iu.test(value)) return 'test'
  if (/^eslint(?:\s+[^\r\n]*)?$/iu.test(value)) return 'lint'
  if (/^tsc(?:\s+[^\r\n]*)?$/iu.test(value)
    || /^cargo\s+check(?:\s+[^\r\n]*)?$/iu.test(value)) return 'typecheck'
  return ''
}

function commandCheckKinds(command) {
  return [...new Set(commandCheckDescriptors(command).map(({ kind }) => kind))]
}

function commandCheckDescriptors(command) {
  const value = String(command || '').trim()
  if (!value || /[|;\r\n]/u.test(value)) return []
  const segments = value.split(/\s*&&\s*/u).map((segment) => segment.trim()).filter(Boolean)
  if (segments.length === 0) return []
  const descriptors = new Map()
  for (const segment of segments) {
    const kind = commandCheckKind(segment)
    if (!kind) return []
    const packageScript = segment.match(
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(test|lint|build|check|typecheck)\s*$/iu,
    )
    const commandScope = packageScript
      ? `package-script:${kind}`
      : normalizeCommand(segment)
    descriptors.set(`${kind}\u0000${commandScope}`, { kind, commandScope })
  }
  return [...descriptors.values()]
}

export function taskVerificationKinds(call, result = null) {
  const name = String(call?.name || '').trim()
  if (name === 'run_project_check') {
    const kind = normalizeCheckKind(result?.check || call?.args?.check)
    return kind ? [kind] : []
  }
  if (name === 'run_test') {
    const command = String(call?.args?.command || result?.command || '').trim()
    const kinds = commandCheckKinds(command)
    return kinds.length > 0 ? kinds : ['test']
  }
  return commandCheckKinds(call?.args?.command)
}

function normalizeScopePath(value) {
  const path = String(value || '.').trim().replace(/\\/gu, '/').replace(/\/+$/u, '') || '.'
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function normalizeCommand(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ')
}

function normalizeBatchId(value) {
  return String(value || '').trim().slice(0, 2_000)
}

function taskVerificationScopes(call, result) {
  const name = String(call?.name || '').trim()
  if (!name) return []
  const cwd = normalizeScopePath(result?.cwd || call?.args?.cwd)
  let descriptors = []
  if (name === 'run_project_check') {
    const kind = normalizeCheckKind(result?.check || call?.args?.check)
    if (kind) descriptors = [{ kind, commandScope: `package-script:${kind}` }]
  } else if (name === 'run_test') {
    const command = normalizeCommand(call?.args?.command || result?.command)
    descriptors = commandCheckDescriptors(command)
    if (descriptors.length === 0) {
      const fallbackScope = command
        || normalizeCommand(call?.args?.framework || result?.framework || 'auto')
      descriptors = [{ kind: 'test', commandScope: `run-test:${fallbackScope}` }]
    }
  } else {
    descriptors = commandCheckDescriptors(call?.args?.command)
  }
  return descriptors.map(({ kind, commandScope }) => ({
    kind,
    scope: `${kind}\u0000${cwd}\u0000${commandScope}`,
    scopeLabel: `${kind}@${cwd}`,
  }))
}

function isDeterministicFailure(result) {
  if (result?.ok !== false
    || result?.timedOut === true
    || result?.cancelled === true
    || result?.denied === true
    || result?.policyDenied === true
    || result?.systemFailure === true
    || result?.requiresUserVerification === true
    || result?.retryable === true) return false
  const code = String(result?.code || '').trim().toLowerCase()
  if (NON_VERDICT_CODES.has(code)
    || /(?:timeout|cancel|denied|permission|authori[sz]|unknown|conflict|invalid|parse)/iu.test(code)) {
    return false
  }
  const exitCode = Number(result?.exitCode)
  return result?.passed === false || (Number.isInteger(exitCode) && exitCode !== 0)
}

function isDeterministicSuccess(result) {
  if (result?.ok !== true || result?.passed === false || result?.timedOut === true) return false
  if (result?.exitCode == null) return true
  return Number(result.exitCode) === 0
}

function compactDiagnosticText(value, fallback = 'The verification command returned a failing result.') {
  const text = String(value || fallback).trim()
  const compact = [...text].filter((character) => {
    const code = character.codePointAt(0)
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
  }).join('')
  const bounded = compact.length > 1_200 ? compact.slice(-1_200) : compact
  return redactSensitiveText(bounded)
}

function compactFailureMessage(result) {
  const candidates = [result?.stderr, result?.stdout, result?.error]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  return compactDiagnosticText(candidates[0])
}

function normalizeFailure(value, fallbackKind = '') {
  const kind = normalizeCheckKind(value?.kind || fallbackKind)
  const scope = String(value?.scope || '').slice(0, 2_000)
  if (!kind || !scope) return null
  return {
    kind,
    scope,
    scopeLabel: String(value?.scopeLabel || `${value?.tool || 'project check'}:${kind}`)
      .slice(0, 300),
    failures: Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(1, Math.floor(Number(value?.failures) || 1)),
    ),
    tool: String(value?.tool || '').slice(0, 120),
    code: String(value?.code || 'task_verification_failed').slice(0, 160),
    message: compactDiagnosticText(value?.message),
    lastFailureBatchId: normalizeBatchId(value?.lastFailureBatchId),
  }
}

export function restoreTaskVerificationRepair(value = {}) {
  const pending = new Map()
  for (const entry of (Array.isArray(value?.pending) ? value.pending : [])
    .slice(-MAX_PENDING_TASK_VERIFICATIONS)) {
    const normalized = normalizeFailure(entry)
    if (normalized) pending.set(normalized.scope, normalized)
  }
  return {
    pending,
    consecutiveFailures: Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(0, Math.floor(Number(value?.consecutiveFailures) || 0)),
    ),
    lastFailureBatchId: normalizeBatchId(value?.lastFailureBatchId),
  }
}

export function serializeTaskVerificationRepair(value = {}) {
  return {
    pending: [...(value.pending instanceof Map ? value.pending.values() : [])]
      .slice(-MAX_PENDING_TASK_VERIFICATIONS)
      .map((entry) => ({ ...entry })),
    consecutiveFailures: Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(0, Math.floor(Number(value?.consecutiveFailures) || 0)),
    ),
    lastFailureBatchId: normalizeBatchId(value?.lastFailureBatchId),
  }
}

export function observeTaskVerificationRepair(state, call, result, {
  mutationObserved = false,
  batchId = '',
} = {}) {
  const scopes = taskVerificationScopes(call, result)
  if (!(state?.pending instanceof Map) || scopes.length === 0) {
    return { changed: false, failed: false, cleared: [] }
  }

  if (isDeterministicSuccess(result)) {
    const cleared = scopes.filter(({ scope }) => state.pending.delete(scope))
    if (cleared.length > 0 && state.pending.size === 0) {
      state.consecutiveFailures = 0
      state.lastFailureBatchId = ''
    }
    return { changed: cleared.length > 0, failed: false, cleared }
  }
  if (!isDeterministicFailure(result) || !mutationObserved) {
    return { changed: false, failed: false, cleared: [] }
  }

  const tool = String(call?.name || '').trim()
  const code = String(result?.code || `task_${scopes[0].kind}_failed`)
  const message = compactFailureMessage(result)
  const normalizedBatchId = normalizeBatchId(batchId)
  const alreadyCountedBatch = Boolean(
    normalizedBatchId && state.lastFailureBatchId === normalizedBatchId,
  )
  if (!alreadyCountedBatch) {
    state.consecutiveFailures = Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(0, Number(state.consecutiveFailures) || 0) + 1,
    )
    state.lastFailureBatchId = normalizedBatchId
  }
  for (const { kind, scope, scopeLabel } of scopes) {
    const previous = state.pending.get(scope)
    if (!previous && state.pending.size >= MAX_PENDING_TASK_VERIFICATIONS) continue
    const scopeAlreadyCounted = Boolean(
      normalizedBatchId && previous?.lastFailureBatchId === normalizedBatchId,
    )
    state.pending.set(scope, normalizeFailure({
      kind,
      scope,
      scopeLabel,
      failures: Number(previous?.failures || 0) + (scopeAlreadyCounted ? 0 : 1),
      tool,
      code,
      message,
      lastFailureBatchId: normalizedBatchId,
    }, kind))
  }
  return { changed: true, failed: true, cleared: [], kinds: scopes.map(({ kind }) => kind) }
}

export function hasPendingTaskVerificationRepair(state) {
  return state?.pending instanceof Map && state.pending.size > 0
}

export function taskVerificationRepairExhausted(state) {
  return state?.pending instanceof Map
    && (Number(state.consecutiveFailures || 0) >= MAX_TASK_VERIFICATION_FAILURES
      || [...state.pending.values()].some((entry) => (
        Number(entry?.failures || 0) >= MAX_TASK_VERIFICATION_FAILURES
      )))
}

export function buildTaskVerificationRepairPrompt(state) {
  const pending = state?.pending instanceof Map ? [...state.pending.values()] : []
  if (pending.length === 0) return ''
  return [
    TASK_VERIFICATION_REPAIR_MARKER,
    `Post-mutation project verification is still failing: ${pending.map((entry) => entry.kind).join(', ')}.`,
    'Treat the exact tool output as actionable feedback. Inspect the failing assertion or diagnostic, correct the implementation with the available tools, then rerun every pending check.',
    'A file read, directory listing, or diff cannot clear a failed test/lint/build result. Do not claim completion while any pending check remains.',
    ...pending.map((entry) => (
      `${entry.kind} remains pending after verification failure ${state.consecutiveFailures}/${MAX_TASK_VERIFICATION_FAILURES}. Read the preceding tool-role result for diagnostics and rerun the same check scope after correcting the implementation.`
    )),
  ].join('\n')
}

export function taskVerificationRepairBlockerText(state) {
  const pending = state?.pending instanceof Map ? [...state.pending.values()] : []
  if (pending.length === 0) return ''
  const failedChecks = pending.map((entry) => entry.kind).join(', ')
  const last = pending.sort((left, right) => right.failures - left.failures)[0]
  return [
    `Task verification did not pass after ${Math.max(last.failures, Number(state.consecutiveFailures) || 0)} verification failures (${failedChecks}).`,
    `Last failure: ${last.message}`,
    'The applied file changes were preserved, but the task was not marked complete.',
  ].join(' ')
}

export {
  MAX_TASK_VERIFICATION_FAILURES,
  TASK_VERIFICATION_REPAIR_MARKER,
}
