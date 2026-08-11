import {
  attachVisionDescriptions,
  hasVisionAssistConfigured,
  replaceUnsupportedVisionContent,
} from './visionAssist.js'

export async function prepareToolLoopVision({
  messages = [],
  candidates = [],
  requiresVision = false,
  supportsVision = () => false,
  userId = null,
  env = process.env,
  fetchImpl = fetch,
  modelName = '',
  onAssistError = null,
} = {}) {
  const preparedMessages = Array.isArray(messages) ? messages : []
  const preparedCandidates = Array.isArray(candidates) ? candidates : []
  if (!requiresVision) return { messages: preparedMessages, candidates: preparedCandidates }

  const visionCandidates = preparedCandidates.filter(supportsVision)
  if (visionCandidates.length > 0) {
    return { messages: preparedMessages, candidates: visionCandidates }
  }

  if (hasVisionAssistConfigured({ userId, env })) {
    try {
      const assisted = await attachVisionDescriptions({ messages: preparedMessages, userId, env, fetchImpl })
      return { messages: assisted.messages, candidates: preparedCandidates }
    } catch (error) {
      onAssistError?.(error)
    }
  }

  return {
    messages: replaceUnsupportedVisionContent({ messages: preparedMessages, modelName }).messages,
    candidates: preparedCandidates,
  }
}
