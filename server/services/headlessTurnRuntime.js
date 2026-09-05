import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { bootstrapAuth, resolveAuthMode } from '../adapters/authAccount.js'
import { getTurnEngine } from './turnEngineHost.js'
import { decideApproval } from './approvalStore.js'
import { releaseApproval } from './approvalGate.js'
import { turnEventForClient } from './turnEventStore.js'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'

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

function completedEventSucceeded(event) {
  return isSuccessfulTurnCompletedEvent(event)
}

function resultForLastEvent({ sessionId, turnId, lastEvent }) {
  const type = lastEvent?.type || null
  const completed = completedEventSucceeded(lastEvent)
  return {
    sessionId,
    turnId,
    status: type === 'turn.completed' && !completed
      ? 'incomplete'
      : type ? type.slice('turn.'.length) : 'unknown',
    lastEvent,
    exitCode: completed && SUCCESS_EVENT_TYPES.has(type) ? 0 : 1,
  }
}

/**
 * Run or recover one durable TurnEngine turn without an HTTP server/browser.
 * Dependencies are injectable for CLI contract tests; production defaults are
 * the active host persistence adapter and shared TurnEngine singleton.
 */
function normalizeHeadlessTurnInput(input = {}) {
  const options = {
    prompt: '', model: null, modelProviderId: null, mode: null,
    cwd: process.cwd(), workspaceCwd: null, sessionId: null, resumeTurnId: null,
    token: '', interactive: false, onEvent: () => {}, onApproval: null,
    onToken: () => {}, onDiagnostic: () => {}, signal: null, env: process.env,
    ...input,
  }
  const { signal, model, modelProviderId, mode, resumeTurnId } = options
  if (signal !== null && signal !== undefined && (
    typeof signal?.aborted !== 'boolean'
    || typeof signal?.addEventListener !== 'function'
    || typeof signal?.removeEventListener !== 'function'
  )) {
    throw new HeadlessTurnError('CLI_SIGNAL_INVALID', 'signal must be an AbortSignal', 2)
  }
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
  return {
    ...options,
    normalizedModel,
    normalizedModelProviderId,
    permissionMode: resumeTurnId ? null : normalizeMode(mode),
  }
}

async function prepareHeadlessTurn(input, dependencies) {
  const executionEnv = Object.isExtensible(input.env) ? input.env : { ...input.env }
  const configure = dependencies.configureWorkspace || configureWorkspace
  const workspace = configure(input.workspaceCwd || input.cwd, executionEnv)
  const authenticate = dependencies.bootstrapAuth || bootstrapAuth
  const auth = await authenticate({ token: input.token, env: executionEnv })
  if (!auth?.authenticated || !auth?.user?.id) {
    throw new HeadlessTurnError(
      'AUTH_REQUIRED',
      'authentication required; run gugo login and gugo verify first',
      2,
    )
  }
  if (auth.token && auth.token !== input.token) await input.onToken(auth.token)
  const userId = auth.user.id
  const authMode = auth.mode || resolveAuthMode(executionEnv)
  const turnId = String(input.resumeTurnId || dependencies.idFactory?.() || randomUUID())
  const engine = dependencies.engine || await (dependencies.getEngine || getTurnEngine)()
  const startTurn = requireFunction(engine, 'startTurn', 'headless TurnEngine')
  const recoverTurn = requireFunction(engine, 'recoverTurn', 'headless TurnEngine')
  const resumeTurn = typeof engine?.resumeTurn === 'function' ? engine.resumeTurn.bind(engine) : null
  const waitForTurn = requireFunction(engine, 'waitForTurn', 'headless TurnEngine')
  const cancelTurn = input.signal
    ? requireFunction(engine, 'cancelTurn', 'headless TurnEngine')
    : null
  const listEvents = dependencies.listEvents
    ? requireFunction(dependencies, 'listEvents', 'headless dependencies')
    : requireFunction(engine, 'listEvents', 'headless TurnEngine')
  const persistenceAdapter = dependencies.persistenceAdapter
    || await (dependencies.getPersistenceAdapter || (async () => {
      const { getActiveTurnPersistenceAdapter } = await import('../core/turnPersistenceAdapter.js')
      return getActiveTurnPersistenceAdapter()
    }))()
  const resolvedSessionId = String(input.sessionId || (
    input.resumeTurnId
      ? await resolveResumeSessionId({ persistenceAdapter, userId, turnId })
      : dependencies.idFactory?.() || randomUUID()
  ))
  return {
    input,
    dependencies,
    executionEnv,
    workspace,
    authMode,
    scope: { userId, sessionId: resolvedSessionId, turnId },
    startTurn,
    recoverTurn,
    resumeTurn,
    waitForTurn,
    cancelTurn,
    listEvents,
    decide: dependencies.decideApproval || decideApproval,
    release: dependencies.releaseApproval || releaseApproval,
    subscribeEvents: dependencies.subscribeEvents || null,
    wait: dependencies.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  }
}

function createHeadlessEventController(runtime) {
  const { input, scope } = runtime
  const state = {
    handledApprovalIds: new Set(),
    pendingApprovalTasks: new Set(),
    cursor: -1,
    lastEvent: null,
    turnReadyForCancellation: Boolean(input.resumeTurnId),
    cancellationRequested: false,
    cancellationStarted: false,
    cancellationError: null,
    cancellationTask: null,
  }
  const resolveApproval = async (event) => {
    const approvalId = String(event?.payload?.approvalId || '')
    if (!approvalId || state.handledApprovalIds.has(approvalId)) return
    state.handledApprovalIds.add(approvalId)
    let decision = 'deny'
    if (input.interactive && typeof input.onApproval === 'function') {
      try {
        decision = normalizeApprovalDecision(await input.onApproval(event))
      } catch (error) {
        input.onDiagnostic(`approval prompt failed; denied ${approvalId}: ${error?.message || error}`)
      }
    }
    try {
      await runtime.decide({
        userId: scope.userId,
        id: approvalId,
        decision,
        decidedBy: scope.userId,
      })
    } finally {
      await runtime.release(approvalId)
    }
  }
  const queueApproval = (event) => {
    const task = Promise.resolve()
      .then(() => resolveApproval(event))
      .catch((error) => input.onDiagnostic(`approval decision failed: ${error?.message || error}`))
      .finally(() => state.pendingApprovalTasks.delete(task))
    state.pendingApprovalTasks.add(task)
  }
  const deliver = (event) => {
    if (!event || !Number.isInteger(event.sequence) || event.sequence <= state.cursor) return
    state.cursor = event.sequence
    state.lastEvent = event
    input.onEvent(turnEventForClient(event))
    if (event.type === 'approval.required') queueApproval(event)
  }
  const drainPersistedEvents = async () => {
    while (true) {
      const page = await runtime.listEvents({ ...scope, after: state.cursor, limit: 2_000 })
      if (!Array.isArray(page)) {
        throw new HeadlessTurnError(
          'TURN_PERSISTENCE_ADAPTER_INVALID',
          'headless TurnEngine.listEvents must resolve to an array',
        )
      }
      if (page.length === 0) break
      const before = state.cursor
      for (const event of page) deliver(event)
      if (state.cursor <= before || page.length < 2_000) break
    }
  }
  const requestCancellation = () => {
    state.cancellationRequested = true
    if (!state.turnReadyForCancellation || state.cancellationStarted || !runtime.cancelTurn) return
    state.cancellationStarted = true
    state.cancellationTask = Promise.resolve()
      .then(() => runtime.cancelTurn({ ...scope, authMode: runtime.authMode }))
      .catch((error) => {
        state.cancellationError = error
        input.onDiagnostic(`turn cancellation failed: ${error?.message || error}`)
      })
  }
  const throwCancellationError = () => {
    if (state.cancellationError) throw state.cancellationError
  }
  return {
    state,
    deliver,
    drainPersistedEvents,
    requestCancellation,
    throwCancellationError,
  }
}

async function startOrRecoverHeadlessTurn(runtime, controller) {
  const { input, scope } = runtime
  if (input.resumeTurnId) {
    await controller.drainPersistedEvents()
    await Promise.all([...controller.state.pendingApprovalTasks])
    if (runtime.resumeTurn) {
      const resumedTurn = await runtime.resumeTurn({
        ...scope, authMode: runtime.authMode, retryRecovery: true,
      })
      return {
        turn: resumedTurn,
        terminal: ['completed', 'failed', 'cancelled'].includes(resumedTurn?.status),
        paused: resumedTurn?.status === 'paused',
        locallyActive: false,
      }
    }
    return runtime.recoverTurn({ ...scope, authMode: runtime.authMode })
  }
  const content = String(input.prompt || '').trim()
  if (!content) throw new HeadlessTurnError('PROMPT_REQUIRED', 'prompt is required', 2)
  await runtime.startTurn({
    ...scope,
    content,
    modelName: input.normalizedModel,
    modelProviderId: input.normalizedModelProviderId,
    intentMode: input.permissionMode === 'plan' ? 'answer' : 'auto',
    approvalMode: input.permissionMode,
    authMode: runtime.authMode,
  })
  controller.state.turnReadyForCancellation = true
  if (controller.state.cancellationRequested) controller.requestCancellation()
  return null
}

async function waitForHeadlessTurn(runtime, controller, recoveryOutcome) {
  const { input, scope } = runtime
  const { state } = controller
  while (input.resumeTurnId
    && recoveryOutcome
    && !recoveryOutcome.terminal
    && !recoveryOutcome.paused
    && recoveryOutcome.locallyActive === false
    && !STOP_EVENT_TYPES.has(state.lastEvent?.type)) {
    await runtime.wait(250)
    await controller.drainPersistedEvents()
    controller.throwCancellationError()
    if (STOP_EVENT_TYPES.has(state.lastEvent?.type)) break
    recoveryOutcome = await runtime.recoverTurn({ ...scope, authMode: runtime.authMode })
  }
  let engineWaitSettled = false
  let engineWaitError = null
  const engineWait = Promise.resolve()
    .then(() => runtime.waitForTurn(scope))
    .then(
      () => { engineWaitSettled = true },
      (error) => {
        engineWaitError = error
        engineWaitSettled = true
      },
    )
  while (!engineWaitSettled && !STOP_EVENT_TYPES.has(state.lastEvent?.type)) {
    await controller.drainPersistedEvents()
    await Promise.all([...state.pendingApprovalTasks])
    controller.throwCancellationError()
    if (engineWaitSettled || STOP_EVENT_TYPES.has(state.lastEvent?.type)) break
    await Promise.race([engineWait, runtime.wait(250)])
  }
  if (!STOP_EVENT_TYPES.has(state.lastEvent?.type)) await engineWait
  if (engineWaitSettled && engineWaitError) throw engineWaitError
  controller.throwCancellationError()
  await controller.drainPersistedEvents()
  await Promise.all([...state.pendingApprovalTasks])
  await controller.drainPersistedEvents()
  while (!STOP_EVENT_TYPES.has(state.lastEvent?.type)) {
    await runtime.wait(250)
    await controller.drainPersistedEvents()
    controller.throwCancellationError()
  }
  if (state.cancellationTask) await state.cancellationTask
  controller.throwCancellationError()
  return {
    ...resultForLastEvent({
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      lastEvent: state.lastEvent,
    }),
    workspace: runtime.workspace,
  }
}

async function executeHeadlessTurn(runtime) {
  const controller = createHeadlessEventController(runtime)
  let unsubscribe = () => {}
  let removeAbortListener = () => {}
  try {
    if (runtime.input.signal) {
      const onAbort = () => controller.requestCancellation()
      runtime.input.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => runtime.input.signal.removeEventListener('abort', onAbort)
      if (runtime.input.signal.aborted) onAbort()
    }
    if (runtime.subscribeEvents) {
      const subscribe = requireFunction(runtime.dependencies, 'subscribeEvents', 'headless dependencies')
      const subscribed = await subscribe(runtime.scope, controller.deliver)
      if (typeof subscribed !== 'function') {
        throw new HeadlessTurnError(
          'TURN_PERSISTENCE_ADAPTER_INVALID',
          'headless dependencies.subscribeEvents must resolve to an unsubscribe function',
        )
      }
      unsubscribe = subscribed
    }
    const recoveryOutcome = await startOrRecoverHeadlessTurn(runtime, controller)
    return await waitForHeadlessTurn(runtime, controller, recoveryOutcome)
  } finally {
    removeAbortListener()
    await unsubscribe()
  }
}

/** Run or recover one durable TurnEngine turn without an HTTP server/browser. */
export async function runHeadlessTurn(input = {}, dependencies = {}) {
  const normalizedInput = normalizeHeadlessTurnInput(input)
  const runtime = await prepareHeadlessTurn(normalizedInput, dependencies)
  return executeHeadlessTurn(runtime)
}
