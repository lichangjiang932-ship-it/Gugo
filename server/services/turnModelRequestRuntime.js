import { createTurnActivity } from '../../shared/turnEvents.js'
import { materializeManagedAttachmentMessages } from './turnMessageContext.js'
import {
  estimateContextTokens,
  getAutoCompactionThreshold,
} from './contextCompactionRuntime.js'

const ATTACHMENT_CONTEXT_HEADROOM_TOKENS = 64

export function createChatOnlyToolExecutionError() {
  return Object.assign(new Error('Chat-only model bindings cannot execute tools'), {
    code: 'CHAT_ONLY_TOOL_EXECUTION_FORBIDDEN',
    statusCode: 409,
    retryable: false,
    unsafeToReplay: true,
  })
}

function inlineMediaProjectionTokens(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    const marker = ';base64,'
    const markerIndex = value.indexOf(marker)
    if (markerIndex <= 5 || !value.startsWith('data:')) return 0
    const mimeType = value.slice(5, markerIndex).toLowerCase()
    if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') return 0
    // Base64 is four characters per three bytes. Keep raw media allocation
    // separate from visual token pricing so large payloads cannot bypass the
    // attachment budget merely because the provider prices images cheaply.
    return Math.ceil(Math.max(0, value.length - markerIndex - marker.length) / 4) + 64
  }
  if (!value || typeof value !== 'object') return 0
  if (seen.has(value)) return 0
  seen.add(value)
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + inlineMediaProjectionTokens(item, seen), 0)
  }
  return Object.values(value)
    .reduce((total, item) => total + inlineMediaProjectionTokens(item, seen), 0)
}

/**
 * Build the per-Turn model request boundary.
 *
 * Provider transport, attachment materialization, request budgeting, retry
 * events, and live tool-call activity are composed here through injected
 * capabilities. The Agent Loop receives only the returned runModel function.
 */
export function createTurnModelRequestRunner({
  runModel,
  prepareAttachments,
  publishActivity,
  emitEvent,
  userId,
  sessionId,
  turnId,
  modelName = null,
  modelProviderId = null,
  modelRuntimeEnv = null,
  modelMode = 'agent',
  env = process.env,
  contextWindow = null,
  firstRequestAttachmentIds = [],
  pendingRecoveryAttempt = null,
  onRecoveryAttempt = null,
  onPromptTokenEstimate = null,
  now = Date.now,
} = {}) {
  if (typeof runModel !== 'function') throw new TypeError('runModel is required')
  if (typeof prepareAttachments !== 'function') throw new TypeError('prepareAttachments is required')
  if (typeof publishActivity !== 'function') throw new TypeError('publishActivity is required')
  if (typeof emitEvent !== 'function') throw new TypeError('emitEvent is required')
  if (typeof now !== 'function') throw new TypeError('now must be a function')

  const chatOnlyMode = modelMode === 'chat_only'
  const initialAttachmentIds = [...new Set((Array.isArray(firstRequestAttachmentIds)
    ? firstRequestAttachmentIds
    : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
  let shouldInlineManagedAttachments = initialAttachmentIds.length > 0
  let recoveryAttempt = pendingRecoveryAttempt

  return async function runTurnModelRequest(request) {
    const modelRequest = chatOnlyMode
      ? { ...request, tools: [], toolChoice: 'none' }
      : request
    if (recoveryAttempt) {
      const attempt = recoveryAttempt
      recoveryAttempt = null
      onRecoveryAttempt?.(attempt)
      await emitEvent('turn.attempt', attempt)
    }

    const inlineAttachmentIds = shouldInlineManagedAttachments ? initialAttachmentIds : []
    shouldInlineManagedAttachments = false
    const materializationOptions = { userId, sessionId }
    let providerMessages
    if (inlineAttachmentIds.length > 0) {
      const referenceMessages = await materializeManagedAttachmentMessages(modelRequest.messages, {
        ...materializationOptions,
        prepareAttachments,
        inlineAttachmentIds: [],
      })
      const threshold = getAutoCompactionThreshold(
        contextWindow,
        env?.MODEL_ACTIVE_CONTEXT_TOKENS,
      )
      const referenceTokens = estimateContextTokens(referenceMessages, modelRequest.tools)
      const maxAttachmentTokens = Math.max(
        0,
        threshold - referenceTokens - ATTACHMENT_CONTEXT_HEADROOM_TOKENS,
      )
      providerMessages = maxAttachmentTokens > 0
        ? await materializeManagedAttachmentMessages(modelRequest.messages, {
            ...materializationOptions,
            prepareAttachments: (attachmentRequest) => prepareAttachments({
              ...attachmentRequest,
              maxAttachmentTokens,
            }),
            inlineAttachmentIds,
          })
        : referenceMessages

      if (
        inlineMediaProjectionTokens(providerMessages) > maxAttachmentTokens
        || estimateContextTokens(providerMessages, modelRequest.tools) >= threshold
      ) {
        providerMessages = referenceMessages
      }
      const finalTokens = estimateContextTokens(providerMessages, modelRequest.tools)
      if (finalTokens >= threshold) {
        throw Object.assign(
          new Error(
            `附件展开后的请求仍超出上下文预算（估算 ${finalTokens} token，阈值 ${threshold} token）。`,
          ),
          {
            code: 'ATTACHMENT_CONTEXT_BUDGET_EXCEEDED',
            status: 413,
            retryable: false,
          },
        )
      }
    } else {
      providerMessages = await materializeManagedAttachmentMessages(modelRequest.messages, {
        ...materializationOptions,
        prepareAttachments,
        inlineAttachmentIds,
      })
    }

    onPromptTokenEstimate?.(estimateContextTokens(providerMessages, modelRequest.tools))
    const inheritedToolCallReady = modelRequest.onToolCallReady
    return runModel({
      ...modelRequest,
      messages: providerMessages,
      userId: modelRuntimeEnv ? null : userId,
      usageOwnerId: userId,
      modelName: modelName || undefined,
      modelProviderId: modelRuntimeEnv ? undefined : (modelProviderId || undefined),
      env: modelRuntimeEnv || env,
      onToolCallReady: async (call, metadata = {}) => {
        if (chatOnlyMode) throw createChatOnlyToolExecutionError()
        if (typeof inheritedToolCallReady === 'function') {
          await inheritedToolCallReady(call, metadata)
        }
        const toolName = String(call?.function?.name || call?.name || '').trim()
        if (!toolName) return
        await publishActivity({
          userId,
          activity: createTurnActivity({
            sessionId,
            turnId,
            kind: 'tool_call_ready',
            toolName,
            modelName: metadata.modelName || null,
            createdAt: now(),
          }),
        })
      },
      onFailover: async (payload) => emitEvent('model.failover', payload),
      onRetry: async (payload) => emitEvent('model.failover', payload),
    })
  }
}
