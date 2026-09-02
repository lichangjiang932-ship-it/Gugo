import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'
import { CliOutputError, createSerializedWriter, handled } from './runOutputStream.js'

export { CliOutputError } from './runOutputStream.js'

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

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function completionIsExplicitlyIncomplete(value, seen = new Set()) {
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

function completedEventSucceeded(event) {
  return isSuccessfulTurnCompletedEvent(event)
}

function terminalDescriptor(event) {
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

function runResultSucceeded(result, observedTurnTerminal = null) {
  if (completionIsExplicitlyIncomplete(result)) return false
  const source = objectValue(result)
  if (Number.isInteger(source?.exitCode) && source.exitCode !== 0) return false
  const status = String(source?.status || '').trim().toLowerCase()
  if (status && !SUCCESS_RESULT_STATUSES.has(status)) return false
  const lastEvent = source?.lastEvent
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

function line(value) {
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

function terminalDiagnostic(event) {
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
  if (missingRequirements.length > 0) {
    details.push(`Missing: ${missingRequirements.join(', ')}`)
  }
  if (artifactIds.length > 0) details.push(`Saved artifacts: ${artifactIds.join(', ')}`)
  if (verifiedFiles.length > 0) details.push(`Verified files: ${verifiedFiles.join(', ')}`)
  if (retainedFiles.length > 0) details.push(`Saved files awaiting verification: ${retainedFiles.join(', ')}`)
  if (verificationIssues.length > 0) details.push(`Verification: ${verificationIssues.join('; ')}`)
  if (nextAction) details.push(`Next: ${nextAction}`)
  else if (retryable) details.push('Next: retry this turn from its durable checkpoint.')
  else if (manualRetryable) details.push('Next: verify the recorded outcome, then retry explicitly.')
  else if (missingRequirements.length > 0) details.push('Next: satisfy the missing requirements and run again.')
  else details.push('Next: inspect the stable code and terminal record before retrying.')
  return line(details.join('\n'))
}

export function formatRunEvent(event, { format = 'jsonl' } = {}) {
  const resolvedFormat = normalizeRunOutputFormat(format)
  if (resolvedFormat === 'jsonl') {
    return Object.freeze({ stdout: `${JSON.stringify(event)}\n`, stderr: null })
  }
  if (completedEventSucceeded(event)) {
    return Object.freeze({ stdout: line(event?.payload?.text), stderr: null })
  }
  const diagnostic = terminalDiagnostic(event)
  if (!diagnostic) return Object.freeze({ stdout: null, stderr: null })
  // Text mode treats stdout as a successful-result channel. Partial model
  // output remains available in JSONL but must not look like a completed
  // answer to shell pipelines when the durable terminal state is non-success.
  return Object.freeze({ stdout: null, stderr: diagnostic })
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
      ...(typeof retryable === 'boolean' ? { retryable } : {}),
      ...(typeof manualRetryable === 'boolean' ? { manualRetryable } : {}),
    },
  }
  return Object.freeze({ stdout: `${JSON.stringify(event)}\n`, stderr: diagnostic })
}

export function createRunOutputFormatter({
  format = 'jsonl',
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const resolvedFormat = normalizeRunOutputFormat(format)
  const stdoutWriter = createSerializedWriter(stdout, 'stdout')
  const stderrWriter = createSerializedWriter(stderr, 'stderr')
  let pendingCompletedText = null
  let pendingTerminalDiagnostic = null
  let observedTurnTerminal = null
  let finalized = false
  let operationTail = Promise.resolve()

  const enqueue = (operation) => {
    const result = operationTail.then(operation)
    operationTail = result.catch(() => {})
    return handled(result)
  }
  const writeOutput = async (output) => {
    let firstFailure = null
    if (output.stdout) {
      try {
        await stdoutWriter.write(output.stdout)
      } catch (error) {
        firstFailure = error
      }
    }
    if (output.stderr) {
      try {
        await stderrWriter.write(output.stderr)
      } catch (error) {
        firstFailure ||= error
      }
    }
    if (firstFailure) throw firstFailure
  }
  const flushWriters = async () => {
    const results = await Promise.allSettled([
      stdoutWriter.flush(),
      stderrWriter.flush(),
    ])
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }
  const writeEvent = (event) => {
    const output = formatRunEvent(event, { format: resolvedFormat })
    return enqueue(async () => {
      if (event?.type?.startsWith?.('turn.')
        && (event.type === 'turn.completed' || terminalDescriptor(event))) {
        observedTurnTerminal = event
      }
      if (resolvedFormat === 'text' && completedEventSucceeded(event)) {
        pendingCompletedText = output.stdout
        pendingTerminalDiagnostic = null
        return output
      }
      if (resolvedFormat === 'text' && terminalDescriptor(event)) {
        pendingCompletedText = output.stdout
        pendingTerminalDiagnostic = output.stderr
        return output
      }
      await writeOutput(output)
      return output
    })
  }
  const writeError = (error) => {
    const output = formatRunError(error, { format: resolvedFormat })
    return enqueue(async () => {
      pendingCompletedText = null
      pendingTerminalDiagnostic = null
      finalized = true
      await writeOutput(output)
      return output
    })
  }
  const finish = (result) => enqueue(async () => {
    if (finalized) {
      await flushWriters()
      return Object.freeze({ stdout: null, stderr: null })
    }
    finalized = true
    const completed = runResultSucceeded(result, observedTurnTerminal)
    const committedText = completed ? pendingCompletedText : null
    const committedDiagnostic = completed ? null : pendingTerminalDiagnostic
    pendingCompletedText = null
    pendingTerminalDiagnostic = null
    const output = Object.freeze({ stdout: committedText, stderr: committedDiagnostic })
    await writeOutput(output)
    await flushWriters()
    return output
  })
  const flush = () => enqueue(flushWriters)
  const resolveExitCode = (result) => {
    const declared = Number.isInteger(result?.exitCode) ? result.exitCode : null
    if (!runResultSucceeded(result, observedTurnTerminal)) {
      return declared !== null && declared !== 0 ? declared : 1
    }
    return declared ?? 0
  }
  return Object.freeze({
    format: resolvedFormat,
    writeEvent,
    writeError,
    finish,
    flush,
    resolveExitCode,
    onEvent: writeEvent,
  })
}
