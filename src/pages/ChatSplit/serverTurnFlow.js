import { serializeAttachmentReferences } from '../../lib/attachmentClient.js'
import { buildLocalPathEvidenceInstruction, buildLocalPathToolInstruction, resolveLocalPathToolNames } from '../../lib/localPathPreflight.js'
import { createBufferedTurnActivityDispatcher, dispatchTurnEvent, runServerTurn } from '../../lib/turnClient.js'
import { createTurnFailureError } from '../../lib/turnClient/turnEventDispatch.js'
import { TASK_STATUS, HISTORY_STATUS } from '../../store/taskStatus.js'
import { artifactTypeForSkill, buildChatFailureMessage, getVisibleModelErrorMessage } from '../../lib/chatFlowGuards.js'
import { isServerTurnToolToggle } from '../../lib/serverToolConfig.js'
import { registerTurnRun, unregisterTurnRun } from './turnRunRegistry.js'

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
  modelName,
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
  toast,
  clearToolApprovalForOwner,
  toolsConfig,
  turnId,
  userPrompt,
}) {
  const controller = new AbortController()
  const owner = { sessionId, turnId }
  registerTurnRun({ sessionId, turnId, controller })
  abortCtrlRef.current = controller
  const startedAt = Date.now()
  const serverArtifacts = []
  let currentAssistantText = ''
  const initialArtifactType = artifactTypeForSkill(skillId)
  const { assistantId: assistantMessageId } = buildServerTurnMessageIds(turnId)
  const messageTarget = { sessionId, messageId: assistantMessageId }
  const dispatchMessage = (type, payload) => dispatch({ type, payload, ...messageTarget })
  const turnActivityDispatcher = createBufferedTurnActivityDispatcher({ dispatch, taskId, messageTarget })
  controller.signal.addEventListener('abort', () => {
    turnActivityDispatcher.flush()
    resolveToolApprovalForOwner(owner, { approved: false })
  }, { once: true })
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
        modelActivity: { kind: 'preparing' },
        serverTurnId: turnId,
        serverLastSequence: -1,
      },
    },
  })
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
    setContextSystemPrompts((current) => ({ ...current, [sessionId || '__draft__']: '' }))

    const { terminal, sessionSnapshot } = await runServerTurn({
      sessionId,
      content: serverContent,
      displayContent,
      attachments: attachmentReferences,
      modelName,
      turnId,
      history: historyMessages,
      agentId,
      skillIds: skillId ? [skillId] : [],
      intentMode,
      syncSessionSnapshot: true,
      toolsConfig: buildServerToolsConfig(toolsConfig, localPathAccess, historyMessages),
      signal: controller.signal,
      onStarted: (turn) => dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverTurnId: turn.turnId, serverLastSequence: -1 }),
      onConnectionState: ({ status, attempt, maxAttempts }) => {
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
      onActivity: turnActivityDispatcher.onActivity,
      onEvent: async (event) => {
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
      },
    })
    turnActivityDispatcher.flush()
    if (terminal.type === 'turn.failed') {
      const error = createTurnFailureError(terminal.payload)
      if (!currentAssistantText && error.partialText) {
        dispatchMessage('APPEND_TO_LAST_MESSAGE', error.partialText)
        currentAssistantText = error.partialText
      }
      throw error
    }
    if (terminal.type === 'turn.cancelled') {
      const error = new Error('Generation stopped')
      error.name = 'AbortError'
      throw error
    }
    if (terminal.type === 'turn.paused') {
      if (!currentAssistantText && terminal.payload?.text) {
        dispatchMessage('APPEND_TO_LAST_MESSAGE', terminal.payload.text)
        currentAssistantText = terminal.payload.text
      }
      dispatchMessage('UPDATE_LAST_MESSAGE_META', {
        type: 'model_reply',
        modelName: modelName || 'backend-default',
        latency: Date.now() - startedAt,
        streaming: false,
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
            stepLabel: terminal.payload?.clarification?.question || t('chat.serverTurn.resumeDetail'),
          },
        },
      })
      setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
      return { paused: true, clarification: terminal.payload?.clarification || null }
    }
    if (!currentAssistantText && terminal.payload?.text) dispatchMessage('APPEND_TO_LAST_MESSAGE', terminal.payload.text)
    dispatchMessage('UPDATE_LAST_MESSAGE_META', {
      type: 'model_reply',
      modelName: modelName || 'backend-default',
      latency: Date.now() - startedAt,
      streaming: false,
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
    if (isUserStopped(error)) {
      dispatchMessage('APPEND_TO_LAST_MESSAGE', `\n\n${t('chat.serverTurn.stoppedMarker')}`)
      dispatchMessage('UPDATE_LAST_MESSAGE_META', {
        streaming: false,
        serverArtifacts,
        serverDeliveryArtifactIds: [],
        serverConnectionState: null,
      })
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.CANCELLED, stepLabel: t('chat.serverTurn.cancelled') } } })
    } else {
      const message = getVisibleModelErrorMessage(error, t)
      dispatchMessage('APPEND_TO_LAST_MESSAGE', buildChatFailureMessage(message))
      dispatchMessage('UPDATE_LAST_MESSAGE_META', {
        streaming: false,
        failed: true,
        serverArtifacts,
        serverConnectionState: null,
        serverFailure: error.serverFailure || null,
        serverPartialText: error.partialText || '',
        serverArtifactIds: Array.isArray(error.artifactIds) ? error.artifactIds : [],
      })
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.FAILED, stepLabel: t('chat.serverTurn.failed') } } })
      toast.error({ title: t('toast.chatSendFailed'), body: message })
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
