import { canonicalizeSkillId } from '../../shared/artifactIntent.js'
import { inferBuiltinSkillIdFromPrompt } from '../../shared/skillIntent.js'

export function parseSkillCommand(content = '') {
  const match = String(content).match(/^\/([a-z0-9_-]+)\s*(.*)$/i)
  if (!match) return { skillId: null, userPrompt: String(content || '') }
  return {
    skillId: canonicalizeSkillId(match[1]),
    userPrompt: match[2],
  }
}

export const inferSkillIdFromPrompt = inferBuiltinSkillIdFromPrompt
