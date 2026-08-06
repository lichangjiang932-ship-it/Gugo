import {
  buildMemorySystemBlock,
  classifyMemoryFreshness,
  selectActiveMemoriesForInjection,
  touchMemoryUsage,
} from './memoryStore.js'
import { traverseMemoryGraph } from './knowledgeGraph.js'
import { logWarn } from '../utils/logger.js'

const DEFAULT_TOKEN_CAP = 800
const DEFAULT_LINK_DEPTH = 1
const DEFAULT_LINK_NODES = 24
const VERIFIED_FILESYSTEM_SUCCESS = /\[VERIFIED LOCAL FILESYSTEM ACCESS\][\s\S]*?Succeeded:\s*yes\b/i
const FILESYSTEM_STATE_MEMORY = /WORKSPACE_FS_ENABLED|list_directory|read_file|local\s+file(?:system)?|file\s*system|filesystem|本地文件|文件系统/i
const NEGATIVE_AVAILABILITY = /unavailable|not\s+enabled|disabled|cannot|can't|inaccessible|deterministic\s+failure|无法|不可访问|未启用|失败/i

export function memoryContradictsVerifiedFilesystem(memory, query = '') {
  if (!VERIFIED_FILESYSTEM_SUCCESS.test(String(query || ''))) return false
  const text = [memory?.type, memory?.title, memory?.body].filter(Boolean).join('\n')
  return FILESYSTEM_STATE_MEMORY.test(text) && NEGATIVE_AVAILABILITY.test(text)
}

function memoryBlockChars(memory) {
  return `### ${memory?.type || 'reference'}: ${memory?.title || ''}\n${memory?.body || ''}\n`.length
}

function fitMemories(memories, tokenCap) {
  const charsCap = Math.max(200, (Number(tokenCap) || DEFAULT_TOKEN_CAP) * 4)
  const fitted = []
  let totalChars = 0
  for (const memory of memories) {
    const chars = memoryBlockChars(memory)
    if (totalChars + chars > charsCap) continue
    fitted.push(memory)
    totalChars += chars
  }
  return { memories: fitted, totalChars }
}

function emptyContext({ query = '', error = null } = {}) {
  return {
    memories: [],
    memoryIds: [],
    freshness: [],
    text: '',
    totalChars: 0,
    diagnostics: {
      failed: !!error,
      error: error ? String(error?.message || error) : null,
      query: String(query || ''),
      linkedCount: 0,
      suppressedMemoryIds: [],
      linkTruncated: false,
      touched: false,
      touchFailed: false,
    },
  }
}

function safeWarn(logger, message, meta) {
  try {
    logger('memory.context', message, meta)
  } catch {
    // Observability must never turn optional prompt context into a hard failure.
  }
}

/**
 * 为 chat turn、job 与 subagent 准备同一种长期记忆注入数据。
 *
 * 调用方只需把 `text` 作为 system message 注入。所有 DB/图谱/usage 异常都在
 * 本服务内降级，返回稳定的空上下文或无链接的基础上下文，不阻断模型调用。
 */
export function prepareMemoryInjectionContext({
  userId,
  agentId = null,
  query = '',
  tokenCap = DEFAULT_TOKEN_CAP,
  now = Date.now(),
  linkDepth = DEFAULT_LINK_DEPTH,
  maxLinkedNodes = DEFAULT_LINK_NODES,
  touch = true,
} = {}, dependencies = {}) {
  if (!userId) return emptyContext({ query })
  const selectMemories = dependencies.selectActiveMemoriesForInjection || selectActiveMemoriesForInjection
  const traverseLinks = dependencies.traverseMemoryGraph || traverseMemoryGraph
  const buildBlock = dependencies.buildMemorySystemBlock || buildMemorySystemBlock
  const touchUsage = dependencies.touchMemoryUsage || touchMemoryUsage
  const warn = dependencies.logWarn || logWarn

  let picked
  try {
    picked = selectMemories({ userId, agentId, query, tokenCap })
  } catch (error) {
    safeWarn(warn, error?.message || error, { userId, agentId })
    return emptyContext({ query, error })
  }

  const seeds = Array.isArray(picked?.memories) ? picked.memories : []
  let linked = []
  let linkTruncated = false
  if (seeds.length && Number(linkDepth) > 0) {
    try {
      const graph = traverseLinks({
        userId,
        agentId,
        seedIds: seeds.map((memory) => memory.id),
        maxDepth: linkDepth,
        maxNodes: maxLinkedNodes,
        direction: 'both',
      })
      const seedIds = new Set(seeds.map((memory) => memory.id))
      linked = (Array.isArray(graph?.memories) ? graph.memories : [])
        .filter((memory) => !seedIds.has(memory.id))
        .sort((a, b) => (
          Number(graph?.depthById?.[a.id] || 0) - Number(graph?.depthById?.[b.id] || 0)
          || Number(b.pinned) - Number(a.pinned)
          || Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
          || String(a.id).localeCompare(String(b.id))
        ))
      linkTruncated = !!graph?.truncated
    } catch (error) {
      safeWarn(warn, error?.message || error, { userId, agentId, phase: 'memory_links' })
    }
  }

  const deduped = [...new Map([...seeds, ...linked].map((memory) => [memory.id, memory])).values()]
  // Runtime evidence is fresher than durable memory. In particular, a memory
  // captured during an earlier disabled-filesystem run must not override a
  // successful grant + probe from the current turn.
  const suppressedMemories = deduped.filter((memory) => memoryContradictsVerifiedFilesystem(memory, query))
  const candidates = deduped.filter((memory) => !memoryContradictsVerifiedFilesystem(memory, query))
  const fitted = fitMemories(candidates, tokenCap)
  const freshness = fitted.memories.map((memory) => ({
    id: memory.id,
    ...classifyMemoryFreshness(memory.updatedAt, { now }),
  }))
  const freshnessById = new Map(freshness.map((item) => [item.id, item]))
  const memories = fitted.memories.map((memory) => ({
    ...memory,
    freshness: freshnessById.get(memory.id),
  }))

  let text
  try {
    text = buildBlock(memories, { now }) || ''
  } catch (error) {
    safeWarn(warn, error?.message || error, { userId, agentId, phase: 'render' })
    return emptyContext({ query, error })
  }

  const memoryIds = memories.map((memory) => memory.id)
  let touched = false
  let touchFailed = false
  if (touch && memoryIds.length) {
    try {
      touchUsage(userId, memoryIds)
      touched = true
    } catch (error) {
      touchFailed = true
      safeWarn(warn, error?.message || error, { userId, agentId, phase: 'touch' })
    }
  }

  return {
    memories,
    memoryIds,
    freshness,
    text,
    totalChars: fitted.totalChars,
    diagnostics: {
      failed: false,
      error: null,
      query: String(query || ''),
      linkedCount: memories.filter((memory) => !seeds.some((seed) => seed.id === memory.id)).length,
      suppressedMemoryIds: suppressedMemories.map((memory) => memory.id),
      linkTruncated,
      touched,
      touchFailed,
    },
  }
}
