import { getRuntimeSkill } from './skillRegistry.js'
import { prepareOptionalPromptContext, prepareOptionalPromptContextAsync } from './optionalPromptContext.js'
import { canonicalizeSkillId } from '../../shared/artifactIntent.js'
import { applySkillQualityContract } from '../utils/skillQuality.js'
import { assertPromptContextActive, promptMemoryDiagnostics } from './backgroundMemoryQuery.js'
import { normalizePromptContextIds } from './optionalPromptContext.js'
import { ensureSafetySystemMessages } from './promptCompiler.js'
import { isExplicitCodeSnippetRequest } from './artifactIntent.js'
import { getDefaultOutputDirectory, getProjectDirectory } from './localFileAccessService.js'
import { buildArtifactPrompt, buildCitationPrompt, buildCodeWorkflowPrompt, buildDelayedFollowupPrompt } from './jobPromptBlocks.js'
import { buildPriorStepsContext, buildVerificationPrompt } from './jobWorkflow.js'

export function resolveJobSkillContext({ prompt = '', userId = null } = {}) {
  const text = String(prompt || '')
  const match = text.match(/^\/([a-z0-9_-]+)\s*(.*)$/i)
  const skillId = match ? canonicalizeSkillId(match[1]) : null
  const userPrompt = match ? match[2].trim() : text.trim()
  return {
    skillId,
    userPrompt,
    skill: skillId ? getRuntimeSkill(skillId, { userId }) : null,
  }
}

export function injectJobPromptContext({
  messages,
  job,
  skill,
  skillId,
  query,
  preparePromptContext,
} = {}) {
  const context = prepareOptionalPromptContext({
    preparePromptContext,
    input: {
      userId: job?.userId,
      agentId: job?.agentId || null,
      skillIds: skillId ? [skillId] : [],
      query,
    },
    scope: 'job.prompt',
  })
  const blocks = [...context.messages]
  if (skill?.systemPrompt && !context.skillIds.includes(String(skillId))) {
    blocks.push({ role: 'system', content: applySkillQualityContract(skill) })
  }
  messages.splice(1, 0, ...blocks)
  return context
}

export async function injectJobPromptContextAsync({
  messages, job, skill, skillId, query, preparePromptContext, env, signal, resuming = false, restoredMessages = false,
  restoredContext = null,
} = {}) {
  assertPromptContextActive(signal)
  if (restoredMessages) return {
    messages: [], skillIds: [], memoryIds: normalizePromptContextIds(restoredContext?.memoryIds),
    memoryDiagnostics: { ...promptMemoryDiagnostics(restoredContext?.memoryDiagnostics),
      embedding: { status: 'skipped', code: 'MEMORY_EMBEDDING_RESTORED_CONTEXT' } },
  }
  const context = await prepareOptionalPromptContextAsync({
    preparePromptContext,
    input: { userId: job?.userId, agentId: job?.agentId || null, skillIds: skillId ? [skillId] : [],
      query, env, signal, resuming },
    scope: 'job.prompt',
  })
  const blocks = [...context.messages]
  if (skill?.systemPrompt && !context.skillIds.includes(String(skillId))) {
    blocks.push({ role: 'system', content: applySkillQualityContract(skill) })
  }
  messages.splice(1, 0, ...blocks)
  return context
}

/** Keep artifact intent, prior-step continuity and optional recall in one prompt assembly. */
export async function buildJobStepPromptMessages({
  job, step, skill, skillId, userPrompt, artifactTools, enableServerTools,
  preparePromptContext, modelEnv, signal, loadedCheckpoint,
}) {
  const messages = ensureSafetySystemMessages([])
  let outputDirectoryContext = {}
  try {
    outputDirectoryContext = { defaultOutputDirectory: getDefaultOutputDirectory({ userId: job.userId }),
      projectDirectory: getProjectDirectory({ userId: job.userId }) }
  } catch { /* optional output-directory context */ }
  // These prompts must use the same artifact selection as the executable catalog.
  if (enableServerTools) {
    messages.push({ role: 'system', content: buildArtifactPrompt(artifactTools, {
      codeSnippetRequested: isExplicitCodeSnippetRequest(userPrompt || job.prompt), ...outputDirectoryContext,
    }) })
    messages.push({ role: 'system', content: buildCodeWorkflowPrompt() })
    messages.push({ role: 'system', content: buildCitationPrompt() })
    messages.push({ role: 'system', content: buildDelayedFollowupPrompt() })
  }
  const suffix = step.kind === 'batch_item'
    ? `\n\n这是批量任务中的第 ${step.input?.index || 1} / ${step.input?.total || 1} 项,请只完成这一项。` : ''
  const priorContext = buildPriorStepsContext(job.steps || [], step.id)
  if (priorContext) messages.push({ role: 'system', content: priorContext })
  const finalPrompt = step.kind === 'verify' ? buildVerificationPrompt(job, step) : `${userPrompt || job.prompt}${suffix}`
  const checkpointState = loadedCheckpoint?.state || loadedCheckpoint
  const promptContext = await injectJobPromptContextAsync({
    messages, job, skill, skillId, query: finalPrompt, preparePromptContext,
    env: modelEnv, signal, resuming: Boolean(loadedCheckpoint),
    restoredMessages: Array.isArray(checkpointState?.messages), restoredContext: checkpointState?.promptContext,
  })
  assertPromptContextActive(signal)
  messages.push({ role: 'user', content: finalPrompt })
  return { messages, finalPrompt, promptContext }
}
