import { describeAttachmentPrompt } from '../../lib/attachments.js'
import { isLoggedInLocally } from '../../lib/accountClient.js'
import { parseSlashCommandInput } from '../../lib/slashCommandRegistry.js'
import { attachmentSendState } from '../../lib/chatAttachmentUpload.js'
import { applyAcceptedChatDraft } from './chatAcceptedDraft.js'
import { isChatCompositionEvent, shouldSubmitChatKey } from './chatComposerKeyGuard.js'

export function useChatSendActions({
  attachments,
  attachmentsRef,
  directoryApprovalOpen,
  dispatch,
  executeSlashEntry,
  input,
  inputRef,
  isGenerating,
  lang,
  modelReadiness,
  navigateInputHistory,
  setAttachments,
  setInput,
  setWorkbenchMessage,
  showAuthenticationRequired,
  showModelUnavailable,
  showPendingDirectoryGuidance,
  slashRegistry,
  state,
  stateRef,
  steerActiveTurn,
  t,
  toast = null,
  triggerSendFlow,
}) {
  const handleWorkbenchSend = async (content) => {
    if (!isLoggedInLocally()) {
      showAuthenticationRequired()
      return false
    }
    if (!modelReadiness.canSend) {
      showModelUnavailable(modelReadiness)
      return false
    }
    return triggerSendFlow(content)
  }

  const handleSend = async () => {
    const typedContent = input.trim()
    if (!typedContent && attachments.length === 0) return
    if (!isLoggedInLocally()) {
      showAuthenticationRequired()
      return
    }
    if (showPendingDirectoryGuidance(typedContent)) return
    if (isGenerating) {
      if (!typedContent) {
        setWorkbenchMessage(t('chatSteering.textOnly'))
        toast?.info?.(t('chatSteering.textOnly'))
        return
      }
      await steerActiveTurn(typedContent)
      return
    }
    if (directoryApprovalOpen) {
      setWorkbenchMessage(t('chatSteering.directoryAuthorizationRequired'))
      toast?.info?.(t('chatSteering.directoryAuthorizationRequired'))
      return
    }
    const attachmentState = attachmentSendState(attachments)
    if (attachmentState.uploading) {
      setWorkbenchMessage(t('chatAttachments.waitingForUploads'))
      toast?.info?.(t('chatAttachments.waitingForUploads'))
      return
    }
    if (attachmentState.failed) {
      setWorkbenchMessage(t('chatAttachments.removeFailed'))
      toast?.info?.(t('chatAttachments.removeFailed'))
      return
    }
    const parsedSlash = parseSlashCommandInput(typedContent)
    const slashEntry = parsedSlash ? slashRegistry.getCommand(parsedSlash.name) : null
    if (slashEntry && slashEntry.kind !== 'skill') {
      if (slashEntry.requiresModel && !modelReadiness.canSend) {
        showModelUnavailable(modelReadiness)
        return
      }
      setInput('')
      executeSlashEntry(slashEntry, parsedSlash.args)
      return
    }
    if (!modelReadiness.canSend) {
      showModelUnavailable(modelReadiness)
      return
    }
    const inputSnapshot = input
    const currentAttachments = [...attachments]
    const draftSessionId = state.activeSessionId
    await triggerSendFlow(
      typedContent || describeAttachmentPrompt(currentAttachments, lang),
      currentAttachments,
      null,
      ({ sessionId: acceptedSessionId } = {}) => {
        applyAcceptedChatDraft({
          acceptedSessionId,
          activeSessionId: stateRef.current.activeSessionId,
          attachments: attachmentsRef.current,
          dispatch,
          draftSessionId,
          input: inputRef.current,
          inputSnapshot,
          sentAttachments: currentAttachments,
          setAttachments,
          setInput,
        })
      },
    )
  }

  const handleKeyDown = (event) => {
    if (isChatCompositionEvent(event)) return
    if (navigateInputHistory(event)) return
    if (shouldSubmitChatKey(event)) {
      event.preventDefault()
      handleSend()
    }
  }

  return { handleKeyDown, handleSend, handleWorkbenchSend }
}
