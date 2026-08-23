import { ensureDefaultAgent, getAgent } from './agentStore.js'
import {
  buildIdentityBlock,
  buildIshikiBlock,
  buildSessionsBlock,
  buildSkillsBlockFromPrepared,
  prepareInlineSkillsForPrompt,
  prepareSkillCatalogForPrompt,
  prepareSkillsForPrompt,
} from './promptCompiler.js'
import { prepareMemoryInjectionContext } from './memoryContextService.js'
import { logWarn } from '../utils/logger.js'
import { renderRuntimePromptBlocks } from '../plugins/pluginRegistry.js'
import { readWorkspaceInstructions } from './workspaceInstructions.js'

function normalizeIds(values, limit = 32) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((value) => value.trim()).filter(Boolean))]
    .slice(0, limit)
}

function isPromiseLike(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function'
}

function warnStep(label, error, warn = logWarn) {
  try { warn('turn.prompt', `${label}: ${error?.message || error}`) } catch { /* optional context */ }
}

function safeStep(label, fallback, work, warn = logWarn) {
  try {
    return work()
  } catch (error) {
    warnStep(label, error, warn)
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
  skillDefinitions = [],
  query = '',
  env = process.env,
} = {}, dependencies = {}) {
  const prepareSkills = dependencies.prepareSkillsForPrompt || prepareSkillsForPrompt
  const prepareSkillCatalog = dependencies.prepareSkillCatalogForPrompt || prepareSkillCatalogForPrompt
  const prepareMemory = dependencies.prepareMemoryInjectionContext || prepareMemoryInjectionContext
  const warn = dependencies.logWarn || logWarn
  const readInstructions = dependencies.readWorkspaceInstructions || readWorkspaceInstructions
  const normalizedSkillIds = normalizeIds(skillIds)
  const effectiveAgentId = agentId ? String(agentId) : null
  const registeredSkills = safeStep('background skill context failed', [], () => (
    prepareSkills({ userId, skillIds: normalizedSkillIds })
  ), warn)
  const catalogSkills = safeStep('background skill catalog failed', [], () => (
    prepareSkillCatalog({ userId })
  ), warn)
  const inlineSkills = safeStep('background inline skill context failed', [], () => (
    prepareInlineSkillsForPrompt({ skillIds: normalizedSkillIds, skillDefinitions })
  ), warn)
  const preparedById = new Map(inlineSkills.map((skill) => [String(skill.id), skill]))
  for (const skill of registeredSkills) preparedById.set(String(skill.id), skill)
  const preparedSkills = normalizedSkillIds.map((id) => preparedById.get(id)).filter(Boolean)
  const skills = safeStep('background skills block failed', null, () => buildSkillsBlockFromPrepared({
    userId,
    agentId: effectiveAgentId,
    skills: preparedSkills,
    catalogSkills: [...catalogSkills, ...preparedSkills],
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
  skillDefinitions = [],
  sessionId = null,
  recentMessages = [],
  includeRecentTranscript = true,
  compactionArchivePort,
  query = '',
  canaryAssignment = null,
  env = process.env,
} = {}, dependencies = {}) {
  const readAgent = dependencies.getAgent || getAgent
  const ensureAgent = dependencies.ensureDefaultAgent || ensureDefaultAgent
  const prepareSkills = dependencies.prepareSkillsForPrompt || prepareSkillsForPrompt
  const prepareSkillCatalog = dependencies.prepareSkillCatalogForPrompt || prepareSkillCatalogForPrompt
  const prepareMemory = dependencies.prepareMemoryInjectionContext || prepareMemoryInjectionContext
  const renderPluginPrompts = dependencies.renderRuntimePromptBlocks || renderRuntimePromptBlocks
  const buildSessions = dependencies.buildSessionsBlock || buildSessionsBlock
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
  const registeredSkills = safeStep('skill context failed', [], () => (
    prepareSkills({ userId, skillIds: normalizedSkillIds })
  ), warn)
  const catalogSkills = safeStep('skill catalog failed', [], () => (
    prepareSkillCatalog({ userId })
  ), warn)
  const inlineSkills = safeStep('inline skill context failed', [], () => (
    prepareInlineSkillsForPrompt({ skillIds: normalizedSkillIds, skillDefinitions })
  ), warn)
  const preparedById = new Map(inlineSkills.map((skill) => [String(skill.id), skill]))
  for (const skill of registeredSkills) preparedById.set(String(skill.id), skill)
  const preparedSkills = normalizedSkillIds.map((id) => preparedById.get(id)).filter(Boolean)

  const canaryPrompt = canaryAssignment?.target === 'prompt:workspace-instructions'
    && typeof canaryAssignment?.promptContent === 'string'
    && canaryAssignment.promptContent.trim()
    ? canaryAssignment
    : null
  const instructions = canaryPrompt
    ? { text: canaryPrompt.promptContent.trim() }
    : safeStep('workspace instructions failed', null, () => readInstructions({ env }), warn)
  const identity = safeStep('identity block failed', null, () => buildIdentityBlock({ agent }), warn)
  const ishiki = safeStep('ishiki block failed', null, () => buildIshikiBlock({ agent }), warn)
  const skills = safeStep('skills block failed', null, () => buildSkillsBlockFromPrepared({
    userId,
    agentId: effectiveAgentId,
    skills: preparedSkills,
    catalogSkills: [...catalogSkills, ...preparedSkills],
  }), warn)
  const sessions = safeStep('session block failed', null, () => buildSessions({
    userId,
    sessionId,
    recentMessages,
    includeRecentTranscript,
    compactionArchivePort,
  }), warn)

  const tokenCap = Number(env.MEMORY_INJECT_TOKEN_CAP || 800)
  const memory = safeStep('memory context failed', { text: '', memoryIds: [] }, () => prepareMemory({
    userId,
    agentId: effectiveAgentId,
    query,
    tokenCap: Number.isFinite(tokenCap) ? tokenCap : 800,
  }), warn)
  const runtimePrompts = safeStep(
    'runtime plugin prompt context failed',
    { blocks: [], errors: [] },
    () => renderPluginPrompts({
      userId,
      sessionId,
      agentId: effectiveAgentId,
      skillIds: preparedSkills.map((skill) => String(skill.id)),
    }),
    warn,
  )
  const finalize = (resolvedSessions) => {
    const blocks = []
    for (const block of [identity, ishiki, skills, resolvedSessions]) {
      if (block?.text) blocks.push({ role: 'system', content: block.text })
    }
    if (memory.text) blocks.push({ role: 'system', content: memory.text })
    for (const error of runtimePrompts.errors || []) {
      try {
        warn(
          'turn.prompt',
          `runtime plugin prompt omitted: ${error.pluginId}/${error.id} (${error.code})`,
        )
      } catch { /* optional context */ }
    }
    for (const block of runtimePrompts.blocks || []) {
      blocks.push({
        role: 'system',
        content: `# Runtime Plugin Context: ${block.id}\nSource: ${block.pluginId}\n\n${block.text}`,
      })
    }
    // Keep the four compiled blocks as one stable prefix. Workspace instructions
    // may change independently while a task is running, so placing them before
    // identity would invalidate the provider-side prefix cache for every block.
    if (instructions?.text) blocks.push({ role: 'system', content: instructions.text })

    return {
      messages: blocks,
      effectiveAgentId,
      skillIds: preparedSkills.map((skill) => String(skill.id)),
      memoryIds: memory.memoryIds,
      pluginPromptBlockIds: (runtimePrompts.blocks || []).map((block) => `${block.pluginId}:${block.id}`),
      compactionArchiveId: resolvedSessions?.sources?.archiveId || null,
      compactionBoundary: resolvedSessions?.sources?.compactionBoundary || null,
      canaryAssignment: canaryPrompt ? {
        id: canaryPrompt.id,
        releaseId: canaryPrompt.releaseId,
        variant: canaryPrompt.variant,
        bucket: canaryPrompt.bucket,
        target: canaryPrompt.target,
        baselineSha256: canaryPrompt.baselineSha256,
        candidateSha256: canaryPrompt.candidateSha256,
        releaseFingerprint: canaryPrompt.releaseFingerprint,
      } : null,
    }
  }

  if (!isPromiseLike(sessions)) return finalize(sessions)
  return Promise.resolve(sessions).then(
    (resolved) => finalize(resolved),
    (error) => {
      warnStep('session block failed', error, warn)
      return finalize(null)
    },
  )
}
