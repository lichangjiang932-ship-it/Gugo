import { dispatchHooks } from '../services/hooksService.js'
import { scheduleAutoMemoryExtraction } from '../services/autoMemoryService.js'
import { withRetry } from '../utils/modelRetry.js'
import { profileForConfig } from './modelEndpoint.js'
import { runWithProviderFailover, streamWithProviderFailover } from './modelFailover.js'
import { parseModelProviderResponse } from './modelProviderResponse.js'
import { formatProxyError, withRedactedModelErrors } from './modelProxyErrors.js'
import { buildModelProviderRequest } from './modelRequestBuilder.js'
import { fetchWithTimeout } from './modelRequestTransport.js'
import { streamModelProviderEvents } from './modelStreamingTransport.js'
import { recordUsage } from './modelUsage.js'
import { fetchWithEnvProxy } from './proxyFetch.js'
import { bindSseClientDisconnect, createEmptyModelResponseError } from './sseLifecycle.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

export async function* streamOpenAICompatible(args = {}) {
  yield* streamModelProviderEvents({
    ...args,
    buildRequest: buildModelProviderRequest,
  })
}

export function shouldScheduleStreamAutoMemory({
  streamCompleted = false,
  clientGone = false,
  streamHadToolCalls = false,
  assistantText = '',
  userId = '',
  sessionId = '',
} = {}) {
  return streamCompleted === true
    && clientGone !== true
    && streamHadToolCalls !== true
    && Boolean(String(assistantText || '').trim())
    && Boolean(String(userId || '').trim())
    && Boolean(String(sessionId || '').trim())
}

function dispatchStopHook({ session, body, hookRequestId, started, stream }) {
  if (!session?.user_id) return
  dispatchHooks({
    userId: session.user_id,
    event: 'stop',
    tool: 'chat',
    args: { latency: Date.now() - started, stream },
    sessionId: body.sessionId || null,
    requestId: hookRequestId,
    hookInvocationId: `${hookRequestId}:stop`,
  }).catch((error) => {
    console.warn(`[hooks] stop hook 失败 (${stream ? 'stream' : 'non-stream'}):`, error?.message || error)
  })
}

function scheduleBoundAutoMemory({
  createBackgroundModelCaller,
  runtimeEnv,
  modelName,
  providerId,
  requestUserId,
  session,
  sessionId,
  injectedAgentId,
  autoMemorySourceMessages,
  assistantText,
}) {
  const callMemoryModel = createBackgroundModelCaller({
    env: runtimeEnv,
    modelName,
    providerId,
    usageOwnerId: requestUserId,
  })
  scheduleAutoMemoryExtraction({
    userId: session.user_id,
    sessionId,
    agentId: injectedAgentId,
    messages: autoMemorySourceMessages,
    assistantText,
    callModel: callMemoryModel,
  })
}

export async function handleStreamingModelProxyResponse({
  req,
  res,
  body,
  requestUserId,
  runtimeEnv,
  selectedModel,
  requestCandidates,
  messages,
  session,
  hookRequestId,
  injectedMemoryIds,
  injectedAgentId,
  autoMemorySourceMessages,
  createBackgroundModelCaller,
}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const sseAbort = new AbortController()
  let clientGone = false
  const disposeDisconnectListener = bindSseClientDisconnect(req, res, () => {
    clientGone = true
    sseAbort.abort()
  })
  const safeWrite = (payload) => {
    if (clientGone || res.writableEnded || res.destroyed) return false
    return res.write(payload)
  }
  const heartbeat = setInterval(() => {
    safeWrite(': keepalive\n\n')
  }, 15_000)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()
  safeWrite(`data: ${JSON.stringify({ ok: true, phase: 'connecting' })}\n\n`)

  const started = Date.now()
  let streamUsage = null
  let activeStreamModel = selectedModel
  let activeStreamProviderId = ''
  let activeProviderResolved = false
  let streamCompleted = false
  let assistantText = ''
  let streamHadToolCalls = false
  let streamFinishReason = null
  let firstByteAt = 0
  try {
    for await (const { event, config: activeConfig } of streamWithProviderFailover(
      requestCandidates,
      (candidate) => streamOpenAICompatible({
        config: candidate,
        messages,
        tools: body.tools,
        toolChoice: body.tool_choice,
        externalSignal: sseAbort.signal,
        env: runtimeEnv,
        onFirstByte: () => {
          if (firstByteAt) return
          firstByteAt = Date.now()
          safeWrite(`data: ${JSON.stringify({
            ok: true,
            phase: 'streaming',
            firstTokenLatency: firstByteAt - started,
          })}\n\n`)
        },
      }),
      { signal: sseAbort.signal },
    )) {
      if (clientGone) break
      if (!activeProviderResolved) {
        activeStreamModel = activeConfig.modelName
        activeStreamProviderId = String(activeConfig.providerId || '').trim()
        activeProviderResolved = true
      }
      if (event.type === 'text') {
        assistantText = `${assistantText}${event.delta || ''}`.slice(0, 24_000)
        safeWrite(`data: ${JSON.stringify({ ok: true, delta: event.delta, latency: Date.now() - started })}\n\n`)
      } else if (event.type === 'reasoning') {
        safeWrite(`data: ${JSON.stringify({ ok: true, reasoning: event.delta, latency: Date.now() - started })}\n\n`)
      } else if (event.type === 'tool_calls') {
        streamHadToolCalls = true
        if (event.usage && !streamUsage) {
          streamUsage = event.usage
          recordUsage(activeStreamModel, event.usage, { ownerId: requestUserId })
        }
        safeWrite(`data: ${JSON.stringify({ ok: true, toolCalls: event.toolCalls, finishReason: event.finishReason, latency: Date.now() - started })}\n\n`)
      } else if (event.type === 'tool_call_ready') {
        safeWrite(`data: ${JSON.stringify({ ok: true, toolCallReady: event.toolCall, toolCallIndex: event.index, latency: Date.now() - started })}\n\n`)
      } else if (event.type === 'finish') {
        streamFinishReason = event.finishReason || null
        if (event.usage && !streamUsage) {
          streamUsage = event.usage
          recordUsage(activeStreamModel, event.usage, { ownerId: requestUserId })
        }
      } else if (event.type === 'usage') {
        streamUsage = event.usage
        recordUsage(activeStreamModel, event.usage, { ownerId: requestUserId })
      }
    }
    if (!clientGone && !assistantText.trim() && !streamHadToolCalls) {
      throw createEmptyModelResponseError(streamFinishReason)
    }
    if (!clientGone) {
      dispatchStopHook({ session, body, hookRequestId, started, stream: true })
      safeWrite(`data: ${JSON.stringify({
        ok: true,
        done: true,
        latency: Date.now() - started,
        injectedMemoryIds,
        usage: streamUsage,
        finishReason: streamFinishReason,
      })}\n\n`)
      streamCompleted = true
    }
  } catch (error) {
    if (!clientGone && error?.name !== 'AbortError') {
      safeWrite(`data: ${JSON.stringify({
        ok: false,
        error: formatProxyError(error),
        code: error?.code || null,
        timeoutPhase: error?.timeoutPhase || null,
        partial: assistantText ? true : false,
      })}\n\n`)
    }
  } finally {
    clearInterval(heartbeat)
    disposeDisconnectListener()
  }
  if (!res.writableEnded) res.end()

  const autoMemorySessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (shouldScheduleStreamAutoMemory({
    streamCompleted,
    clientGone,
    streamHadToolCalls,
    assistantText,
    userId: session?.user_id,
    sessionId: autoMemorySessionId,
  })) {
    scheduleBoundAutoMemory({
      createBackgroundModelCaller,
      runtimeEnv,
      modelName: activeStreamModel,
      providerId: activeStreamProviderId,
      requestUserId,
      session,
      sessionId: autoMemorySessionId,
      injectedAgentId,
      autoMemorySourceMessages,
      assistantText,
    })
  }
}

export async function handleNonStreamingModelProxyResponse({
  res,
  body,
  testMode,
  requestUserId,
  runtimeEnv,
  requestCandidates,
  messages,
  session,
  hookRequestId,
  injectedMemoryIds,
  injectedAgentId,
  autoMemorySourceMessages,
  compilerFingerprints,
  createBackgroundModelCaller,
}) {
  const started = Date.now()
  const completion = await runWithProviderFailover(requestCandidates, async (candidate) => {
    const candidateProfile = profileForConfig(candidate, runtimeEnv)
    const providerRequest = buildModelProviderRequest({
      config: candidate,
      messages,
      env: runtimeEnv,
      profile: candidateProfile,
    })
    const { url, init } = providerRequest
    const data = await withRedactedModelErrors(candidate, () => withRetry(async () => {
      const response = await fetchWithTimeout(fetchWithEnvProxy, url, init, {
        timeoutMs: candidateProfile.timeouts.requestMs,
        externalSignal: null,
        phase: 'request',
        config: candidate,
      })
      const text = await response.text()
      let parsed
      try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
      if (!response.ok) {
        const message = parsed?.error?.message || parsed?.message || text.slice(0, 240) || response.statusText
        const error = new Error(message)
        error.status = response.status
        error.fromUpstream = true
        error.retryAfter = response.headers?.get?.('retry-after') ?? null
        throw error
      }
      return parsed
    }))
    const parsed = parseModelProviderResponse(data, candidateProfile, { providerRequest })
    recordUsage(candidate.modelName, parsed.usage, { ownerId: requestUserId })
    if (!parsed.content) throw new Error('模型返回为空，请检查模型名称或端点响应格式。')
    return {
      reply: parsed.content,
      modelName: candidate.modelName,
      providerId: candidate.providerId,
    }
  })

  const reply = completion.reply
  if (!testMode) dispatchStopHook({ session, body, hookRequestId, started, stream: false })
  sendJson(res, 200, {
    ok: true,
    reply,
    latency: Date.now() - started,
    injectedMemoryIds,
    ...(testMode ? { compilerFingerprints } : {}),
  })

  const autoMemorySessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!testMode && session?.user_id && reply && autoMemorySessionId) {
    scheduleBoundAutoMemory({
      createBackgroundModelCaller,
      runtimeEnv,
      modelName: completion.modelName,
      providerId: completion.providerId,
      requestUserId,
      session,
      sessionId: autoMemorySessionId,
      injectedAgentId,
      autoMemorySourceMessages,
      assistantText: reply,
    })
  }
}
