import { buildUserContentWithAttachments } from '../../lib/attachments.js'
import { buildLocalPathEvidenceInstruction, buildLocalPathToolInstruction, resolveLocalPathToolNames } from '../../lib/localPathPreflight.js'
import { dispatchTurnEvent, runServerTurn } from '../../lib/turnClient.js'
import { TASK_STATUS, HISTORY_STATUS } from '../../store/taskStatus.js'
import { artifactTypeForSkill, buildChatFailureMessage, getVisibleModelErrorMessage } from '../../lib/chatFlowGuards.js'
import { isServerTurnToolToggle } from '../../lib/serverToolConfig.js'
import { registerTurnRun, unregisterTurnRun } from './turnRunRegistry.js'

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

export function buildServerToolsConfig(toolsConfig = {}, localPathAccess = {}) {
  const enabled = new Set()
  const disabled = new Set()
  for (const [rawName, value] of Object.entries(toolsConfig || {})) {
    const name = String(rawName || '').trim()
    if (!isServerTurnToolToggle(name)) continue
    if (value === true) enabled.add(name)
    else if (value === false) disabled.add(name)
  }
  const effectiveEnabled = resolveLocalPathToolNames(enabled, localPathAccess)
  for (const name of effectiveEnabled) {
    enabled.add(name)
    disabled.delete(name)
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
  controller.signal.addEventListener('abort', () => {
    resolveToolApprovalForOwner(owner, { approved: false })
  }, { once: true })
  registerTurnRun({ sessionId, turnId, controller })
  abortCtrlRef.current = controller
  const startedAt = Date.now()
  const serverArtifacts = []
  let sawAssistantText = false
  const initialArtifactType = artifactTypeForSkill(skillId)
  const { assistantId: assistantMessageId } = buildServerTurnMessageIds(turnId)
  const messageTarget = { sessionId, messageId: assistantMessageId }
  const dispatchMessage = (type, payload) => dispatch({ type, payload, ...messageTarget })
  dispatch({
    type: 'ADD_TASK',
    payload: { id: taskId, name: taskName, detail: content, status: TASK_STATUS.RUNNING, step: 1, stepLabel: t('chat.serverTurn.submit'), perms: skill?.perms || [] },
  })
  dispatch({
    type: 'RECEIVE_MESSAGE',
    payload: { id: assistantMessageId, sessionId, content: '', meta: { skillId, artifactType: initialArtifactType, artifactTitle: initialArtifactType ? taskName : undefined, streaming: true } },
  })
  try {
    const localPathInstruction = buildLocalPathToolInstruction(localPathAccess.paths, localPathAccess.accessMode)
    const localPathEvidence = await collectLocalPathEvidence({
      localPathAccess,
      probeLocalPathAccess,
      signal: controller.signal,
    })
    const localPathEvidenceInstruction = buildLocalPathEvidenceInstruction(localPathEvidence)
    const serverContent = [
      localPathInstruction,
      localPathEvidenceInstruction,
      serializeServerTurnContent(buildUserContentWithAttachments(userPrompt || content, explicitAttachments || attachments), t),
    ].filter(Boolean).join('\n\n')
    setContextSystemPrompts((current) => ({ ...current, [sessionId || '__draft__']: '' }))

    const { terminal, sessionSnapshot } = await runServerTurn({
      sessionId,
      content: serverContent,
      displayContent,
      modelName,
      turnId,
      history: historyMessages,
      agentId,
      skillIds: skillId ? [skillId] : [],
      syncSessionSnapshot: true,
      toolsConfig: buildServerToolsConfig(toolsConfig, localPathAccess),
      signal: controller.signal,
      onStarted: (turn) => dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverTurnId: turn.turnId, serverLastSequence: -1 }),
      onConnectionState: ({ status, attempt, maxAttempts }) => {
        if (status === 'reconnecting') {
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: t('chat.serverTurn.reconnecting', { attempt, max: maxAttempts }) } } })
        } else if (status === 'connected') {
          dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { stepLabel: t('chat.serverTurn.reconnected') } } })
        }
      },
      onEvent: async (event) => {
        if (event.type === 'assistant.delta' && event.payload?.text) sawAssistantText = true
        await dispatchTurnEvent(event, {
          dispatch,
          taskId,
          messageTarget,
          onApproval: (request) => requestServerToolApproval(request, owner),
          onArtifact: (artifact) => appendArtifact(artifact, serverArtifacts, dispatchMessage),
        })
        dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverLastSequence: event.sequence })
      },
    })
    if (terminal.type === 'turn.failed') {
      const error = new Error(terminal.payload?.message || 'Server turn failed')
      error.code = terminal.payload?.code || 'TURN_FAILED'
      throw error
    }
    if (terminal.type === 'turn.cancelled') {
      const error = new Error('Generation stopped')
      error.name = 'AbortError'
      throw error
    }
    if (!sawAssistantText && terminal.payload?.text) dispatchMessage('APPEND_TO_LAST_MESSAGE', terminal.payload.text)
    dispatchMessage('UPDATE_LAST_MESSAGE_META', { type: 'model_reply', modelName: modelName || 'backend-default', latency: Date.now() - startedAt, streaming: false, serverArtifacts })
    if (sessionSnapshot) {
      dispatch({ type: 'APPLY_SERVER_SESSION_SNAPSHOT', payload: { sessionId, snapshot: sessionSnapshot } })
    }
    dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.COMPLETED, stepLabel: t('chat.serverTurn.completed') } } })
    setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
    dispatch({ type: 'ADD_HISTORY', payload: { name: taskName, skill: skill?.name || t('chat.serverTurn.generalChat'), status: HISTORY_STATUS.SUCCESS, detail: content.slice(0, 60), state: t('chat.serverTurn.completed'), date: Date.now() } })
  } catch (error) {
    if (isUserStopped(error)) {
      dispatchMessage('APPEND_TO_LAST_MESSAGE', `\n\n${t('chat.serverTurn.stoppedMarker')}`)
      dispatchMessage('UPDATE_LAST_MESSAGE_META', { streaming: false, serverArtifacts })
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.CANCELLED, stepLabel: t('chat.serverTurn.cancelled') } } })
    } else {
      const message = getVisibleModelErrorMessage(error, t)
      dispatchMessage('APPEND_TO_LAST_MESSAGE', buildChatFailureMessage(message))
      dispatchMessage('UPDATE_LAST_MESSAGE_META', { streaming: false, failed: true, serverArtifacts })
      dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, updates: { status: TASK_STATUS.FAILED, stepLabel: t('chat.serverTurn.failed') } } })
      toast.error({ title: t('toast.chatSendFailed'), body: message })
    }
    setTimeout(() => dispatch({ type: 'REMOVE_TASK', payload: taskId }), 5000)
  } finally {
    clearToolApprovalForOwner(owner)
    unregisterTurnRun({ sessionId, turnId, controller })
    if (abortCtrlRef.current === controller) abortCtrlRef.current = null
  }
}
