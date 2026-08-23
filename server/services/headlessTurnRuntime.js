import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { bootstrapAuth, resolveAuthMode } from '../adapters/authAccount.js'
import { getTurnEngine } from './turnEngineHost.js'
import { decideApproval } from './approvalStore.js'
import { releaseApproval } from './approvalGate.js'
import { turnEventForClient } from './turnEventStore.js'

const PERMISSION_MODES = new Set(['normal', 'acceptEdits', 'plan', 'bypass'])
const STOP_EVENT_TYPES = new Set([
  'turn.completed',
  'turn.failed',
  'turn.blocked',
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
  const workspaceEnv = {
    WORKSPACE_ROOT: cwd,
    WORKSPACE_FS_ENABLED: env.WORKSPACE_FS_ENABLED ?? '1',
    WORKSPACE_SHARED_TRUSTED: '1',
  }
  Object.assign(env, workspaceEnv)
  if (env !== process.env) Object.assign(process.env, workspaceEnv)
  return cwd
}

function requireFunction(target, name, label) {
  if (typeof target?.[name] !== 'function') {
    throw new HeadlessTurnError(
      'TURN_PERSISTENCE_ADAPTER_INVALID',
      `${label}.${name} must be a function`,
    )
  }
  return target[name].bind(target)
}

function invalidResumeLookupResult(message) {
  return new HeadlessTurnError('TURN_PERSISTENCE_ADAPTER_INVALID', message)
}

function ownResumeLookupValue(result, key) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(result, key)
  } catch {
    descriptor = null
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw invalidResumeLookupResult(
      `turn persistence adapter resolveTurnSession result must declare own data property ${key}`,
    )
  }
  return descriptor.value
}

async function resolveResumeSessionId({ persistenceAdapter, userId, turnId }) {
  const eventLog = persistenceAdapter?.eventLog
  const resolveTurnSession = eventLog?.resolveTurnSession
  if (typeof resolveTurnSession !== 'function') {
    throw new HeadlessTurnError(
      'TURN_SESSION_LOOKUP_UNSUPPORTED',
      `persistence adapter ${persistenceAdapter?.id || 'unknown'} cannot resolve a turn id; pass --session-id`,
      2,
    )
  }

  const result = await resolveTurnSession.call(eventLog, { userId, turnId })
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw invalidResumeLookupResult(
      'turn persistence adapter resolveTurnSession must return an object',
    )
  }
  const status = ownResumeLookupValue(result, 'status')
  if (status === 'not_found') {
    throw new HeadlessTurnError('TURN_NOT_FOUND', `turn not found: ${turnId}`)
  }
  if (status === 'ambiguous') {
    throw new HeadlessTurnError(
      'TURN_SESSION_AMBIGUOUS',
      `turn id exists in multiple sessions; pass --session-id: ${turnId}`,
      2,
    )
  }
  if (status !== 'found') {
    throw invalidResumeLookupResult(
      'turn persistence adapter resolveTurnSession returned an unsupported status',
    )
  }
  const sessionId = ownResumeLookupValue(result, 'sessionId')
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalizedSessionId) {
    throw invalidResumeLookupResult(
      'turn persistence adapter resolveTurnSession found result requires a non-empty sessionId',
    )
  }
  return normalizedSessionId
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
 * the active host persistence adapter and shared TurnEngine singleton.
 */
export async function runHeadlessTurn({
  prompt = '',
  model = null,
  modelProviderId = null,
  mode = null,
  cwd = process.cwd(),
  workspaceCwd = null,
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
  const normalizedModel = model == null ? null : String(model).trim()
  const normalizedModelProviderId = modelProviderId == null ? null : String(modelProviderId).trim()
  if (model != null && !normalizedModel) {
    throw new HeadlessTurnError('CLI_OPTION_VALUE_REQUIRED', 'model requires a value', 2)
  }
  if (modelProviderId != null && !normalizedModelProviderId) {
    throw new HeadlessTurnError('CLI_OPTION_VALUE_REQUIRED', 'model Provider requires a value', 2)
  }
  const hasExplicitPermissionMode = mode !== null
    && mode !== undefined
    && String(mode).trim() !== ''
  if (resumeTurnId && hasExplicitPermissionMode) {
    throw new HeadlessTurnError(
      'CLI_RESUME_MODE_CONFLICT',
      'mode cannot be combined with resume; the persisted turn permission mode is restored',
      2,
    )
  }
  if (resumeTurnId && normalizedModelProviderId) {
    throw new HeadlessTurnError(
      'CLI_RESUME_PROVIDER_CONFLICT',
      'model Provider cannot be combined with resume; the persisted model Provider is restored',
      2,
    )
  }
  if (resumeTurnId && normalizedModel) {
    throw new HeadlessTurnError(
      'CLI_RESUME_MODEL_CONFLICT',
      'model cannot be combined with resume; the persisted model is restored',
      2,
    )
  }
  const permissionMode = resumeTurnId ? null : normalizeMode(mode)
  const executionEnv = Object.isExtensible(env) ? env : { ...env }
  const configure = dependencies.configureWorkspace || configureWorkspace
  const workspace = configure(workspaceCwd || cwd, executionEnv)
  const authenticate = dependencies.bootstrapAuth || bootstrapAuth
  const auth = await authenticate({ token, env: executionEnv })
  if (!auth?.authenticated || !auth?.user?.id) {
    throw new HeadlessTurnError(
      'AUTH_REQUIRED',
      'authentication required; run gugo login and gugo verify first',
      2,
    )
  }
  if (auth.token && auth.token !== token) await onToken(auth.token)

  const userId = auth.user.id
  const authMode = auth.mode || resolveAuthMode(executionEnv)
  const turnId = String(resumeTurnId || dependencies.idFactory?.() || randomUUID())
  const engine = dependencies.engine
    || await (dependencies.getEngine || getTurnEngine)()
  const startTurn = requireFunction(engine, 'startTurn', 'headless TurnEngine')
  const recoverTurn = requireFunction(engine, 'recoverTurn', 'headless TurnEngine')
  const waitForTurn = requireFunction(engine, 'waitForTurn', 'headless TurnEngine')
  const listEvents = dependencies.listEvents
    ? requireFunction(dependencies, 'listEvents', 'headless dependencies')
    : requireFunction(engine, 'listEvents', 'headless TurnEngine')
  const persistenceAdapter = dependencies.persistenceAdapter
    || await (dependencies.getPersistenceAdapter || (async () => {
      const { getActiveTurnPersistenceAdapter } = await import('../core/turnPersistenceAdapter.js')
      return getActiveTurnPersistenceAdapter()
    }))()
  const resolvedSessionId = String(sessionId || (
    resumeTurnId
      ? await resolveResumeSessionId({ persistenceAdapter, userId, turnId })
      : dependencies.idFactory?.() || randomUUID()
  ))
  const subscribeEvents = dependencies.subscribeEvents || null
  const decide = dependencies.decideApproval || decideApproval
  const release = dependencies.releaseApproval || releaseApproval
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
      await decide({
        userId,
        id: approvalId,
        decision,
        decidedBy: userId,
      })
    } finally {
      await release(approvalId)
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

  const drainPersistedEvents = async () => {
    while (true) {
      const page = await listEvents({ ...scope, after: cursor, limit: 2_000 })
      if (!Array.isArray(page)) {
        throw new HeadlessTurnError(
          'TURN_PERSISTENCE_ADAPTER_INVALID',
          'headless TurnEngine.listEvents must resolve to an array',
        )
      }
      if (page.length === 0) break
      const before = cursor
      for (const event of page) deliver(event)
      if (cursor <= before || page.length < 2_000) break
    }
  }

  const wait = dependencies.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  let unsubscribe = () => {}
  try {
    if (subscribeEvents) {
      const subscribe = requireFunction(dependencies, 'subscribeEvents', 'headless dependencies')
      const subscribed = await subscribe(scope, deliver)
      if (typeof subscribed !== 'function') {
        throw new HeadlessTurnError(
          'TURN_PERSISTENCE_ADAPTER_INVALID',
          'headless dependencies.subscribeEvents must resolve to an unsubscribe function',
        )
      }
      unsubscribe = subscribed
    }
    let recoveryOutcome = null
    if (resumeTurnId) {
      await drainPersistedEvents()
      // A recovered checkpoint may already be waiting on an approval. Resolve
      // replayed approval events before the loop re-enters its durable waiter.
      await Promise.all([...pendingApprovalTasks])
      recoveryOutcome = await recoverTurn({ ...scope, authMode })
    } else {
      const content = String(prompt || '').trim()
      if (!content) throw new HeadlessTurnError('PROMPT_REQUIRED', 'prompt is required', 2)
      await startTurn({
        ...scope,
        content,
        modelName: normalizedModel,
        modelProviderId: normalizedModelProviderId,
        intentMode: permissionMode === 'plan' ? 'answer' : 'auto',
        approvalMode: permissionMode,
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
      await drainPersistedEvents()
      if (STOP_EVENT_TYPES.has(lastEvent?.type)) break
      recoveryOutcome = await recoverTurn({ ...scope, authMode })
    }

    let engineWaitSettled = false
    let engineWaitError = null
    const engineWait = Promise.resolve()
      .then(() => waitForTurn(scope))
      .then(
        () => { engineWaitSettled = true },
        (error) => {
          engineWaitError = error
          engineWaitSettled = true
        },
      )
    while (!engineWaitSettled && !STOP_EVENT_TYPES.has(lastEvent?.type)) {
      await drainPersistedEvents()
      await Promise.all([...pendingApprovalTasks])
      if (engineWaitSettled || STOP_EVENT_TYPES.has(lastEvent?.type)) break
      await Promise.race([engineWait, wait(250)])
    }
    await engineWait
    if (engineWaitError) throw engineWaitError
    await drainPersistedEvents()
    await Promise.all([...pendingApprovalTasks])
    await drainPersistedEvents()

    // A different process may own the execution lease. Its events are durable
    // but are not published through this process's in-memory subscription.
    while (!STOP_EVENT_TYPES.has(lastEvent?.type)) {
      await wait(250)
      await drainPersistedEvents()
    }
    return { ...resultForLastEvent({ sessionId: resolvedSessionId, turnId, lastEvent }), workspace }
  } finally {
    await unsubscribe()
  }
}
