/**
 * Terminal diagnostics, progress lines and stable error projection for the CLI.
 * Split from runOutput.js so both modules stay focused and under the size gate.
 */
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'
import { CliOutputError } from './runOutputStream.js'

const RUN_OUTPUT_FORMATS = new Set(['jsonl', 'text'])
const TEXT_TERMINAL_DIAGNOSTICS = Object.freeze({
  'turn.failed': Object.freeze({ label: 'Failed', fallbackCode: 'TURN_FAILED' }),
  'turn.blocked': Object.freeze({ label: 'Blocked', fallbackCode: 'TURN_RECOVERY_BLOCKED' }),
  'turn.cancelled': Object.freeze({ label: 'Cancelled', fallbackCode: 'TURN_CANCELLED' }),
  'turn.paused': Object.freeze({ label: 'Paused', fallbackCode: 'TURN_PAUSED' }),
  'turn.waiting': Object.freeze({ label: 'Waiting', fallbackCode: 'TURN_WAITING' }),
  'turn.awaiting_approval': Object.freeze({ label: 'Waiting', fallbackCode: 'TURN_AWAITING_APPROVAL' }),
  'turn.interrupted': Object.freeze({ label: 'Interrupted', fallbackCode: 'TURN_INTERRUPTED' }),
  'job.failed': Object.freeze({ label: 'Job failed', fallbackCode: 'JOB_FAILED' }),
  'job.blocked': Object.freeze({ label: 'Job blocked', fallbackCode: 'JOB_BLOCKED' }),
  'job.cancelled': Object.freeze({ label: 'Job cancelled', fallbackCode: 'JOB_CANCELLED' }),
  'job.paused': Object.freeze({ label: 'Job paused', fallbackCode: 'JOB_PAUSED' }),
  'job.waiting': Object.freeze({ label: 'Job waiting', fallbackCode: 'JOB_WAITING' }),
  'job.awaiting_approval': Object.freeze({ label: 'Job waiting', fallbackCode: 'JOB_AWAITING_APPROVAL' }),
  'job.interrupted': Object.freeze({ label: 'Job interrupted', fallbackCode: 'JOB_INTERRUPTED' }),
})

const SUCCESS_RESULT_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success', 'ok'])
const MODEL_FAILURE_HINTS = Object.freeze({
  MODEL_NOT_LOADED: 'No model is loaded. Load the selected model in LM Studio (Developer page or lms load), then retry the turn.',
})

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export function completionIsExplicitlyIncomplete(value, seen = new Set()) {
  const source = objectValue(value)
  if (!source || seen.has(source)) return false
  seen.add(source)
  if (source.complete === false || source.completed === false
    || source.incomplete === true || source.paused === true || source.interrupted === true) return true
  const status = String(source.status || '').trim().toLowerCase()
  if (['blocked', 'cancelled', 'failed', 'incomplete', 'interrupted', 'paused'].includes(status)) return true
  if (String(source.incompleteReason || '').trim()) return true
  if (Array.isArray(source.missingRequirements) && source.missingRequirements.length > 0) return true
  if (Array.isArray(source.retainedLocalFiles) && source.retainedLocalFiles.length > 0) return true
  const verification = objectValue(source.taskVerification)
  if (verification && (
    verification.ok === false
    || verification.passed === false
    || (Array.isArray(verification.checks) && verification.checks.length > 0)
  )) return true
  return [source.output, source.finalOutput, source.delivery, source.outcome]
    .some((candidate) => completionIsExplicitlyIncomplete(candidate, seen))
}

export function completedEventSucceeded(event) {
  return isSuccessfulTurnCompletedEvent(event)
}

export function terminalDescriptor(event) {
  if (event?.type === 'turn.completed' && !completedEventSucceeded(event)) {
    return Object.freeze({ label: 'Incomplete', fallbackCode: 'TURN_INCOMPLETE' })
  }
  if (event?.type === 'job.completed' && completionIsExplicitlyIncomplete(event?.payload)) {
    return Object.freeze({ label: 'Job incomplete', fallbackCode: 'JOB_INCOMPLETE' })
  }
  const direct = TEXT_TERMINAL_DIAGNOSTICS[event?.type]
  if (direct) return direct
  if (!event?.jobId) return null
  const legacyJobTypes = {
    failed: TEXT_TERMINAL_DIAGNOSTICS['job.failed'],
    blocked: TEXT_TERMINAL_DIAGNOSTICS['job.blocked'],
    cancelled: TEXT_TERMINAL_DIAGNOSTICS['job.cancelled'],
    paused: TEXT_TERMINAL_DIAGNOSTICS['job.paused'],
    waiting: TEXT_TERMINAL_DIAGNOSTICS['job.waiting'],
    awaiting_user: TEXT_TERMINAL_DIAGNOSTICS['job.waiting'],
    sleeping: TEXT_TERMINAL_DIAGNOSTICS['job.waiting'],
    awaiting_approval: TEXT_TERMINAL_DIAGNOSTICS['job.awaiting_approval'],
    interrupted: TEXT_TERMINAL_DIAGNOSTICS['job.interrupted'],
  }
  if (event.type === 'completed' && completionIsExplicitlyIncomplete(event.payload)) {
    return Object.freeze({ label: 'Job incomplete', fallbackCode: 'JOB_INCOMPLETE' })
  }
  return legacyJobTypes[event.type] || null
}

function stableCode(value, fallback) {
  const normalized = String(value || '').trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]{0,127}$/u.test(normalized) ? normalized : fallback
}

function actionText(value) {
  if (typeof value === 'string') return value.trim()
  const action = objectValue(value)
  if (!action) return ''
  const kind = String(action.kind || action.action || '').trim()
  const target = String(action.path || action.target || action.url || '').trim()
  return [kind, target].filter(Boolean).join(' ')
}

/** Waiting, approval, interruption and pause are resumable observations, not final decisions. */
export function isFinalRunTerminal(event) {
  return ['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event?.type)
}

export function runTerminalsConflict(left, right) {
  if (!isFinalRunTerminal(left) || !isFinalRunTerminal(right)) return false
  if (left.type !== right.type || completedEventSucceeded(left) !== completedEventSucceeded(right)) return true
  for (const key of ['id', 'sessionId', 'turnId', 'sequence']) {
    if (left[key] != null && right[key] != null && left[key] !== right[key]) return true
  }
  return left.type === 'turn.completed' && typeof left.payload?.text === 'string'
    && typeof right.payload?.text === 'string' && left.payload.text !== right.payload.text
}

export function runResultIdentityConflict(result, event) {
  if (!result || !completedEventSucceeded(event)) return false
  return ['sessionId', 'turnId'].some((key) => result[key] != null && result[key] !== ''
    && event[key] != null && event[key] !== '' && result[key] !== event[key])
}

/** Constant-size evidence for one attempt; replayed nonfinal states cannot erase a final. */
export function createRunTerminalObserver() {
  let latest = null
  let firstFinal = null
  let conflict = false
  return {
    observe(event) {
      if (event?.type === 'turn.attempt' && event.payload?.resetStreaming === true) {
        latest = null; firstFinal = null; conflict = false
        return true
      }
      if (event?.type?.startsWith('turn.') && (event.type === 'turn.completed' || terminalDescriptor(event))) {
        if (isFinalRunTerminal(event)) {
          conflict ||= runTerminalsConflict(firstFinal, event)
          firstFinal ||= event
        }
        latest = event
      }
      return false
    },
    get terminal() { return firstFinal || latest },
    get conflict() { return conflict },
  }
}

export function runOutcomeConflictError(observedTerminal) {
  const rawCode = observedTerminal?.payload?.code || observedTerminal?.payload?.error?.code
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(rawCode) ? ` [${rawCode}]` : ''
  return new CliOutputError('CLI_RUN_OUTCOME_CONFLICT',
    `runtime result and final terminal evidence disagree${code}; no successful output was confirmed`, 1)
}

export function runResultSucceeded(result, observedTurnTerminal = null) {
  if (completionIsExplicitlyIncomplete(result)) return false
  const source = objectValue(result)
  if (Number.isInteger(source?.exitCode) && source.exitCode !== 0) return false
  const status = String(source?.status || '').trim().toLowerCase()
  if (status && !SUCCESS_RESULT_STATUSES.has(status)) return false
  const lastEvent = source?.lastEvent
  if (runTerminalsConflict(lastEvent, observedTurnTerminal)) return false
  if (runResultIdentityConflict(source, lastEvent) || runResultIdentityConflict(source, observedTurnTerminal)) return false
  if (lastEvent?.type?.startsWith?.('turn.')) return completedEventSucceeded(lastEvent)
  if (observedTurnTerminal) return completedEventSucceeded(observedTurnTerminal)
  if (status) return SUCCESS_RESULT_STATUSES.has(status)
  return Number.isInteger(result?.exitCode) && result.exitCode === 0
}

export function normalizeRunOutputFormat(value = 'jsonl') {
  const format = String(value ?? 'jsonl').trim().toLowerCase() || 'jsonl'
  if (!RUN_OUTPUT_FORMATS.has(format)) {
    throw new CliOutputError(
      'CLI_OUTPUT_INVALID',
      'output format must be one of jsonl, text',
    )
  }
  return format
}

export function line(value) {
  const text = String(value ?? '')
  if (!text.trim()) return null
  return /\r?\n$/u.test(text) ? text : `${text}\n`
}

function uniqueTextValues(...sources) {
  return [...new Set(sources
    .flatMap((source) => Array.isArray(source) ? source : (typeof source === 'string' ? [source] : []))
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

function localFileLabels(...sources) {
  return [...new Set(sources
    .flatMap((source) => Array.isArray(source) ? source : [])
    .map((file) => typeof file === 'string'
      ? file.trim()
      : String(file?.path || file?.filename || file?.id || '').trim())
    .filter(Boolean))]
}

const COMPLETED_VERIFICATION_CHECK_STATUSES = new Set([
  'pass',
  'passed',
  'success',
  'succeeded',
  'complete',
  'completed',
  'ok',
])

function taskVerificationCheckIssue(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return ''
  const status = String(check.status || 'failed').trim().toLowerCase()
  if (COMPLETED_VERIFICATION_CHECK_STATUSES.has(status)) return ''
  const kind = String(check.kind || 'check').trim()
  const code = String(check.code || '').trim()
  const command = String(check.commandScope || '').trim()
  const cwd = String(check.cwd || '').trim()
  const diagnostic = String(check.diagnostic || '').trim()
  const targets = uniqueTextValues(check.mutationTargets)
  const identity = `${status} ${kind}${code ? ` [${code}]` : ''}`
  const scope = [command ? `command=${command}` : '', cwd ? `cwd=${cwd}` : '']
    .filter(Boolean)
    .join(', ')
  return `${identity}${scope ? ` (${scope})` : ''}`
    + `${diagnostic ? `: ${diagnostic}` : ''}`
    + `${targets.length > 0 ? `; targets=${targets.join(', ')}` : ''}`
}

function taskVerificationIssues(...sources) {
  const issues = []
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    issues.push(...uniqueTextValues(source.issues, source.missingRequirements))
    const reason = String(source.reason || source.summary || '').trim()
    if (reason) issues.push(reason)
    if (Array.isArray(source.checks)) {
      issues.push(...source.checks.map(taskVerificationCheckIssue).filter(Boolean))
    }
  }
  return [...new Set(issues)]
}

/** Deduplicate bounded completion-policy entries across error sources. */
function uniqueCompletionPolicyEntries(...sources) {
  const byId = new Map()
  for (const source of sources) {
    const entries = source && typeof source === 'object' && Array.isArray(source.completionPolicies)
      ? source.completionPolicies
      : []
    for (const entry of entries.slice(0, 16)) {
      if (!entry || typeof entry !== 'object') continue
      const id = String(entry.id || '').trim()
      if (!id || byId.has(id)) continue
      const attempts = Number(entry.attempts)
      const limit = entry.limit == null ? null : Number(entry.limit)
      byId.set(id, {
        id,
        attempts: Number.isFinite(attempts) ? attempts : 0,
        limit: entry.limit == null ? null : (Number.isFinite(limit) ? limit : null),
        exhausted: entry.exhausted === true,
      })
    }
  }
  return [...byId.values()]
}

/** Render the bounded completion-policy diagnostic shared by CLI terminals. */
function completionPolicyIssues(...sources) {
  return uniqueCompletionPolicyEntries(...sources).map((entry) => {
    const count = entry.limit == null ? '' : ` ${entry.attempts}/${entry.limit}`
    return `${entry.id}${count}${entry.exhausted ? ' (exhausted)' : ''}`
  })
}

export function terminalDiagnostic(event) {
  const descriptor = terminalDescriptor(event)
  if (!descriptor) return null
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
  const nested = payload.error && typeof payload.error === 'object' ? payload.error : {}
  // `payload.error` is the canonical failure object. Top-level fields only
  // remain for replay compatibility and may contain an older generic value.
  const code = stableCode(nested.code || payload.code, descriptor.fallbackCode)
  const clarification = payload.clarification
  const clarificationMessage = typeof clarification === 'string'
    ? clarification
    : clarification?.question || clarification?.message
  const message = String(
    nested.message
      || nested.reason
      || payload.message
      || payload.reason
      || clarificationMessage
      || payload.text
      || '',
  ).trim()
  const incompleteReason = String(
    nested.incompleteReason || payload.incompleteReason || '',
  ).trim()
  const missingRequirements = uniqueTextValues(
    nested.missingRequirements,
    payload.missingRequirements,
  )
  const artifactIds = uniqueTextValues(
    nested.artifactIds,
    nested.deliveryArtifactIds,
    payload.artifactIds,
    payload.deliveryArtifactIds,
  )
  const verifiedFiles = localFileLabels(
    nested.verifiedLocalFiles,
    payload.verifiedLocalFiles,
  )
  const retainedFiles = localFileLabels(
    nested.retainedLocalFiles,
    payload.retainedLocalFiles,
  )
  const verificationIssues = taskVerificationIssues(
    nested.taskVerification,
    payload.taskVerification,
  )
  const policyIssues = completionPolicyIssues(nested, payload)
  const retryable = typeof nested.retryable === 'boolean'
    ? nested.retryable
    : payload.retryable === true
  const manualRetryable = typeof nested.manualRetryable === 'boolean'
    ? nested.manualRetryable
    : payload.manualRetryable === true
  const nextAction = actionText(
    nested.nextAction || payload.nextAction || nested.action || payload.recoveryAction,
  )
  const details = [`${descriptor.label} [${code}]`]
  const reason = incompleteReason || message
  details.push(`Reason: ${reason || 'terminal_reason_not_recorded'}`)
  if (incompleteReason && message && message !== incompleteReason) {
    details.push(`Detail: ${message}`)
  }
  if (Object.hasOwn(MODEL_FAILURE_HINTS, code)) details.push(`Hint: ${MODEL_FAILURE_HINTS[code]}`)
  if (missingRequirements.length > 0) {
    details.push(`Missing: ${missingRequirements.join(', ')}`)
  }
  if (artifactIds.length > 0) details.push(`Saved artifacts: ${artifactIds.join(', ')}`)
  if (verifiedFiles.length > 0) details.push(`Verified files: ${verifiedFiles.join(', ')}`)
  if (retainedFiles.length > 0) details.push(`Saved files awaiting verification: ${retainedFiles.join(', ')}`)
  if (verificationIssues.length > 0) details.push(`Verification: ${verificationIssues.join('; ')}`)
  if (policyIssues.length > 0) details.push(`Completion policies: ${policyIssues.join(', ')}`)
  if (nextAction) details.push(`Next: ${nextAction}`)
  else if (retryable) details.push('Next: retry this turn from its durable checkpoint.')
  else if (manualRetryable) details.push('Next: verify the recorded outcome, then retry explicitly.')
  else if (missingRequirements.length > 0) details.push('Next: satisfy the missing requirements and run again.')
  else details.push('Next: inspect the stable code and terminal record before retrying.')
  return line(details.join('\n'))
}

/** Compact, factual token usage line, including measured cache hits. */
function modelUsageSummary(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return ''
  const parts = []
  const prompt = Number(usage.promptTokens)
  const cached = Number(usage.cacheHitTokens)
  const completion = Number(usage.completionTokens)
  if (Number.isFinite(prompt)) parts.push(`prompt ${prompt}`)
  if (Number.isFinite(cached)) parts.push(`cached ${cached}`)
  if (Number.isFinite(completion)) parts.push(`completion ${completion}`)
  return parts.join(', ')
}

/**
 * Concise, factual progress for a human watching stderr. It renders only
 * observable turn facts (no private reasoning, no completion claim the host
 * has not committed) and never touches stdout, so the JSONL/text contract is
 * unchanged. Terminal events return null here because the terminal diagnostic
 * already explains them in full.
 */
export function formatProgressEvent(event) {
  if (terminalDescriptor(event)) return null
  const payload = objectValue(event?.payload) || {}
  const name = String(payload.name || payload.toolName || '').trim()
  switch (event?.type) {
    case 'turn.started': return 'turn started'
    case 'turn.resumed': return 'turn resumed'
    case 'model.phase': {
      const phase = String(payload.phase || '').trim()
      if (phase === 'wire_prepared' && payload.wireDiagnostics) {
        const wire = payload.wireDiagnostics
        const identity = payload.modelRequestId ? `request ${payload.modelRequestId} #${payload.physicalAttempt || 1}; ` : ''
        if (!wire.available) return `wire prepared (${identity}diagnostics unavailable${wire.truncated ? ': body exceeds diagnostic budget' : ''}; no KV-hit measurement)`
        const prefix = !wire.prefixComparable ? 'prefix not comparable' : wire.prefixChanged ? 'prefix changed' : 'prefix unchanged'
        return `wire prepared (${identity}${prefix}; ${wire.messageCount} messages; ${wire.toolCount} tools; same owner/endpoint/model/config; no KV-hit measurement)`
      }
      if (phase === 'context_prepared' && payload.contextDiagnostics) {
        const context = payload.contextDiagnostics
        const prefix = !context.prefixComparable ? 'prefix not comparable'
          : context.stablePrefixChanged ? 'prefix changed' : 'prefix unchanged'
        const memory = context.memory?.semantic?.truncated ? '; memory recall partial' : ''
        return `context prepared (${prefix}; ${context.messageCount} messages; ${context.toolCount} tools${memory}; comparison within turn)`
      }
      if (phase === 'completed') {
        const usage = modelUsageSummary(payload.usage)
        if (usage) return `model completed (${usage})`
      }
      return phase ? `model ${phase}` : null
    }
    case 'model.failover': return 'model provider failover'
    case 'tool.call':
    case 'tool.started': return name ? `tool ${name} started` : 'tool started'
    case 'tool.completed': {
      const outcome = payload.error ? 'failed' : 'finished'
      return name ? `tool ${name} ${outcome}` : `tool ${outcome}`
    }
    case 'turn.progress': {
      const parts = []
      if (payload.phase) parts.push(String(payload.phase))
      if (Number.isInteger(payload.completed) && Number.isInteger(payload.total)) {
        parts.push(`${payload.completed}/${payload.total}`)
      }
      if (Number.isInteger(payload.filesChanged)) parts.push(`${payload.filesChanged} files changed`)
      return parts.length > 0 ? `progress ${parts.join(' ')}` : null
    }
    case 'approval.required': return name ? `approval required: ${name}` : 'approval required'
    case 'approval.resolved': return `approval ${payload.proceed === true ? 'approved' : 'denied'}`
    default: return null
  }
}

export function formatRunError(error, { format = 'jsonl' } = {}) {
  const resolvedFormat = normalizeRunOutputFormat(format)
  const recovery = error?.recovery && typeof error.recovery === 'object' ? error.recovery : {}
  const serverFailure = error?.serverFailure && typeof error.serverFailure === 'object'
    ? error.serverFailure
    : {}
  const recoveryFailure = recovery.error && typeof recovery.error === 'object' ? recovery.error : {}
  const code = String(
    error?.code || serverFailure.code || recoveryFailure.code || recovery.errorCode || 'CLI_RUN_FAILED',
  ).trim() || 'CLI_RUN_FAILED'
  const message = String(
    error?.message || serverFailure.message || recoveryFailure.message
      || recovery.errorMessage || error?.reason || recovery.reason || error || 'run failed',
  ).trim()
  const causeMessage = [
    serverFailure.message,
    recoveryFailure.message,
    recovery.errorMessage,
  ].map((value) => String(value || '').trim()).find((value) => value && value !== message) || ''
  const action = String(
    error?.action || serverFailure.action || recoveryFailure.action || recovery.action || '',
  ).trim()
  const reason = String(
    error?.reason || serverFailure.reason || recoveryFailure.reason || recovery.reason || '',
  ).trim()
  const incompleteReason = String(
    error?.incompleteReason || serverFailure.incompleteReason
      || recoveryFailure.incompleteReason || recovery.incompleteReason || '',
  ).trim()
  const missingRequirements = uniqueTextValues(
    error?.missingRequirements,
    serverFailure.missingRequirements,
    recoveryFailure.missingRequirements,
    recovery.missingRequirements,
  )
  const artifactIds = uniqueTextValues(
    error?.artifactIds,
    error?.deliveryArtifactIds,
    serverFailure.artifactIds,
    serverFailure.deliveryArtifactIds,
    recoveryFailure.artifactIds,
    recoveryFailure.deliveryArtifactIds,
    recovery.artifactIds,
    recovery.deliveryArtifactIds,
  )
  const verifiedFiles = localFileLabels(
    error?.verifiedLocalFiles,
    serverFailure.verifiedLocalFiles,
    recoveryFailure.verifiedLocalFiles,
    recovery.verifiedLocalFiles,
  )
  const retainedFiles = localFileLabels(
    error?.retainedLocalFiles,
    serverFailure.retainedLocalFiles,
    recoveryFailure.retainedLocalFiles,
    recovery.retainedLocalFiles,
  )
  const verificationIssues = taskVerificationIssues(
    error?.taskVerification,
    serverFailure.taskVerification,
    recoveryFailure.taskVerification,
    recovery.taskVerification,
  )
  const policyIssues = completionPolicyIssues(error, serverFailure, recoveryFailure, recovery)
  const taskVerification = [
    error?.taskVerification,
    serverFailure.taskVerification,
    recoveryFailure.taskVerification,
    recovery.taskVerification,
  ].find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null
  const retryable = typeof error?.retryable === 'boolean'
    ? error.retryable
    : typeof serverFailure.retryable === 'boolean'
      ? serverFailure.retryable
      : typeof recoveryFailure.retryable === 'boolean'
        ? recoveryFailure.retryable
        : typeof recovery.retryable === 'boolean' ? recovery.retryable : null
  const manualRetryable = typeof error?.manualRetryable === 'boolean'
    ? error.manualRetryable
    : typeof serverFailure.manualRetryable === 'boolean'
      ? serverFailure.manualRetryable
      : typeof recoveryFailure.manualRetryable === 'boolean'
        ? recoveryFailure.manualRetryable
        : typeof recovery.manualRetryable === 'boolean' ? recovery.manualRetryable : null
  const nextAction = actionText(
    error?.nextAction || serverFailure.nextAction || recoveryFailure.nextAction
      || recovery.nextAction || error?.action || serverFailure.action
      || recoveryFailure.action || recovery.action,
  )
  const details = [`Error [${code}]: ${message}`]
  if (causeMessage) details.push(`Detail: ${causeMessage}`)
  const explicitReason = incompleteReason || reason
  if (explicitReason && explicitReason !== message) details.push(`Reason: ${explicitReason}`)
  if (missingRequirements.length > 0) details.push(`Missing: ${missingRequirements.join(', ')}`)
  if (artifactIds.length > 0) details.push(`Saved artifacts: ${artifactIds.join(', ')}`)
  if (verifiedFiles.length > 0) details.push(`Verified files: ${verifiedFiles.join(', ')}`)
  if (retainedFiles.length > 0) details.push(`Saved files awaiting verification: ${retainedFiles.join(', ')}`)
  if (verificationIssues.length > 0) details.push(`Verification: ${verificationIssues.join('; ')}`)
  if (policyIssues.length > 0) details.push(`Completion policies: ${policyIssues.join(', ')}`)
  if (nextAction) details.push(`Next: ${nextAction}`)
  else if (retryable) details.push('Next: retry this turn from its durable checkpoint.')
  else if (manualRetryable) details.push('Next: verify the recorded outcome, then retry explicitly.')
  else if (missingRequirements.length > 0) details.push('Next: satisfy the missing requirements and run again.')
  const diagnostic = line(details.join('\n'))
  if (resolvedFormat === 'text') {
    return Object.freeze({ stdout: null, stderr: diagnostic })
  }
  const event = {
    type: 'cli.error',
    error: {
      code,
      message,
      ...(causeMessage ? { causeMessage } : {}),
      ...(action ? { action } : {}),
      ...(nextAction ? { nextAction } : {}),
      ...(reason && reason !== message ? { reason } : {}),
      ...(incompleteReason ? { incompleteReason } : {}),
      ...(missingRequirements.length > 0 ? { missingRequirements } : {}),
      ...(artifactIds.length > 0 ? { artifactIds } : {}),
      ...(verifiedFiles.length > 0 ? { verifiedLocalFiles: verifiedFiles } : {}),
      ...(retainedFiles.length > 0 ? { retainedLocalFiles: retainedFiles } : {}),
      ...(taskVerification ? { taskVerification } : {}),
      ...(verificationIssues.length > 0 ? { verificationIssues } : {}),
      ...(policyIssues.length > 0 ? { completionPolicies: uniqueCompletionPolicyEntries(error, serverFailure, recoveryFailure, recovery) } : {}),
      ...(typeof retryable === 'boolean' ? { retryable } : {}),
      ...(typeof manualRetryable === 'boolean' ? { manualRetryable } : {}),
    },
  }
  return Object.freeze({ stdout: `${JSON.stringify(event)}\n`, stderr: diagnostic })
}
