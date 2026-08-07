import { ensureDefaultAgent, getAgent } from './agentStore.js'
import {
  buildIdentityBlock,
  buildIshikiBlock,
  buildSessionsBlock,
  buildSkillsBlockFromPrepared,
  prepareSkillsForPrompt,
} from './promptCompiler.js'
import { prepareMemoryInjectionContext } from './memoryContextService.js'
import { logWarn } from '../utils/logger.js'
import { readWorkspaceInstructions } from './workspaceInstructions.js'

function normalizeIds(values, limit = 32) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((value) => value.trim()).filter(Boolean))]
    .slice(0, limit)
}

function safeStep(label, fallback, work, warn = logWarn) {
  try {
    return work()
  } catch (error) {
    try { warn('turn.prompt', `${label}: ${error?.message || error}`) } catch { /* optional context */ }
    return fallback
  }
}

/**
 * 为 job / subagent 准备不依赖聊天 session 的提示上下文。
 *
 * 后台执行没有稳定的会话消息或默认 agent 归属，因此这里只注入显式技能与
 * 当前任务相关的长期记忆。任一步失败都返回其余可用块，绝不阻断模型调用。
 */
export function prepareBackgroundPromptContext({
  userId,
  agentId = null,
  skillIds = [],
  query = '',
  env = process.env,
} = {}, dependencies = {}) {
  const prepareSkills = dependencies.prepareSkillsForPrompt || prepareSkillsForPrompt
  const prepareMemory = dependencies.prepareMemoryInjectionContext || prepareMemoryInjectionContext
  const warn = dependencies.logWarn || logWarn
  const readInstructions = dependencies.readWorkspaceInstructions || readWorkspaceInstructions
  const normalizedSkillIds = normalizeIds(skillIds)
  const effectiveAgentId = agentId ? String(agentId) : null
  const preparedSkills = safeStep('background skill context failed', [], () => (
    prepareSkills({ userId, skillIds: normalizedSkillIds })
  ), warn)
  const skills = safeStep('background skills block failed', null, () => buildSkillsBlockFromPrepared({
    userId,
    agentId: effectiveAgentId,
    skills: preparedSkills,
  }), warn)
  const tokenCap = Number(env.MEMORY_INJECT_TOKEN_CAP || 800)
  const memory = safeStep('background memory context failed', { text: '', memoryIds: [] }, () => prepareMemory({
    userId,
    agentId: effectiveAgentId,
    query,
    tokenCap: Number.isFinite(tokenCap) ? tokenCap : 800,
  }), warn)
  const messages = []
  const instructions = safeStep('workspace instructions failed', null, () => readInstructions({ env }), warn)
  if (instructions?.text) messages.push({ role: 'system', content: instructions.text })
  if (skills?.text) messages.push({ role: 'system', content: skills.text })
  if (memory?.text) messages.push({ role: 'system', content: memory.text })
  return {
    messages,
    effectiveAgentId,
    skillIds: preparedSkills.map((skill) => String(skill.id)),
    memoryIds: Array.isArray(memory?.memoryIds) ? memory.memoryIds : [],
  }
}

export function prepareTurnPromptContext({
  userId,
  agentId = null,
  skillIds = [],
  sessionId = null,
  recentMessages = [],
  includeRecentTranscript = true,
  query = '',
  env = process.env,
} = {}, dependencies = {}) {
  const readAgent = dependencies.getAgent || getAgent
  const ensureAgent = dependencies.ensureDefaultAgent || ensureDefaultAgent
  const prepareSkills = dependencies.prepareSkillsForPrompt || prepareSkillsForPrompt
  const prepareMemory = dependencies.prepareMemoryInjectionContext || prepareMemoryInjectionContext
  const warn = dependencies.logWarn || logWarn
  const readInstructions = dependencies.readWorkspaceInstructions || readWorkspaceInstructions
  const normalizedSkillIds = normalizeIds(skillIds)

  let agent = null
  if (env.AGENT_INJECT_ENABLED !== '0') {
    agent = safeStep('agent context failed', null, () => (
      agentId ? readAgent({ userId, id: agentId }) : ensureAgent({ userId })
    ), warn)
  }
  const effectiveAgentId = agent?.id || (agentId ? String(agentId) : null)
  const preparedSkills = safeStep('skill context failed', [], () => (
    prepareSkills({ userId, skillIds: normalizedSkillIds })
  ), warn)

  const blocks = []
  const instructions = safeStep('workspace instructions failed', null, () => readInstructions({ env }), warn)
  if (instructions?.text) blocks.push({ role: 'system', content: instructions.text })
  const identity = safeStep('identity block failed', null, () => buildIdentityBlock({ agent }), warn)
  const ishiki = safeStep('ishiki block failed', null, () => buildIshikiBlock({ agent }), warn)
  const skills = safeStep('skills block failed', null, () => buildSkillsBlockFromPrepared({
    userId,
    agentId: effectiveAgentId,
    skills: preparedSkills,
  }), warn)
  const sessions = safeStep('session block failed', null, () => buildSessionsBlock({
    userId,
    sessionId,
    recentMessages,
    includeRecentTranscript,
  }), warn)
  for (const block of [identity, ishiki, skills, sessions]) {
    if (block?.text) blocks.push({ role: 'system', content: block.text })
  }

  const tokenCap = Number(env.MEMORY_INJECT_TOKEN_CAP || 800)
  const memory = safeStep('memory context failed', { text: '', memoryIds: [] }, () => prepareMemory({
    userId,
    agentId: effectiveAgentId,
    query,
    tokenCap: Number.isFinite(tokenCap) ? tokenCap : 800,
  }), warn)
  if (memory.text) blocks.push({ role: 'system', content: memory.text })

  return {
    messages: blocks,
    effectiveAgentId,
    skillIds: preparedSkills.map((skill) => String(skill.id)),
    memoryIds: memory.memoryIds,
  }
}
