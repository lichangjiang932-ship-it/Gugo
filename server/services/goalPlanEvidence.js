/**
 * Host-verifiable evidence rules for goal plan steps.
 *
 * The original rule only proved "some tool succeeded in that turn", which meant
 * a step like *"run the tests in project X and pass"* could be completed by a
 * `read_file` success from a completely different session. Two things are
 * separated now:
 *
 *   - `evidence exists`  — the referenced tool call really happened.
 *   - `evidence proves the step` — it satisfies the step's declared acceptance.
 *
 * Checks are machine-verifiable and typed (`command`, `file`, `artifact`).
 * Free-text acceptance stays as a human-readable note and never gates; a step
 * whose acceptance cannot be machine-checked can declare `manual`, which tool
 * success can never satisfy.
 *
 * Pure module: no DB, no I/O. The service supplies already-loaded events.
 */
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'
import { isSubstantiveToolCall } from '../utils/toolLoopGuard.js'

export const GOAL_EVIDENCE_SCHEMA_VERSION = 2

export const GOAL_EVIDENCE_CODES = Object.freeze({
  MISSING_TURN: 'GOAL_EVIDENCE_TURN_REQUIRED',
  TURN_NOT_FOUND: 'GOAL_EVIDENCE_TURN_NOT_FOUND',
  SESSION_MISMATCH: 'GOAL_EVIDENCE_SESSION_MISMATCH',
  TOOL_CALL_NOT_FOUND: 'GOAL_EVIDENCE_TOOL_CALL_NOT_FOUND',
  TOOL_CALL_FAILED: 'GOAL_EVIDENCE_TOOL_CALL_FAILED',
  TURN_NOT_COMPLETED: 'GOAL_EVIDENCE_TURN_NOT_COMPLETED',
  ACCEPTANCE_UNSATISFIED: 'GOAL_EVIDENCE_ACCEPTANCE_UNSATISFIED',
  TOOL_CALL_IRRELEVANT: 'GOAL_EVIDENCE_TOOL_CALL_IRRELEVANT',
  MANUAL_CONFIRMATION_REQUIRED: 'GOAL_EVIDENCE_MANUAL_CONFIRMATION_REQUIRED',
  INVALID: 'GOAL_EVIDENCE_INVALID',
})

export const GOAL_ACCEPTANCE_KINDS = Object.freeze([
  'tool', 'command', 'file', 'artifact', 'verification', 'manual',
])

const MAX_ID = 200
const MAX_TEXT = 1_000
export const DEFAULT_COMMAND_TOOLS = Object.freeze([
  'run_command', 'run_test', 'run_project_check', 'bash_exec', 'bash_background',
  'docker_exec', 'run_code',
])

function cleanId(value) {
  return String(value ?? '').trim().slice(0, MAX_ID)
}

function cleanText(value) {
  return String(value ?? '').trim().slice(0, MAX_TEXT)
}

function payloadOf(event) {
  return event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {}
}

/** A tool.completed event that carries a real, successful result. */
export function isSuccessfulToolCompletedEvent(event) {
  if (event?.type !== 'tool.completed') return false
  const payload = payloadOf(event)
  if (payload.error) return false
  const result = payload.result
  if (result === false) return false
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    if (result.ok === false || result.isError === true || result.denied === true) return false
    if (result.cancelled === true || result.interrupted === true || result.dryRun === true || result.dry_run === true) return false
    if (['failed', 'blocked', 'cancelled', 'interrupted', 'running', 'pending', 'queued', 'partial'].includes(String(result.status || '').toLowerCase())) return false
    // A command that ran but failed is not evidence of a passing step.
    if (Number.isFinite(Number(result.exitCode)) && Number(result.exitCode) !== 0) return false
  }
  return true
}

function normalizePath(value) {
  const raw = String(value ?? '').trim().replaceAll('\\', '/').replace(/\/+$/u, '')
  return /^[a-z]:\//iu.test(raw) || raw.startsWith('//') ? raw.toLowerCase() : raw
}

function toolNameOf(event) {
  const payload = payloadOf(event)
  return cleanId(payload.name || payload.toolName)
}

function argsOf(event) {
  const payload = payloadOf(event)
  const args = payload.args
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

function resultOf(event) {
  const result = payloadOf(event).result
  return result && typeof result === 'object' && !Array.isArray(result) ? result : {}
}

function resultFileOutputs(event) {
  const outputs = []
  const result = resultOf(event)
  const path = result.path || result.filePath || result.target || result.fullPath || result.output
  if (typeof path === 'string') outputs.push({ path, sha256: result.sha256 })
  for (const key of ['paths', 'changedPaths', 'files', 'verifiedOutputs']) {
    for (const entry of Array.isArray(result[key]) ? result[key] : []) {
      if (typeof entry === 'string') outputs.push({ path: entry })
      else if (entry && typeof entry === 'object') outputs.push({ path: entry.path, sha256: entry.sha256 })
    }
  }
  return outputs.filter((entry) => typeof entry.path === 'string' && entry.path.trim())
}

function commandExecutionCwd(event) {
  const result = resultOf(event)
  // New host receipts are authoritative. A malformed new receipt is not an
  // invitation to fall back to the model's requested directory.
  if (Object.hasOwn(result, 'executionCwd')) {
    if (typeof result.executionCwd !== 'string') return null
    const value = result.executionCwd.trim()
    const absolute = value.startsWith('/') || /^[a-z]:[\\/]/iu.test(value)
      || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)
    return absolute && !value.includes('\0') ? normalizePath(value) : null
  }
  // Historical receipts did not separate the request, display and execution
  // locations. Preserve their old comparison; do not rewrite persisted data.
  return normalizePath(argsOf(event).cwd || result.cwd)
}

const FILE_MUTATION_TOOLS = new Set([
  'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'patch_file', 'copy_file', 'move_file',
  'create_pdf', 'create_docx', 'create_xlsx', 'create_pptx', ...DEFAULT_COMMAND_TOOLS,
])
const SUCCESS_STATUSES = new Set(['pass', 'passed', 'success', 'succeeded', 'complete', 'completed', 'ok'])

function successfulCommandExit(event) {
  const result = resultOf(event)
  const exit = result.exitCode ?? result.exit_code
  if (exit === null || exit === undefined || exit === '' || typeof exit === 'boolean') return false
  if (!Number.isFinite(Number(exit)) || Number(exit) !== 0) return false
  const status = String(result.status || '').toLowerCase()
  return !status || SUCCESS_STATUSES.has(status) || status === 'exited'
}

function passingVerification(verification) {
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return false
  if (verification.ok === false || verification.passed === false || verification.error) return false
  if (verification.ok !== true && verification.passed !== true) return false
  if (verification.status && !SUCCESS_STATUSES.has(String(verification.status).toLowerCase())) return false
  if (verification.checks === undefined) return true
  return Array.isArray(verification.checks) && verification.checks.every((check) => (
    check && typeof check === 'object' && check.ok !== false && check.passed !== false && !check.error
    && (SUCCESS_STATUSES.has(String(check.status || '').toLowerCase()) || check.ok === true || check.passed === true)
  ))
}

/**
 * One acceptance entry -> a predicate over the turn's successful tool calls.
 * `label` is what gets reported back so a user can see *which* condition passed.
 */
function checkFor(entry) {
  const kind = entry.kind
  if (kind === 'tool') {
    return { label: 'a successful tool call', test: (event) => isSubstantiveToolCall({ name: toolNameOf(event) }) }
  }
  if (kind === 'verification') {
    // Evaluated against the terminal event, never against a tool result; the
    // predicate exists only so the label is reported consistently.
    return { label: 'host task verification passing', test: () => false }
  }
  if (kind === 'command') {
    const tools = entry.tools.length > 0 ? entry.tools : [...DEFAULT_COMMAND_TOOLS]
    const cwd = entry.cwd ? normalizePath(entry.cwd) : ''
    return {
      label: `command ${entry.command || tools.join('/')}${cwd ? ` in ${entry.cwd}` : ''} succeeding`,
      test: (event) => {
        if (!tools.includes(toolNameOf(event))) return false
        if (!successfulCommandExit(event)) return false
        const args = argsOf(event)
        const actual = commandExecutionCwd(event)
        if (cwd && actual !== cwd) return false
        const command = args.command ?? args.cmd ?? resultOf(event).command
        return !entry.command || (typeof command === 'string' && command.trim() === entry.command)
      },
    }
  }
  if (kind === 'file') {
    const path = normalizePath(entry.path)
    const sha256 = entry.sha256 ? entry.sha256.toLowerCase() : ''
    return {
      label: `file ${entry.path}${sha256 ? ` @${sha256.slice(0, 12)}` : ''} written`,
      test: (event) => {
        if (!FILE_MUTATION_TOOLS.has(toolNameOf(event))) return false
        if (DEFAULT_COMMAND_TOOLS.includes(toolNameOf(event)) && !successfulCommandExit(event)) return false
        return resultFileOutputs(event).some((output) => normalizePath(output.path) === path
          && (!sha256 || String(output.sha256 || '').toLowerCase() === sha256))
      },
    }
  }
  if (kind === 'artifact') {
    return {
      label: entry.artifactId ? `artifact ${entry.artifactId}` : `artifact of type ${entry.type || 'any'}`,
      test: (event) => {
        const payload = payloadOf(event)
        const artifacts = [...(Array.isArray(payload.artifacts) ? payload.artifacts : [])]
        if (payload.artifactId) artifacts.push({ id: payload.artifactId, type: payload.artifactType })
        return artifacts.some((item) => cleanId(item?.id || item?.artifactId)
          && (!entry.artifactId || cleanId(item.id || item.artifactId) === entry.artifactId)
          && (!entry.type || cleanId(item.type) === entry.type))
      },
    }
  }
  return null
}

/**
 * Normalize untrusted evidence input into the persisted shape.
 *
 * `manual` confirmation is carried explicitly: it is a human decision, not a
 * tool result, and is only accepted when the step's acceptance asks for it.
 */
export function normalizeStepEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const turnId = cleanId(value.turnId)
  const manualConfirmed = value.manualConfirm === true || value.manualConfirmed === true
  if (!turnId) return null
  const toolCallId = cleanId(value.toolCallId)
  const note = cleanText(value.note)
  const confirmedBy = cleanText(value.confirmedBy)
  return Object.freeze({
    version: GOAL_EVIDENCE_SCHEMA_VERSION,
    turnId,
    ...(toolCallId ? { toolCallId } : {}),
    ...(note ? { note } : {}),
    ...(manualConfirmed ? { manualConfirmed: true } : {}),
    ...(confirmedBy ? { confirmedBy } : {}),
  })
}

/**
 * Normalize a step's declared acceptance.
 *
 * Strings stay human-readable notes (they cannot gate). Objects must use one of
 * `GOAL_ACCEPTANCE_KINDS`. A step that declares no typed entry gets the
 * backward-compatible `tool` check, which is still bounded to the plan session.
 */
export function normalizeStepAcceptance(value) {
  // Idempotent: callers may hand over an already-normalized plan (the service
  // normalizes once and passes it down). Without this guard the second pass
  // saw a non-array, dropped every check and silently fell back to the
  // permissive default.
  const normalizedInput = value && !Array.isArray(value) && Array.isArray(value.checks)
  const list = normalizedInput ? value.checks : Array.isArray(value) ? value : []
  const notes = []
  if (normalizedInput && Array.isArray(value.notes)) notes.push(...value.notes.map(cleanText).filter(Boolean))
  const checks = []
  for (const item of list) {
    if (typeof item === 'string') {
      const text = cleanText(item)
      if (text) notes.push(text)
      continue
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('invalid typed goal acceptance')
    const kind = cleanId(item.kind).toLowerCase()
    if (!GOAL_ACCEPTANCE_KINDS.includes(kind)) {
      throw new TypeError(`unknown goal acceptance kind: ${kind || '(missing)'}`)
    }
    if (kind === 'command') {
      checks.push(Object.freeze({
        kind,
        tools: (Array.isArray(item.tools) ? item.tools : []).map(cleanId).filter(Boolean).slice(0, 16),
        cwd: item.cwd ? cleanText(item.cwd) : '',
        command: item.command ? cleanText(item.command) : '',
      }))
      continue
    }
    if (kind === 'file') {
      if (typeof item.path !== 'string' || !item.path.trim()) throw new TypeError('file acceptance requires a path')
      checks.push(Object.freeze({
        kind, path: cleanText(item.path), sha256: cleanId(item.sha256),
      }))
      continue
    }
    if (kind === 'artifact') {
      checks.push(Object.freeze({
        kind, artifactId: cleanId(item.artifactId), type: cleanId(item.type),
      }))
      continue
    }
    checks.push(Object.freeze({ kind }))
  }
  return Object.freeze({
    checks: Object.freeze(checks.length > 0 ? checks : [{ kind: 'tool' }]),
    notes: Object.freeze(notes),
    declared: normalizedInput && value.declared === false && checks.length === 1 && checks[0].kind === 'tool'
      ? false : checks.length > 0,
  })
}

function fail(code, detail) {
  return Object.freeze({ verified: false, code, detail })
}

function completedToolEvidence(events) {
  const proposed = new Map()
  const completed = []
  for (const event of events) {
    const payload = payloadOf(event)
    const id = cleanId(payload.toolCallId)
    if (id && (event.type === 'tool.call' || event.type === 'tool.started')) proposed.set(id, payload)
    if (event.type !== 'tool.completed') continue
    const declaration = proposed.get(id) || {}
    completed.push({ ...event, payload: { ...declaration, ...payload,
      args: { ...(declaration.args || {}), ...(payload.args || {}) } } })
  }
  return completed
}

/**
 * @param {{events?: object[], evidence?: object, sessionId?: string|null, acceptance?: unknown}} input
 */
export function verifyStepEvidence({ events = [], evidence = null, sessionId = null, acceptance = null } = {}) {
  const normalized = normalizeStepEvidence(evidence)
  if (!normalized) return fail(GOAL_EVIDENCE_CODES.INVALID, 'evidence must include a turnId')
  const planSessionId = cleanId(sessionId)
  const list = (Array.isArray(events) ? events : []).filter((event) => (
    cleanId(event?.turnId) === normalized.turnId
  ))
  if (list.length === 0) {
    return fail(GOAL_EVIDENCE_CODES.TURN_NOT_FOUND, `no persisted events for turn ${normalized.turnId}`)
  }
  // A turn from another session proves nothing about this plan, even for the
  // same user. This is what stopped "another session's read_file" from
  // completing a step about running tests here.
  if (planSessionId) {
    const foreign = list.find((event) => cleanId(event?.sessionId) !== planSessionId)
    if (foreign) {
      return fail(
        GOAL_EVIDENCE_CODES.SESSION_MISMATCH,
        `turn ${normalized.turnId} belongs to session ${cleanId(foreign.sessionId)}, not ${planSessionId}`,
      )
    }
  }

  let plan
  try { plan = normalizeStepAcceptance(acceptance) } catch (error) {
    return fail(GOAL_EVIDENCE_CODES.INVALID, error.message)
  }
  const toolEvents = completedToolEvidence(list)
  const successful = toolEvents.filter(isSuccessfulToolCompletedEvent)

  // Manual acceptance is a human decision; tool success can never stand in.
  const manualChecks = plan.checks.filter((check) => check.kind === 'manual')
  const machineChecks = plan.checks.filter((check) => check.kind !== 'manual')
  if (manualChecks.length > 0 && normalized.manualConfirmed !== true) {
    return fail(
      GOAL_EVIDENCE_CODES.MANUAL_CONFIRMATION_REQUIRED,
      'this step requires explicit human confirmation (evidence.manualConfirm)',
    )
  }

  if (normalized.toolCallId) {
    const cited = toolEvents.find((event) => cleanId(payloadOf(event).toolCallId) === normalized.toolCallId)
    if (!cited) {
      return fail(
        GOAL_EVIDENCE_CODES.TOOL_CALL_NOT_FOUND,
        `turn ${normalized.turnId} has no tool.completed for ${normalized.toolCallId}`,
      )
    }
    if (!isSuccessfulToolCompletedEvent(cited)) {
      return fail(GOAL_EVIDENCE_CODES.TOOL_CALL_FAILED, `tool call ${normalized.toolCallId} did not succeed`)
    }
  }

  // When no tool call is cited the turn itself must still carry the evidence.
  const terminal = [...list].reverse().find((event) => event?.type === 'turn.completed')
  if (!normalized.toolCallId) {
    if (!terminal || !isSuccessfulTurnCompletedEvent(terminal)) {
      return fail(
        GOAL_EVIDENCE_CODES.TURN_NOT_COMPLETED,
        `turn ${normalized.turnId} has no successful turn.completed`,
      )
    }
  }
  const predicates = machineChecks
    .filter((check) => check.kind !== 'verification')
    .map((check) => ({ check, ...checkFor(check) }))
  const satisfied = []
  const unsatisfied = []
  // A passing host task verification is a stronger signal than a raw tool
  // result, but it still has to be asked for explicitly by the step.
  for (const check of machineChecks.filter((entry) => entry.kind === 'verification')) {
    const payload = payloadOf(terminal)
    const verification = payload.taskVerification
    const passed = isSuccessfulTurnCompletedEvent(terminal) && passingVerification(verification)
    const label = checkFor(check).label
    if (passed) satisfied.push({ label, toolCallIds: [] })
    else unsatisfied.push(label)
  }
  for (const predicate of predicates) {
    const matching = successful.filter((event) => predicate.test(event))
    if (matching.length > 0) satisfied.push({ label: predicate.label, toolCallIds: matching.map((event) => cleanId(payloadOf(event).toolCallId)).filter(Boolean) })
    else unsatisfied.push(predicate.label)
  }
  if (unsatisfied.length > 0) {
    return fail(
      GOAL_EVIDENCE_CODES.ACCEPTANCE_UNSATISFIED,
      `step acceptance not satisfied by turn ${normalized.turnId}: ${unsatisfied.join('; ')}`,
    )
  }


  // Citing a specific call must be a call that actually satisfies a check; an
  // unrelated success cannot be attached to a step it has nothing to do with.
  const citedId = normalized.toolCallId || ''
  if (citedId && satisfied.length > 0) {
    const relevant = satisfied.some((item) => item.toolCallIds.includes(citedId))
    if (!relevant) {
      return fail(
        GOAL_EVIDENCE_CODES.TOOL_CALL_IRRELEVANT,
        `tool call ${citedId} does not satisfy any acceptance condition of this step`,
      )
    }
  }
  return Object.freeze({
    verified: true,
    code: 'GOAL_EVIDENCE_VERIFIED',
    turnId: normalized.turnId,
    toolCallId: normalized.toolCallId || null,
    manualConfirmed: normalized.manualConfirmed === true,
    satisfied: Object.freeze(satisfied.map((item) => Object.freeze({
      label: item.label, toolCallIds: Object.freeze([...item.toolCallIds]),
    }))),
    acceptanceDeclared: plan.declared,
  })
}
