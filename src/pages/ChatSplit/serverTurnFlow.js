import { serializeAttachmentReferences } from '../../lib/attachmentClient.js'
import { buildLocalPathEvidenceInstruction, buildLocalPathToolInstruction, resolveLocalPathToolNames } from '../../lib/localPathPreflight.js'
import { createBufferedTurnActivityDispatcher, dispatchTurnEvent, runServerTurn } from '../../lib/turnClient.js'
import {
  createTurnFailureError,
  isModelRequestOutcomeUnknownRecoveryKind,
  isSideEffectOutcomeUnknownRecoveryKind,
  MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND,
  SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND,
} from '../../lib/turnClient/turnEventDispatch.js'
import { TASK_STATUS, HISTORY_STATUS } from '../../store/taskStatus.js'
import {
  artifactTypeForSkill,
  buildChatFailureDisplayKey,
  buildChatFailureMessage,
  getVisibleTurnClarification,
  isPreExecutionFailure,
} from '../../lib/chatFlowGuards.js'
import { isServerTurnToolToggle } from '../../lib/serverToolConfig.js'
import { registerTurnRun, unregisterTurnRun } from './turnRunRegistry.js'
import { mergeAssistantText, missingAssistantTextSuffix } from '../../lib/assistantTextContinuity.js'

const CODE_EXECUTION_CONTINUITY_TOOLS = new Set([
  'list_directory',
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'run_project_check',
])

const MUTATION_TOOL_NAMES = ['write_file', 'edit_file', 'apply_patch']
const READBACK_VERIFICATION_TOOL_NAMES = ['list_directory', 'read_file']
const GIT_MUTATION_TOOL_NAMES = ['git_commit', 'git_push', 'git_rollback']
const GIT_VERIFICATION_TOOL_NAMES = ['git_status', 'git_diff']

function successfulHistoryToolNames(historyMessages = []) {
  const names = new Set()
  for (const message of Array.isArray(historyMessages) ? historyMessages : []) {
    if (message?.role !== 'tool') continue
    const name = String(message?.name || '').trim()
    if (!CODE_EXECUTION_CONTINUITY_TOOLS.has(name)) continue
    let result = null
    try { result = JSON.parse(String(message.content || '')) } catch { /* non-JSON evidence is not trusted */ }
    if (result?.ok === true) names.add(name)
  }
  return names
}

export function isUserStopped(error) {
  return error?.name === 'AbortError' || error?.code === 'USER_STOPPED'
}

export function turnEventTimestamp(eventOrTimestamp, fallback = Date.now()) {
  const raw = eventOrTimestamp && typeof eventOrTimestamp === 'object'
    ? eventOrTimestamp.createdAt
    : eventOrTimestamp
  if (raw == null || raw === '') return fallback
  const timestamp = Number(raw)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback
}

export async function collectLocalPathEvidence({ localPathAccess, probeLocalPathAccess, signal }) {
  if (typeof probeLocalPathAccess !== 'function') return []
  try {
    const results = await probeLocalPathAccess(localPathAccess, { signal })
    return Array.isArray(results) ? results : []
  } catch (error) {
    if (isUserStopped(error)) throw error
    const paths = Array.isArray(localPathAccess?.paths) ? localPathAccess.paths : []
    return paths.map((path) => ({
      path,
      tool: 'local_path_probe',
      ok: false,
      content: JSON.stringify({
        code: 'LOCAL_PATH_PROBE_FAILED',
        error: error?.message || String(error),
      }),
    }))
  }
}

function serializeServerTurnContent(content, t) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content || '')
  return content.map((part) => {
    if (part?.type === 'text') return String(part.text || '')
    if (part?.type === 'image_url') return t('chat.serverTurn.imageAttachmentPlaceholder')
    if (part?.type === 'yma_pdf') return String(part.fallback_text || t('chat.serverTurn.pdfFallback'))
    return ''
  }).filter(Boolean).join('\n\n')
}

export function buildServerToolsConfig(toolsConfig = {}, localPathAccess = {}, historyMessages = []) {
  const enabled = new Set()
  const disabled = new Set()
  for (const [rawName, value] of Object.entries(toolsConfig || {})) {
    const name = String(rawName || '').trim()
    if (!isServerTurnToolToggle(name)) continue
    if (value === true) enabled.add(name)
    else if (value === false) disabled.add(name)
  }
  // A follow-up execution turn receives the preceding tool transcript. Keep
  // tools that already succeeded in that transcript available while code
  // execution remains enabled; otherwise the model sees a valid prior
  // write_file call and the next turn rejects the same call as unknown. Path
  // grants and write access are still enforced independently by the server.
  if (enabled.has('bash_exec') && !disabled.has('bash_exec')) {
    for (const name of successfulHistoryToolNames(historyMessages)) {
      enabled.add(name)
      disabled.delete(name)
    }
  }
  const effectiveEnabled = resolveLocalPathToolNames(enabled, localPathAccess)
  for (const name of effectiveEnabled) {
    enabled.add(name)
    disabled.delete(name)
  }
  // A turn that can mutate files must also be able to verify those mutations.
  // This matters most on execution follow-ups: write_file may be restored from
  // successful history while the persisted UI defaults still mark both read
  // tools disabled. Without this dependency the model can write successfully,
  // then receives unknown_tool for the mandatory readback/directory check.
  if (MUTATION_TOOL_NAMES.some((name) => enabled.has(name) && !disabled.has(name))) {
    for (const name of READBACK_VERIFICATION_TOOL_NAMES) {
      enabled.add(name)
      disabled.delete(name)
    }
  }
  if (GIT_MUTATION_TOOL_NAMES.some((name) => enabled.has(name) && !disabled.has(name))) {
    for (const name of GIT_VERIFICATION_TOOL_NAMES) {
      enabled.add(name)
      disabled.delete(name)
    }
  }
  return { enabled: [...enabled].sort(), disabled: [...disabled].sort() }
}

export function buildServerTurnMessageIds(turnId) {
  const normalized = String(turnId || '').trim()
  if (!normalized) throw new Error('turnId is required')
  return { userId: `${normalized}:user`, assistantId: `${normalized}:assistant` }
}

export function normalizeServerTurnFailure(error) {
  const nested = error?.serverFailure && typeof error.serverFailure === 'object'
    ? error.serverFailure
    : {}
  const failure = {
    ...nested,
    code: String(nested.code || error?.code || 'TURN_REQUEST_FAILED').trim() || 'TURN_REQUEST_FAILED',
    message: String(nested.message || error?.message || 'Turn request failed').trim() || 'Turn request failed',
  }
  for (const field of [
    'status',
    'action',
    'providerId',
    'modelName',
    'configRevision',
    'details',
    'expectedSequence',
    'actualSequence',
    'recovery',
    'retryable',
    'manualRetryable',
    'retryAfter',
    'incompleteReason',
    'missingRequirements',
    'taskVerification',
    'attempts',
  ]) {
    if (failure[field] === undefined && error?.[field] !== undefined) failure[field] = error[field]
  }
  const nestedIncompleteReason = String(failure.incompleteReason || '').trim()
  const outerIncompleteReason = String(error?.incompleteReason || '').trim()
  if (!nestedIncompleteReason && outerIncompleteReason) failure.incompleteReason = outerIncompleteReason
  const nestedMissingRequirements = Array.isArray(failure.missingRequirements)
    ? failure.missingRequirements.filter(Boolean)
    : []
  const outerMissingRequirements = Array.isArray(error?.missingRequirements)
    ? error.missingRequirements.filter(Boolean)
    : []
  if (nestedMissingRequirements.length === 0 && outerMissingRequirements.length > 0) {
    failure.missingRequirements = outerMissingRequirements
  }
  const nestedTaskVerification = failure.taskVerification
    && typeof failure.taskVerification === 'object'
    && !Array.isArray(failure.taskVerification)
    && Object.keys(failure.taskVerification).length > 0
  const outerTaskVerification = error?.taskVerification
    && typeof error.taskVerification === 'object'
    && !Array.isArray(error.taskVerification)
    && Object.keys(error.taskVerification).length > 0
  if (!nestedTaskVerification && outerTaskVerification) {
    failure.taskVerification = error.taskVerification
  }
  return failure
}

export function terminalFailureEvidenceMeta(error) {
  if (!error || typeof error !== 'object') return {}
  const meta = {}
  if (Object.hasOwn(error, 'partialText')) meta.serverPartialText = String(error.partialText || '')
  // UPDATE_LAST_MESSAGE_META is a merge. Omitting empty failure evidence keeps
  // richer data already received from the terminal event instead of replacing
  // it with an empty transport/reconnect fallback.
  if (Array.isArray(error.artifactIds) && error.artifactIds.length > 0) {
    meta.serverArtifactIds = error.artifactIds
  }
  if (Array.isArray(error.deliveryArtifactIds) && error.deliveryArtifactIds.length > 0) {
    meta.serverDeliveryArtifactIds = error.deliveryArtifactIds
  }
  if (Array.isArray(error.verifiedLocalFiles) && error.verifiedLocalFiles.length > 0) {
    meta.verifiedLocalFiles = error.verifiedLocalFiles
  }
  if (Array.isArray(error.retainedLocalFiles) && error.retainedLocalFiles.length > 0) {
    meta.retainedLocalFiles = error.retainedLocalFiles
  }
  if (Number.isInteger(error.iterations) && error.iterations >= 0) {
    meta.serverIterations = error.iterations
  }
  return meta
}

function appendArtifact(artifact, artifacts, dispatchMessage) {
  const filename = artifact.filename || 'artifact'
  const type = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'file'
  if (artifacts.some((item) => item.id === artifact.id)) return
  artifacts.push({ ...artifact, filename, type })
  dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverArtifacts: [...artifacts] })
}

export async function runServerChatTurn({
  abortCtrlRef,
  agentId,
  attachments,
  content,
  displayContent,
  dispatch,
  explicitAttachments,
  historyMessages,
  intentMode,
  localPathAccess,
  modelConfigRevision,
  modelName,
  modelProviderId,
  modelMode = 'agent',
  onTurnAccepted,
  probeLocalPathAccess,
  requestServerToolApproval,
  resolveToolApprovalForOwner,
  sessionId,
  setContextSystemPrompts,
  skill,
  skillId,
  taskId,
  taskName,
  t,
  clearToolApprovalForOwner,
  toolsConfig,
  turnId,
  userPrompt,
  workspacePath,
}) {
  const controller = new AbortController()
  const owner = { sessionId, turnId }
  registerTurnRun({ sessionId, turnId, controller })
  abortCtrlRef.current = controller
  const startedAt = Date.now()
  const serverArtifacts = []
  let currentAssistantText = ''
  let executionStarted = false
  let uiCommitted = false
  const pendingTurnEvents = []
  const pendingTurnActivities = []
  const initialArtifactType = artifactTypeForSkill(skillId)
  const { assistantId: assistantMessageId } = buildServerTurnMessageIds(turnId)
  const messageTarget = { sessionId, messageId: assistantMessageId }
  const dispatchMessage = (type, payload) => dispatch({ type, payload, ...messageTarget })
  const appendMissingAssistantText = (candidate) => {
    const suffix = missingAssistantTextSuffix(currentAssistantText, candidate)
    if (suffix) dispatchMessage('APPEND_TO_LAST_MESSAGE', suffix)
    currentAssistantText = mergeAssistantText(currentAssistantText, candidate)
    return suffix
  }
  const turnActivityDispatcher = createBufferedTurnActivityDispatcher({ dispatch, taskId, messageTarget })
  controller.signal.addEventListener('abort', () => {
    turnActivityDispatcher.flush()
    resolveToolApprovalForOwner(owner, { approved: false })
  }, { once: true })
  const commitTurnUi = (turn) => {
    if (uiCommitted) return
    uiCommitted = true
    onTurnAccepted?.(turn)
    setContextSystemPrompts((current) => ({ ...current, [sessionId || '__draft__']: '' }))
    dispatch({
      type: 'ADD_TASK',
      payload: { id: taskId, name: taskName, detail: content, status: TASK_STATUS.RUNNING, step: 1, stepLabel: t('chat.serverTurn.submit'), perms: skill?.perms || [] },
    })
    dispatch({
      type: 'RECEIVE_MESSAGE',
      payload: {
        id: assistantMessageId,
        sessionId,
        content: '',
        meta: {
          skillId,
          artifactType: initialArtifactType,
          artifactTitle: initialArtifactType ? taskName : undefined,
          streaming: true,
          executionStarted: false,
          turnStartedAt: startedAt,
          modelActivity: { kind: 'preparing' },
          serverTurnId: turnId,
          serverLastSequence: -1,
        },
      },
    })
  }
  const handleTurnEvent = async (event) => {
    if (event.type === 'turn.attempt' && event.payload?.resetStreaming) {
      currentAssistantText = String(event.payload?.assistantText || '')
    }
    else if (event.type === 'assistant.delta' && event.payload?.text) {
      currentAssistantText += String(event.payload.text)
    }
    const dispatchResult = await dispatchTurnEvent(event, {
      dispatch,
      taskId,
      messageTarget,
      flushToolOutput: turnActivityDispatcher.flush,
      onApproval: (request) => requestServerToolApproval(request, owner),
      onArtifact: (artifact) => appendArtifact(artifact, serverArtifacts, dispatchMessage),
    })
    if (!dispatchResult?.cursorCommitted) {
      dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverLastSequence: event.sequence })
    }
  }
  try {
    const localPathInstruction = buildLocalPathToolInstruction(
      localPathAccess.paths,
      localPathAccess.accessMode,
      localPathAccess.resources,
    )
    const localPathEvidence = await collectLocalPathEvidence({
      localPathAccess,
      probeLocalPathAccess,
      signal: controller.signal,
    })
    const localPathEvidenceInstruction = buildLocalPathEvidenceInstruction(localPathEvidence)
    const attachmentReferences = serializeAttachmentReferences(explicitAttachments || attachments)
    const serverContent = [
      localPathInstruction,
      localPathEvidenceInstruction,
      serializeServerTurnContent(userPrompt || content, t),
    ].filter(Boolean).join('\n\n')
    const { terminal, sessionSnapshot } = await runServerTurn({
      sessionId,
      content: serverContent,
      displayContent,
      attachments: attachmentReferences,
      workspacePath,
      modelConfigRevision,
      modelName,
      modelProviderId,
      modelMode,
      turnId,
      history: historyMessages,
      agentId,
      skillIds: skillId ? [skillId] : [],
      skillDefinitions: skill?.localCustom ? [skill] : [],
      intentMode,
      syncSessionSnapshot: true,
      toolsConfig: buildServerToolsConfig(toolsConfig, localPathAccess, historyMessages),
      signal: controller.signal,
      onStarted: async (turn) => {
        commitTurnUi(turn)
        executionStarted = true
        dispatchMessage('UPDATE_LAST_MESSAGE_META', {
          executionStarted: true,
          serverTurnId: turn.turnId,
          serverLastSequence: -1,
        })
        for (const activity of pendingTurnActivities.splice(0)) turnActivityDispatcher.onActivity(activity)
        for (const event of pendingTurnEvents.splice(0)) await handleTurnEvent(event)
      },
      onConnectionState: ({ status, attempt, maxAttempts }) => {
        if (!uiCommitted) return
        if (status === 'reconnecting') {
          dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverConnectionState: 'reconnecting', modelActivity: null })
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: t('chat.serverTurn.reconnecting', { attempt, max: maxAttempts }) } } })
        } else if (status === 'connected') {
          dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverConnectionState: 'connected', modelActivity: null })
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: t('chat.serverTurn.reconnected') } } })
        } else if (status === 'cancelling') {
          dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverConnectionState: 'cancelling', modelActivity: null })
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: t('taskCenter.statuses.cancel_requested') } } })
        }
      },
      onActivity: (activity) => {
        if (!uiCommitted) pendingTurnActivities.push(activity)
        else turnActivityDispatcher.onActivity(activity)
      },
      onEvent: async (event) => {
        if (!uiCommitted) pendingTurnEvents.push(event)
        else await handleTurnEvent(event)
      },
    })
    turnActivityDispatcher.flush()
    if (terminal.type === 'turn.failed') {
      const error = createTurnFailureError(terminal.payload)
      error.turnCompletedAt = turnEventTimestamp(terminal)
      error.sessionSnapshot = sessionSnapshot
      appendMissingAssistantText(error.partialText)
      throw error
    }
    if (terminal.type === 'turn.cancelled') {
      const error = new Error('Generation stopped')
      error.name = 'AbortError'
      error.turnCompletedAt = turnEventTimestamp(terminal)
      throw error
    }
    if (terminal.type === 'turn.blocked') {
      appendMissingAssistantText(terminal.payload?.partialText ?? terminal.payload?.text)
      dispatchMessage('UPDATE_LAST_MESSAGE_META', {
        type: 'model_reply',
        modelName: modelName || 'backend-default',
        latency: null,
        turnCompletedAt: null,
        streaming: false,
        cancelled: false,
        interrupted: false,
        paused: false,
        failed: false,
        serverClarification: null,
        directoryAuthorizationPending: false,
        serverResumeResolution: null,
        serverArtifacts,
        serverConnectionState: 'blocked',
        serverRecoveryBlocked: true,
        serverRecoveryKind: null,
        serverRecoveryToolCallId: null,
        serverRecoveryModelRequestId: null,
        serverRecoveryActionPath: null,
        ...(isSideEffectOutcomeUnknownRecoveryKind(terminal.payload?.recoveryKind) ? {
          serverRecoveryKind: SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND,
          serverRecoveryToolCallId: terminal.payload?.toolCallId || null,
          serverRecoveryActionPath: '/settings?tab=recovery',
        } : {}),
        ...(isModelRequestOutcomeUnknownRecoveryKind(terminal.payload?.recoveryKind) ? {
          serverRecoveryKind: MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND,
          serverRecoveryModelRequestId: terminal.payload?.modelRequestId || null,
          serverRecoveryActionPath: '/settings?tab=recovery',
        } : {}),
      })
      dispatch({
        type: 'UPDATE_TASK',
        payload: {
          id: taskId,
          updates: {
            status: TASK_STATUS.PENDING,
            stepLabel: terminal.payload?.recoveryKind === MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND
              ? t('chatMessages.modelRequestUnknownTitle')
              : terminal.payload?.recoveryKind === SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND
                ? t('chatMessages.sideEffectUnknownTitle')
                : t('chat.serverTurn.resumeFailed'),
          },
        },
      })
      return { blocked: true, terminal, recovery: terminal.payload }
    }
    if (terminal.type === 'turn.paused') {
      const clarificationText = getVisibleTurnClarification(terminal.payload?.clarification, t)
      appendMissingAssistantText(terminal.payload?.text || clarificationText)
      const completedAt = turnEventTimestamp(terminal)
      dispatchMessage('UPDATE_LAST_MESSAGE_META', {
        type: 'model_reply',
        modelName: modelName || 'backend-default',
        latency: Math.max(0, completedAt - startedAt),
        turnCompletedAt: completedAt,
        streaming: false,
        cancelled: false,
        failed: false,
        interrupted: false,
        paused: true,
        serverArtifacts,
        serverConnectionState: 'paused',
        serverClarification: terminal.payload?.clarification || null,
      })
      dispatch({
        type: 'UPDATE_TASK',
        payload: {
          id: taskId,
          updates: {
            status: TASK_STATUS.PENDING,
            stepLabel: clarificationText || t('chat.serverTurn.resumeDetail'),
          },
        },
      })
      setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
      return { paused: true, clarification: terminal.payload?.clarification || null }
    }
    appendMissingAssistantText(terminal.payload?.text)
    const completedAt = turnEventTimestamp(terminal)
    dispatchMessage('UPDATE_LAST_MESSAGE_META', {
      type: 'model_reply',
      modelName: modelName || 'backend-default',
      latency: Math.max(0, completedAt - startedAt),
      turnCompletedAt: completedAt,
      streaming: false,
      cancelled: false,
      failed: false,
      interrupted: false,
      paused: false,
      serverClarification: null,
      directoryAuthorizationPending: false,
      serverResumeResolution: null,
      serverArtifacts,
      serverConnectionState: null,
    })
    if (sessionSnapshot) {
      dispatch({ type: 'APPLY_SERVER_SESSION_SNAPSHOT', payload: { sessionId, snapshot: sessionSnapshot } })
    }
    dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.COMPLETED, stepLabel: t('chat.serverTurn.completed') } } })
    setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
    dispatch({ type: 'ADD_HISTORY', payload: { name: taskName, skill: skill?.name || t('chat.serverTurn.generalChat'), status: HISTORY_STATUS.SUCCESS, detail: content.slice(0, 60), state: t('chat.serverTurn.completed'), date: Date.now() } })
    return {
      terminal,
      sessionSnapshot,
      paused: terminal.payload?.paused === true,
      clarification: terminal.payload?.clarification || null,
    }
  } catch (error) {
    turnActivityDispatcher.flush()
    if (!uiCommitted) return { failed: true, error, rejectedBeforeStart: true }
    const completedAt = turnEventTimestamp(error?.turnCompletedAt)
    if (isUserStopped(error)) {
      dispatchMessage('APPEND_TO_LAST_MESSAGE', `\n\n${t('chat.serverTurn.stoppedMarker')}`)
      dispatchMessage('UPDATE_LAST_MESSAGE_META', {
        streaming: false,
        cancelled: true,
        failed: false,
        interrupted: false,
        paused: false,
        latency: Math.max(0, completedAt - startedAt),
        turnCompletedAt: completedAt,
        serverArtifacts,
        serverConnectionState: 'cancelled',
      })
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.CANCELLED, stepLabel: t('chat.serverTurn.cancelled') } } })
    } else {
      const serverFailure = normalizeServerTurnFailure(error)
      const failureEvidenceMeta = terminalFailureEvidenceMeta(error)
      const failureView = {
        role: 'assistant',
        message: error?.message,
        meta: {
          failed: true,
          executionStarted,
          serverFailure,
          serverArtifacts,
          ...failureEvidenceMeta,
        },
      }
      const failedBeforeExecution = executionStarted === false && isPreExecutionFailure(failureView)
      const serverFailureDisplayKey = buildChatFailureDisplayKey(turnId, error)
      dispatch({
        type: 'APPEND_TO_LAST_MESSAGE',
        payload: buildChatFailureMessage(failureView, t),
        meta: { serverFailureDisplayKey },
        ...messageTarget,
      })
      dispatchMessage('UPDATE_LAST_MESSAGE_META', {
        streaming: false,
        executionStarted,
        ...(failedBeforeExecution ? {} : {
          latency: Math.max(0, completedAt - startedAt),
          turnCompletedAt: completedAt,
        }),
        cancelled: false,
        failed: true,
        interrupted: false,
        paused: false,
        serverConnectionState: null,
        serverFailure,
        serverFailureDisplayKey,
        ...(failedBeforeExecution ? {} : {
          serverArtifacts,
          ...failureEvidenceMeta,
        }),
      })
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.FAILED, stepLabel: t('chat.serverTurn.failed') } } })
      if (error.sessionSnapshot) {
        dispatch({
          type: 'APPLY_SERVER_SESSION_SNAPSHOT',
          payload: { sessionId, snapshot: error.sessionSnapshot },
        })
      }
    }
    setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
    return { failed: true, error }
  } finally {
    turnActivityDispatcher.dispose()
    clearToolApprovalForOwner(owner)
    unregisterTurnRun({ sessionId, turnId, controller })
    if (abortCtrlRef.current === controller) abortCtrlRef.current = null
  }
}
