import { describeAttachmentPrompt } from '../../lib/attachments.js'
import { buildModelFailureRetryRequest } from './modelFailureRetry.js'

export function useChatReplayActions({
  isGenerating,
  lang,
  modelReadiness,
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

  return { handleRetryModelFailure }
}
