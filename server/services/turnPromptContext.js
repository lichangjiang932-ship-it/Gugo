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
import { goalToolContextForTurn } from './goalPlanPrompt.js'
import { resolveMemoryEmbeddingSpace } from './memoryEmbeddingService.js'
import { fingerprintPromptBlocks } from './promptPrefixFingerprint.js'
import { logWarn } from '../utils/logger.js'
import { renderRuntimePromptBlocks } from '../plugins/pluginRegistry.js'
import { readWorkspaceInstructions } from './workspaceInstructions.js'
import { assertPromptContextActive, prepareBackgroundMemoryQuery, promptMemoryDiagnostics } from './backgroundMemoryQuery.js'

function normalizeIds(values, limit = 32) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((value) => value.trim()).filter(Boolean))]
    .slice(0, limit)
}

function isPromiseLike(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function'
}

function warnStep(label, error, warn = logWarn) {
  const code = /^(?:MEMORY|SQLITE|SKILL|COMPACTION|WORKSPACE)_[A-Z0-9_]{1,70}$/u.test(String(error?.code || ''))
    ? error.code : 'PROMPT_CONTEXT_UNAVAILABLE'
  try { warn('turn.prompt', `${label}: ${code}`) } catch { /* optional context */ }
}

function safeStep(label, fallback, work, warn = logWarn) {
  try {
    return work()
  } catch (error) {
    warnStep(label, error, warn)
    return fallback
  }
}

const EMPTY_GOAL_CONTEXT = Object.freeze({ active: false, planId: null, promptBlock: null })

function safeGoalPlan(prepareGoalPlan, ids, warn) {
  return safeStep('goal plan context failed', EMPTY_GOAL_CONTEXT, () => prepareGoalPlan(ids), warn)
}

/** A query vector is only comparable inside the space that produced it. */
function memoryQuerySpaceFor(queryVector, env) {
  return queryVector ? resolveMemoryEmbeddingSpace(env) : null
}

function memoryDiagnosticSummary(diagnostics) {
  return promptMemoryDiagnostics(diagnostics)
}

function resolvePromptInstructions({ canaryPrompt, readInstructions, userId, env, warn }) {
  if (canaryPrompt) return { text: canaryPrompt.promptContent.trim() }
  return safeStep('workspace instructions failed', null, () => readInstructions({ userId, env }), warn)
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
  queryVector = null,
  querySpace,
  signal = null,
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
  const memory = safeStep('background memory context failed', { text: '', memoryIds: [], diagnostics: { failed: true } }, () => prepareMemory({
    userId,
    agentId: effectiveAgentId,
    query,
    queryVector,
    querySpace: querySpace === undefined ? memoryQuerySpaceFor(queryVector, env) : querySpace,
    signal,
    tokenCap: Number.isFinite(tokenCap) ? tokenCap : 800,
  }), warn)
  const messages = []
  const instructions = safeStep('workspace instructions failed', null, () => readInstructions({ userId, env }), warn)
  if (instructions?.text) messages.push({ role: 'system', content: instructions.text })
  if (skills?.text) messages.push({ role: 'system', content: skills.text })
  if (memory?.text) messages.push({ role: 'system', content: memory.text })
  return {
    messages,
    effectiveAgentId,
    skillIds: preparedSkills.map((skill) => String(skill.id)),
    memoryIds: Array.isArray(memory?.memoryIds) ? memory.memoryIds : [],
    ...(memory?.diagnostics ? { memoryDiagnostics: memoryDiagnosticSummary(memory.diagnostics) } : {}),
  }
}

function renderPromptMessages({ identity, ishiki, skills, instructions, sessions, memory, goalPlan, runtimePrompts, warn }) {
  const blocks = []
  for (const block of [identity, ishiki, skills, instructions]) {
    if (block?.text) blocks.push({ role: 'system', content: block.text, __gugoPromptStability: 'stable' })
  }
  if (sessions?.text) blocks.push({ role: 'system', content: sessions.text })
  // Memory and the plan remain in the volatile tail, after stable instructions.
  if (memory.text) blocks.push({ role: 'system', content: memory.text })
  if (goalPlan?.promptBlock) blocks.push({ role: 'system', content: goalPlan.promptBlock })
  for (const error of runtimePrompts.errors || []) {
    try {
      warn('turn.prompt', `runtime plugin prompt omitted: ${error.pluginId}/${error.id} (${error.code})`)
    } catch { /* optional context */ }
  }
  for (const block of runtimePrompts.blocks || []) {
    blocks.push({ role: 'system',
      content: `# Runtime Plugin Context: ${block.id}\nSource: ${block.pluginId}\n\n${block.text}` })
  }
  return blocks
}

/** Async semantic recall for fresh background tasks; retain the synchronous preparation API. */
export async function prepareBackgroundPromptContextAsync(input = {}, dependencies = {}) {
  const query = await prepareBackgroundMemoryQuery(input, dependencies)
  assertPromptContextActive(input.signal)
  const context = prepareBackgroundPromptContext({ ...input, env: query.env,
    queryVector: query.queryVector, querySpace: query.querySpace }, dependencies)
  assertPromptContextActive(input.signal)
  return { ...context, memoryDiagnostics: {
    ...promptMemoryDiagnostics(context.memoryDiagnostics), embedding: query.embedding,
  } }
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
  memoryQueryVector = null,
  signal = null,
  env = process.env,
} = {}, dependencies = {}) {
  const readAgent = dependencies.getAgent || getAgent
  const ensureAgent = dependencies.ensureDefaultAgent || ensureDefaultAgent
  const prepareSkills = dependencies.prepareSkillsForPrompt || prepareSkillsForPrompt
  const prepareSkillCatalog = dependencies.prepareSkillCatalogForPrompt || prepareSkillCatalogForPrompt
  const prepareMemory = dependencies.prepareMemoryInjectionContext || prepareMemoryInjectionContext
  const prepareGoalPlan = dependencies.goalToolContextForTurn || goalToolContextForTurn
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
  const instructions = resolvePromptInstructions({ canaryPrompt, readInstructions, userId, env, warn })
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
  const memory = safeStep('memory context failed', { text: '', memoryIds: [], diagnostics: { failed: true } }, () => prepareMemory({
    userId,
    agentId: effectiveAgentId,
    query,
    queryVector: memoryQueryVector,
    querySpace: memoryQuerySpaceFor(memoryQueryVector, env),
    signal,
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
  const goalPlan = safeGoalPlan(prepareGoalPlan, { userId, sessionId }, warn)
  const finalize = (resolvedSessions) => {
    const blocks = renderPromptMessages({ identity, ishiki, skills, instructions, sessions: resolvedSessions,
      memory, goalPlan, runtimePrompts, warn })
    // Stable prefix = identity + ishiki + skills + instructions (pushed first).
    const promptFingerprints = fingerprintPromptBlocks({ blocks, stableBlocks: [identity, ishiki, skills, instructions] })
    return {
      messages: blocks,
      effectiveAgentId,
      skillIds: preparedSkills.map((skill) => String(skill.id)),
      memoryIds: memory.memoryIds,
      ...(memory.diagnostics ? { memoryDiagnostics: memoryDiagnosticSummary(memory.diagnostics) } : {}),
      promptFingerprints,
      pluginPromptBlockIds: (runtimePrompts.blocks || []).map((block) => `${block.pluginId}:${block.id}`),
      compactionArchiveId: resolvedSessions?.sources?.archiveId || null,
      compactionBoundary: resolvedSessions?.sources?.compactionBoundary || null,
      goalPlanId: goalPlan?.planId || null,
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
