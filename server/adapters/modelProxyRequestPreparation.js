import { getPublicAccount } from './authAccount.js'
import { getSessionByToken } from '../db.js'
import {
  selectActiveMemoriesForInjection,
  buildMemorySystemBlock,
  touchMemoryUsage,
} from '../services/memoryStore.js'
import { dispatchHooks } from '../services/hooksService.js'
import { ensureDefaultAgent, getAgent } from '../services/agentStore.js'
import {
  buildIdentityBlock,
  buildIshikiBlock,
  buildSafetyBlock,
  buildSkillsBlock,
  buildSessionsBlock,
} from '../services/promptCompiler.js'
import {
  attachVisionDescriptions,
  hasVisionAssistConfigured,
  replaceUnsupportedVisionContent,
} from './visionAssist.js'
import { logWarn } from '../utils/logger.js'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'
import { profileForConfig } from './modelEndpoint.js'

function authToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

function frozenPreparation(value) {
  return Object.freeze({
    ...value,
    injectedMemoryIds: Object.freeze([...(value.injectedMemoryIds || [])]),
    compilerFingerprints: Object.freeze({ ...(value.compilerFingerprints || {}) }),
    requestCandidates: Object.freeze([...(value.requestCandidates || [])]),
  })
}

/**
 * Prepare one legacy HTTP model request without owning its transport or leases.
 *
 * The caller retains the compaction archive lease and response lifecycle. This
 * boundary owns only the ordered message preparation contract: vision fallback,
 * prompt Hook replacement, prompt compilation, memory injection, and candidate
 * filtering. The returned DTO is frozen so later transport code cannot replace
 * preparation fields accidentally.
 */
export async function prepareModelProxyRequest({
  req,
  res,
  body,
  testMode,
  runtimeEnv,
  selectedModel,
  requestConfig,
  requestProfile,
  resolvedCandidates,
  compactionArchivePort,
  hookRequestId,
  messages,
  hasVisionContent,
}) {
  let preparedMessages = messages
  const hasVisionCandidate = resolvedCandidates.some((candidate) => (
    profileForConfig(candidate, runtimeEnv).supportsVision
  ))
  if (
    !testMode
    && hasVisionContent(preparedMessages)
    && !requestProfile.supportsVision
    && !hasVisionCandidate
  ) {
    const token = authToken(req)
    const sessionForAssist = token ? getSessionByToken(token) : null
    const userIdForAssist = sessionForAssist?.user_id || null
    if (hasVisionAssistConfigured({ userId: userIdForAssist, env: runtimeEnv })) {
      try {
        const assistResult = await attachVisionDescriptions({
          messages: preparedMessages,
          userId: userIdForAssist,
          env: runtimeEnv,
        })
        preparedMessages = assistResult.messages
        res.setHeader('X-Vision-Assist-Count', String(assistResult.assistCount))
        if (assistResult.failures.length) {
          res.setHeader('X-Vision-Assist-Failures', String(assistResult.failures.length))
        }
      } catch (assistError) {
        logWarn('vision.assist', assistError, { userId: userIdForAssist, modelName: selectedModel })
        const fallback = replaceUnsupportedVisionContent({
          messages: preparedMessages,
          modelName: selectedModel,
        })
        preparedMessages = fallback.messages
        res.setHeader('X-Vision-Fallback-Count', String(fallback.replacementCount))
        res.setHeader('X-Vision-Fallback-Reason', 'assist_failed')
      }
    } else {
      const fallback = replaceUnsupportedVisionContent({
        messages: preparedMessages,
        modelName: selectedModel,
      })
      preparedMessages = fallback.messages
      res.setHeader('X-Vision-Fallback-Count', String(fallback.replacementCount))
      res.setHeader('X-Vision-Fallback-Reason', 'assist_unavailable')
    }
  }

  const token = authToken(req)
  let session
  let autoMemorySourceMessages = []
  let injectedMemoryIds = []
  let injectedAgentId = null
  let promptSystemBlockCount = 0
  const compilerFingerprints = {
    identity: 'empty',
    ishiki: 'empty',
    skills: 'empty',
    sessions: 'empty',
  }

  if (testMode) {
    session = token ? getSessionByToken(token) : null
  } else {
    getPublicAccount({ token })
    session = token ? getSessionByToken(token) : null
    if (session?.user_id) {
      const promptHook = await dispatchHooks({
        userId: session.user_id,
        event: 'user_prompt_submit',
        tool: 'chat',
        args: { messages: preparedMessages },
        sessionId: body.sessionId || null,
        requestId: hookRequestId,
        hookInvocationId: `${hookRequestId}:user_prompt_submit`,
      })
      if (!promptHook.allow) {
        const error = new Error(promptHook.reason || 'hook rejected prompt')
        error.statusCode = 403
        error.code = 'PROMPT_HOOK_REJECTED'
        throw error
      }
      if (Array.isArray(promptHook.replacementArgs?.messages)) {
        preparedMessages = promptHook.replacementArgs.messages
      }
    }
    autoMemorySourceMessages = Array.isArray(preparedMessages)
      ? preparedMessages.map((message) => ({ ...message }))
      : []
  }

  if (session?.user_id) {
    const compiledSystemMessages = []
    const safety = buildSafetyBlock()
    compiledSystemMessages.push({ role: 'system', content: safety.text })
    try {
      if (getRuntimeEnv().AGENT_INJECT_ENABLED !== '0') {
        let agent = null
        const requestedAgentId = typeof body.agentId === 'string' ? body.agentId : null
        if (requestedAgentId) {
          const found = getAgent({ userId: session.user_id, id: requestedAgentId })
          if (found) agent = found
        }
        if (!agent) agent = ensureDefaultAgent({ userId: session.user_id })
        const identity = buildIdentityBlock({ agent })
        const ishiki = buildIshikiBlock({ agent })
        compilerFingerprints.identity = identity.fingerprint
        compilerFingerprints.ishiki = ishiki.fingerprint
        if (identity.text) compiledSystemMessages.push({ role: 'system', content: identity.text })
        if (ishiki.text) compiledSystemMessages.push({ role: 'system', content: ishiki.text })
        if (identity.text || ishiki.text) injectedAgentId = agent.id
      }
    } catch (error) {
      logWarn('agent.inject', error, { userId: session?.user_id })
    }

    try {
      const skills = buildSkillsBlock({
        userId: session.user_id,
        agentId: injectedAgentId,
        skillIds: Array.isArray(body.skillIds) ? body.skillIds : [],
      })
      compilerFingerprints.skills = skills.fingerprint
      if (skills.text) compiledSystemMessages.push({ role: 'system', content: skills.text })
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[skills] prompt compile failed:', error?.message || error)
      }
    }

    try {
      const sessions = await buildSessionsBlock({
        userId: session.user_id,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
        recentMessages: Array.isArray(body.recentMessages) ? body.recentMessages : [],
        compactionArchivePort,
      })
      compilerFingerprints.sessions = sessions.fingerprint
      if (sessions.text) compiledSystemMessages.push({ role: 'system', content: sessions.text })
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[sessions] prompt compile failed:', error?.message || error)
      }
    }

    if (compiledSystemMessages.length) {
      preparedMessages = [...compiledSystemMessages, ...preparedMessages]
      promptSystemBlockCount = compiledSystemMessages.length
    }
  }

  if (!testMode) {
    try {
      if (session?.user_id) {
        const cap = Number(getRuntimeEnv().MEMORY_INJECT_TOKEN_CAP || 800)
        const picked = selectActiveMemoriesForInjection({
          userId: session.user_id,
          tokenCap: cap,
          agentId: injectedAgentId,
        })
        if (picked.memories.length) {
          const block = buildMemorySystemBlock(picked.memories)
          const insertAt = promptSystemBlockCount || (injectedAgentId ? 1 : 0)
          preparedMessages.splice(insertAt, 0, { role: 'system', content: block })
          injectedMemoryIds = picked.memories.map((memory) => memory.id)
          touchMemoryUsage(session.user_id, injectedMemoryIds)
        }
      }
    } catch (error) {
      logWarn('memory.inject', error, { userId: session?.user_id })
    }
  }

  const requiresVision = hasVisionContent(preparedMessages)
  const requestCandidates = resolvedCandidates.filter((candidate) => (
    !requiresVision || profileForConfig(candidate, runtimeEnv).supportsVision
  ))
  if (!requestCandidates.length) requestCandidates.push(requestConfig)

  const boost = Number(body.maxTokensBoost)
  if (Number.isFinite(boost) && boost > 0) {
    for (const candidate of requestCandidates) {
      const current = Number(candidate.maxTokens) || 0
      if (current > 0) {
        candidate.maxTokens = Math.max(current, Math.min(Math.floor(boost), 32_000))
      }
    }
  }

  return frozenPreparation({
    messages: preparedMessages,
    autoMemorySourceMessages,
    session,
    injectedMemoryIds,
    injectedAgentId,
    compilerFingerprints,
    requestCandidates,
  })
}
