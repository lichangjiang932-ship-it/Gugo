import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { bootstrapAuth, resolveAuthMode } from '../adapters/authAccount.js'
import { getDb } from '../db.js'
import { TurnEngine } from './TurnEngine.js'
import { decideApproval } from './approvalStore.js'
import { releaseApproval } from './approvalGate.js'
import { createTurnExecutionLeaseCoordinator } from './turnExecutionLeaseRuntime.js'
import {
  listTurnEvents,
  subscribeTurnEvents,
  turnEventForClient,
} from './turnEventStore.js'

const PERMISSION_MODES = new Set(['normal', 'acceptEdits', 'plan', 'bypass'])
const STOP_EVENT_TYPES = new Set([
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'turn.paused',
  'turn.interrupted',
])
const SUCCESS_EVENT_TYPES = new Set(['turn.completed'])

export class HeadlessTurnError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message)
    this.name = 'HeadlessTurnError'
    this.code = code
    this.exitCode = exitCode
  }
}

function normalizeMode(value) {
  const mode = String(value || 'normal').trim()
  if (!PERMISSION_MODES.has(mode)) {
    throw new HeadlessTurnError(
      'CLI_MODE_INVALID',
      'mode must be one of normal, acceptEdits, plan, bypass',
      2,
    )
  }
  return mode
}

function configureWorkspace(rawCwd, env = process.env) {
  const cwd = path.resolve(String(rawCwd || process.cwd()))
  let stat
  try {
    stat = fs.statSync(cwd)
  } catch {
    throw new HeadlessTurnError('CLI_CWD_NOT_FOUND', `cwd does not exist: ${cwd}`, 2)
  }
  if (!stat.isDirectory()) {
    throw new HeadlessTurnError('CLI_CWD_NOT_DIRECTORY', `cwd is not a directory: ${cwd}`, 2)
  }

  // A CLI invocation is an explicit, process-scoped workspace selection. It
  // must not persist a broader grant, but read tools need a trusted root in the
  // same way the local server does after workspace onboarding.
  env.WORKSPACE_ROOT = cwd
  env.WORKSPACE_FS_ENABLED ??= '1'
  env.WORKSPACE_SHARED_TRUSTED = '1'
  return cwd
}

function defaultFindResumeSession({ userId, turnId }) {
  const rows = getDb().prepare(`
    SELECT session_id, MAX(created_at) AS updated_at
    FROM turn_events
    WHERE user_id = ? AND turn_id = ?
    GROUP BY session_id
    ORDER BY updated_at DESC, session_id ASC
    LIMIT 2
  `).all(userId, turnId)
  if (rows.length === 0) {
    throw new HeadlessTurnError('TURN_NOT_FOUND', `turn not found: ${turnId}`)
  }
  if (rows.length > 1) {
    throw new HeadlessTurnError(
      'TURN_SESSION_AMBIGUOUS',
      `turn id exists in multiple sessions; pass --session-id: ${turnId}`,
      2,
    )
  }
  return rows[0].session_id
}

function normalizeApprovalDecision(value) {
  const decision = typeof value === 'string' ? value : value?.decision
  if (decision === 'approve' || decision === 'deny') return decision
  return 'deny'
}

function resultForLastEvent({ sessionId, turnId, lastEvent }) {
  const type = lastEvent?.type || null
  return {
    sessionId,
    turnId,
    status: type ? type.slice('turn.'.length) : 'unknown',
    lastEvent,
    exitCode: SUCCESS_EVENT_TYPES.has(type) ? 0 : 1,
  }
}

/**
 * Run or recover one durable TurnEngine turn without an HTTP server/browser.
 * Dependencies are injectable for CLI contract tests; production defaults are
 * the same SQLite stores, model adapter and tool loop used by the web server.
 */
export async function runHeadlessTurn({
  prompt = '',
  model = null,
  mode = 'normal',
  cwd = process.cwd(),
  sessionId = null,
  resumeTurnId = null,
  token = '',
  interactive = false,
  onEvent = () => {},
  onApproval = null,
  onToken = () => {},
  onDiagnostic = () => {},
  env = process.env,
} = {}, dependencies = {}) {
  const permissionMode = normalizeMode(mode)
  const configure = dependencies.configureWorkspace || configureWorkspace
  const workspace = configure(cwd, env)
  const authenticate = dependencies.bootstrapAuth || bootstrapAuth
  const auth = await authenticate({ token, env })
  if (!auth?.authenticated || !auth?.user?.id) {
    throw new HeadlessTurnError(
      'AUTH_REQUIRED',
      'authentication required; run gugo login and gugo verify first',
      2,
    )
  }
  if (auth.token && auth.token !== token) await onToken(auth.token)

  const userId = auth.user.id
  const authMode = auth.mode || resolveAuthMode(env)
  const turnId = String(resumeTurnId || dependencies.idFactory?.() || randomUUID())
  const findResumeSession = dependencies.findResumeSession || defaultFindResumeSession
  const resolvedSessionId = String(sessionId || (
    resumeTurnId
      ? await findResumeSession({ userId, turnId })
      : dependencies.idFactory?.() || randomUUID()
  ))
  const listEvents = dependencies.listEvents || listTurnEvents
  const subscribeEvents = dependencies.subscribeEvents || subscribeTurnEvents
  const decide = dependencies.decideApproval || decideApproval
  const release = dependencies.releaseApproval || releaseApproval
  const createEngine = dependencies.createEngine || ((options) => new TurnEngine({
    ...options,
    executionLeases: createTurnExecutionLeaseCoordinator({
      leaseMs: Number(options?.env?.TURN_EXECUTION_LEASE_MS) || undefined,
    }),
  }))
  const engine = dependencies.engine || createEngine({
    readApprovalMode: () => permissionMode,
    env,
  })
  const scope = { userId, sessionId: resolvedSessionId, turnId }
  const handledApprovalIds = new Set()
  const pendingApprovalTasks = new Set()
  let cursor = -1
  let lastEvent = null

  const resolveApproval = async (event) => {
    const approvalId = String(event?.payload?.approvalId || '')
    if (!approvalId || handledApprovalIds.has(approvalId)) return
    handledApprovalIds.add(approvalId)
    let decision = 'deny'
    if (interactive && typeof onApproval === 'function') {
      try {
        decision = normalizeApprovalDecision(await onApproval(event))
      } catch (error) {
        onDiagnostic(`approval prompt failed; denied ${approvalId}: ${error?.message || error}`)
      }
    }
    try {
      decide({
        userId,
        id: approvalId,
        decision,
        decidedBy: userId,
      })
    } finally {
      release(approvalId)
    }
  }

  const queueApproval = (event) => {
    const task = Promise.resolve()
      .then(() => resolveApproval(event))
      .catch((error) => onDiagnostic(`approval decision failed: ${error?.message || error}`))
      .finally(() => pendingApprovalTasks.delete(task))
    pendingApprovalTasks.add(task)
  }

  const deliver = (event) => {
    if (!event || !Number.isInteger(event.sequence) || event.sequence <= cursor) return
    cursor = event.sequence
    lastEvent = event
    onEvent(turnEventForClient(event))
    if (event.type === 'approval.required') queueApproval(event)
  }

  const drainPersistedEvents = () => {
    while (true) {
      const page = listEvents({ ...scope, after: cursor, limit: 2_000 })
      if (!Array.isArray(page) || page.length === 0) break
      const before = cursor
      for (const event of page) deliver(event)
      if (cursor <= before || page.length < 2_000) break
    }
  }

  const wait = dependencies.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  let unsubscribe = () => {}
  try {
    unsubscribe = subscribeEvents(scope, deliver)
    let recoveryOutcome = null
    if (resumeTurnId) {
      drainPersistedEvents()
      // A recovered checkpoint may already be waiting on an approval. Resolve
      // replayed approval events before the loop re-enters its durable waiter.
      await Promise.all([...pendingApprovalTasks])
      recoveryOutcome = await engine.recoverTurn({ ...scope, authMode })
    } else {
      const content = String(prompt || '').trim()
      if (!content) throw new HeadlessTurnError('PROMPT_REQUIRED', 'prompt is required', 2)
      await engine.startTurn({
        ...scope,
        content,
        modelName: model ? String(model) : null,
        intentMode: permissionMode === 'plan' ? 'answer' : 'auto',
        authMode,
      })
    }

    // A crashed process may leave a still-valid durable execution lease. The
    // first recovery attempt must not steal it, but a headless invocation has
    // no background recovery worker to retry after that lease expires. Keep
    // re-entering the atomic recovery path until this process owns the turn or
    // another process writes a durable stop event.
    while (
      resumeTurnId
      && recoveryOutcome
      && !recoveryOutcome.terminal
      && !recoveryOutcome.paused
      && recoveryOutcome.locallyActive === false
      && !STOP_EVENT_TYPES.has(lastEvent?.type)
    ) {
      await wait(250)
      drainPersistedEvents()
      if (STOP_EVENT_TYPES.has(lastEvent?.type)) break
      recoveryOutcome = await engine.recoverTurn({ ...scope, authMode })
    }

    await engine.waitForTurn(scope)
    drainPersistedEvents()
    await Promise.all([...pendingApprovalTasks])
    drainPersistedEvents()

    // A different process may own the execution lease. Its events are durable
    // but are not published through this process's in-memory subscription.
    while (!STOP_EVENT_TYPES.has(lastEvent?.type)) {
      await wait(250)
      drainPersistedEvents()
    }
    return { ...resultForLastEvent({ sessionId: resolvedSessionId, turnId, lastEvent }), workspace }
  } finally {
    unsubscribe()
  }
}
