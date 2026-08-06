import { getRuntimeSkill } from './skillRegistry.js'
import { prepareOptionalPromptContext } from './optionalPromptContext.js'
import { canonicalizeSkillId } from '../../shared/artifactIntent.js'

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
    blocks.push({ role: 'system', content: skill.systemPrompt })
  }
  messages.splice(1, 0, ...blocks)
  return context
}
