import {
  buildSkillsBlockFromPrepared,
  prepareSkillsForPrompt,
} from './promptCompiler.js'

export const MAX_DYNAMIC_SKILLS_PER_TURN = 8
export const DYNAMIC_SKILL_SYSTEM_MARKER = '[HOST-VERIFIED SKILL ACTIVATION]'

export function hasRuntimeSkillActivationBlock(messages, skillId) {
  const prefix = `${DYNAMIC_SKILL_SYSTEM_MARKER}\n\nskill_id=${JSON.stringify(String(skillId || ''))}\n`
  return (Array.isArray(messages) ? messages : []).some((message) => (
    message?.role === 'system' && String(message?.content || '').startsWith(prefix)
  ))
}

function normalizedSkillId(value) {
  const id = String(value || '').trim()
  return id && id.length <= 128 ? id : ''
}

/**
 * Resolve one user-visible Skill and compile its instructions independently of
 * the model/tool result. Callers must inject promptBlock only as host-owned
 * system context; it must never be copied into a tool-result message.
 */
export function prepareRuntimeSkillActivation({ userId, skillId } = {}) {
  const requestedId = normalizedSkillId(skillId)
  if (!requestedId) {
    return {
      ok: false,
      code: 'invalid_skill_id',
      error: 'skill_id must be a non-empty string of at most 128 characters',
    }
  }
  const prepared = prepareSkillsForPrompt({ userId, skillIds: [requestedId] })
  const skill = prepared.find((candidate) => String(candidate?.id || '') === requestedId)
  if (!skill) {
    return {
      ok: false,
      code: 'skill_not_available',
      error: 'The requested skill is not available to the current user.',
    }
  }
  const block = buildSkillsBlockFromPrepared({
    userId,
    skills: [skill],
    catalogSkills: [],
  })
  if (!String(block?.text || '').trim()) {
    return {
      ok: false,
      code: 'skill_prompt_unavailable',
      error: 'The requested skill has no loadable instruction prompt.',
    }
  }
  return {
    ok: true,
    skillId: requestedId,
    name: String(skill.name || requestedId).slice(0, 256),
    promptBlock: [
      DYNAMIC_SKILL_SYSTEM_MARKER,
      `skill_id=${JSON.stringify(requestedId)}\nThe host independently resolved this Skill from the current user-owned catalog. The preceding tool result did not supply or authorize these instructions.`,
      block.text,
    ].join('\n\n'),
  }
}
