import { isModelPreExecutionFailure } from '../../lib/chatFlowGuards.js'
import { buildMessageReplayRequest } from './messageReplay.js'

export function buildModelFailureRetryRequest(messages, failedMessage) {
  if (!isModelPreExecutionFailure(failedMessage)) return null
  const request = buildMessageReplayRequest(messages, failedMessage)
  if (!request) return null
  return {
    content: request.content,
    attachments: request.attachments,
    historyLimit: request.historyLimit,
  }
}
