import { describeAttachmentPrompt } from '../../lib/attachments.js'
import { buildModelFailureRetryRequest } from './modelFailureRetry.js'
import { buildMessageReplayRequest } from './messageReplay.js'

export function useChatReplayActions({
  attachmentsRef,
  inputRef,
  isGenerating,
  lang,
  messageEdit,
  modelReadiness,
  setAttachments,
  setInput,
  setMessageEdit,
  setShowModelPicker,
  showModelUnavailable,
  stateRef,
  triggerSendFlow,
}) {
  const handleRetryModelFailure = (failedMessage) => {
    if (isGenerating) return false
    const current = stateRef.current
    const session = current.sessions.find((item) => item.id === current.activeSessionId)
    const request = buildModelFailureRetryRequest(session?.messages, failedMessage)
    if (!request) return false
    if (!modelReadiness.canSend) {
      showModelUnavailable(modelReadiness)
      return false
    }
    setShowModelPicker(false)
    triggerSendFlow(
      request.content || describeAttachmentPrompt(request.attachments, lang),
      request.attachments,
      request.historyLimit,
    )
    return true
  }

  const handleEditMessage = (anchorMessage) => {
    if (isGenerating) return false
    const current = stateRef.current
    const session = current.sessions.find((item) => item.id === current.activeSessionId)
    const request = buildMessageReplayRequest(session?.messages, anchorMessage)
    const latestUser = [...(session?.messages || [])].reverse().find((message) => message?.role === 'user')
    if (!request || !latestUser || request.sourceMessageId !== String(latestUser.id || '')) return false
    setMessageEdit({
      sessionId: session.id,
      sourceMessageId: request.sourceMessageId,
      historyLimit: request.historyLimit,
      previousInput: inputRef.current || '',
      previousAttachments: [...attachmentsRef.current],
    })
    setAttachments(request.attachments)
    window.dispatchEvent(new CustomEvent('command-palette:prefill', { detail: request.content }))
    return true
  }

  const handleCancelMessageEdit = () => {
    if (!messageEdit) return
    const previousInput = messageEdit.previousInput || ''
    setAttachments(messageEdit.previousAttachments || [])
    setInput(previousInput)
    setMessageEdit(null)
    if (previousInput) {
      window.dispatchEvent(new CustomEvent('command-palette:prefill', { detail: previousInput }))
    }
  }

  return {
    handleCancelMessageEdit,
    handleEditMessage,
    handleRetryModelFailure,
  }
}
