import { findExactMemory, upsertMemory, withMemoryMatchTransaction } from './memoryStore.js'
import { logWarn } from '../utils/logger.js'

const ALLOWED_TYPES = new Set(['user', 'feedback', 'project', 'reference'])
const MAX_MEMORIES_PER_TURN = 3
const MIN_CONFIDENCE = 0.78
const RUNTIME_CAPABILITY_SUBJECT = /(?:workspace[_\s-]*fs(?:[_\s-]*enabled)?|local\s+(?:file(?:system)?|path)|file(?:system)?\s+(?:access|permission)|list_directory|read_file|tool\s+(?:access|availability|permission)|permission|authori[sz](?:e|ed|ation)|grant|runtime|environment\s+variable|env(?:ironment)?\s+setting|\u672c\u5730\u6587\u4ef6(?:\u7cfb\u7edf)?|\u6587\u4ef6\u7cfb\u7edf|\u5de5\u5177|\u6743\u9650|\u6388\u6743|\u8fd0\u884c\u65f6|\u73af\u5883\u53d8\u91cf)/iu
const RUNTIME_CAPABILITY_STATE = /(?:unavailable|available|disabled|enabled|not\s+enabled|cannot|can't|failed|failure|timeout|timed\s+out|denied|allowed|read[-\s]*only|read\s+and\s+write|must\s+(?:paste|provide)|\u4e0d\u53ef\u7528|\u53ef\u7528|\u672a\u542f\u7528|\u5df2\u542f\u7528|\u7981\u7528|\u65e0\u6cd5|\u4e0d\u80fd|\u5931\u8d25|\u8d85\u65f6|\u62d2\u7edd|\u5141\u8bb8|\u5df2\u6388\u6743|\u53ea\u8bfb|\u8bfb\u5199|\u7c98\u8d34|\u63d0\u4f9b\u6587\u672c)/iu
const SIMPLE_GREETING = /^(?:hi|hello|hey|你好|您好|嗨|谢谢|多谢|ok|okay)[.!！。?？\s]*$/iu
const SENSITIVE_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{12,}|\bsk-[A-Za-z0-9_-]{12,}|\b(?:ghp_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|glpat-[A-Za-z0-9_-]{20,255}|xox[baprs]-[A-Za-z0-9-]{12,255})\b|(?:api[_ -]?key|password|passwd|secret|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+)/iu

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' || typeof part?.text === 'string')
    .map((part) => String(part.text || ''))
    .join('\n')
}

function latestUserMessage(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue
    const text = textOfContent(messages[index].content).trim()
    if (text) return { message: messages[index], text }
  }
  return { message: null, text: '' }
}

function parseJsonObject(value) {
  const source = String(value?.content ?? value ?? '').trim()
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  for (const candidate of [fenced, source]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      const start = candidate.indexOf('{')
      const end = candidate.lastIndexOf('}')
      if (start < 0 || end <= start) continue
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch {
        // Invalid extraction is a safe no-op.
      }
    }
  }
  return null
}

export function isTransientRuntimeMemoryCandidate(candidate) {
  const text = `${String(candidate?.title || '')}\n${String(candidate?.body || '')}`
  return RUNTIME_CAPABILITY_SUBJECT.test(text) && RUNTIME_CAPABILITY_STATE.test(text)
}

function normalizedCandidate(candidate) {
  const type = String(candidate?.type || '').trim()
  if (SENSITIVE_VALUE.test(`${String(candidate?.title || '')}\n${String(candidate?.body || '')}`)) return null
  const title = String(candidate?.title || '').trim().slice(0, 120)
  const body = String(candidate?.body || '').trim().slice(0, 4000)
  const confidence = Number(candidate?.confidence)
  if (!ALLOWED_TYPES.has(type) || !title || !body) return null
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || confidence > 1) return null
  if (SENSITIVE_VALUE.test(`${title}\n${body}`)) return null
  // Runtime capabilities and grants are not durable facts. Persisting them can
  // override fresh tool evidence after the environment or authorization changes.
  if (isTransientRuntimeMemoryCandidate({ title, body })) return null
  return { type, title, body, confidence }
}

export function shouldExtractAutoMemory(messages = [], assistantText = '') {
  const { text } = latestUserMessage(messages)
  if (!text || text.length < 6 || SIMPLE_GREETING.test(text)) return false
  if (SENSITIVE_VALUE.test(text) || SENSITIVE_VALUE.test(String(assistantText || ''))) return false
  return true
}

export async function extractAndStoreAutoMemories({
  userId,
  sessionId = null,
  agentId = null,
  messages = [],
  assistantText = '',
  callModel,
  signal = null,
} = {}) {
  if (signal?.aborted || !userId || typeof callModel !== 'function' || !shouldExtractAutoMemory(messages, assistantText)) {
    return { attempted: false, stored: [], skipped: true }
  }
  const { message: sourceMessage, text: userText } = latestUserMessage(messages)
  const response = await callModel({
    ...(signal ? { signal } : {}),
    messages: [
      {
        role: 'system',
        content: [
          'Extract durable cross-session memories from this completed chat turn.',
          'Return JSON only: {"memories":[{"type":"user|feedback|project|reference","title":"short stable key","body":"one or two factual sentences","confidence":0.0}]}',
          'Return an empty array for transient requests, task progress, guesses, public facts that can be re-fetched, or information useful only in this turn.',
          'Keep explicit user preferences, stable identity facts, project paths/technology/constraints, repeated corrections, and user-provided reference facts.',
          'Never store runtime tool availability, filesystem or connector capability, permission/grant state, environment-variable state, transient errors/timeouts, or instructions caused by a failed tool call.',
          'Never store passwords, API keys, tokens, private keys, financial credentials, health secrets, or other sensitive authentication material.',
          `Emit at most ${MAX_MEMORIES_PER_TURN} memories and only when confidence is at least ${MIN_CONFIDENCE}.`,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          user: userText.slice(0, 12_000),
          assistant: String(assistantText || '').slice(0, 12_000),
        }),
      },
    ],
  })
  // A provider or injected adapter may settle after cancellation. Never
  // reopen persistence or write optional memories after the engine closes.
  if (signal?.aborted) return { attempted: true, stored: [], skipped: true }
  const parsed = parseJsonObject(response)
  const candidates = (Array.isArray(parsed?.memories) ? parsed.memories : [])
    .slice(0, MAX_MEMORIES_PER_TURN)
    .map(normalizedCandidate)
    .filter(Boolean)
  if (!candidates.length) return { attempted: true, stored: [], skipped: false }

  const memoryScope = agentId || null

  const stored = []
  for (const candidate of candidates) {
    if (signal?.aborted) break
    const memory = withMemoryMatchTransaction({ userId, agentId: memoryScope, includeGlobal: true, signal }, () => {
      const matchingManual = findExactMemory({ userId, agentId: memoryScope, includeGlobal: true,
        title: candidate.title, mode: 'automatic', source: 'manual', signal })
      if (matchingManual) return null
      const matchingAuto = findExactMemory({ userId, agentId: memoryScope, type: candidate.type,
        title: candidate.title, body: candidate.body, mode: 'automatic', source: 'auto', signal })
      return upsertMemory({
        id: matchingAuto?.id,
        userId,
        type: candidate.type,
        title: candidate.title,
        body: candidate.body,
        frontmatter: {
          ...(matchingAuto?.frontmatter || {}),
          source: 'auto_chat',
          confidence: candidate.confidence,
        },
        pinned: matchingAuto?.pinned || false,
        sourceSessionId: sessionId,
        sourceMessageId: sourceMessage?.id || null,
        agentId: memoryScope,
      })
    })
    if (memory) stored.push(memory)

  }
  return { attempted: true, stored, skipped: false }
}

export function scheduleAutoMemoryExtraction(options = {}) {
  const { signal } = options
  if (signal?.aborted) return
  const cancelQueuedExtraction = () => {
    clearImmediate(task)
    signal?.removeEventListener('abort', cancelQueuedExtraction)
  }
  const task = setImmediate(() => {
    signal?.removeEventListener('abort', cancelQueuedExtraction)
    if (signal?.aborted) return
    extractAndStoreAutoMemories(options).catch((error) => {
      if (signal?.aborted) return
      logWarn('memory.auto_extract', error?.message || error, {
        userId: options.userId || null,
        sessionId: options.sessionId || null,
        code: error?.code || null,
        indexCode: error?.diagnostics?.code || null,
        indexed: Number(error?.diagnostics?.indexed) || 0,
      })
    })
  })
  signal?.addEventListener('abort', cancelQueuedExtraction, { once: true })
}
