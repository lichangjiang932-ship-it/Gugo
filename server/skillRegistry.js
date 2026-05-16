import { SKILLS } from '../src/data.js'
import { getImportedSkill, listImportedSkills } from './skillStore.js'

function mapBuiltInSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    desc: skill.desc,
    description: skill.desc,
    icon: skill.icon,
    permissions: skill.perms || [],
    perms: skill.perms || [],
    recommended: !!skill.recommended,
    custom: false,
    systemPrompt: skill.systemPrompt || '',
  }
}

function mapImportedSkill(skill) {
  const full = getImportedSkill(skill.id)
  return {
    id: skill.id,
    name: skill.name,
    desc: skill.description,
    description: skill.description,
    icon: skill.icon,
    permissions: skill.permissions || [],
    perms: skill.permissions || [],
    recommended: false,
    custom: true,
    imported: true,
    version: skill.version,
    systemPrompt: full?.files?.['prompts/system.md'] || '',
  }
}

export function listRuntimeSkills() {
  return [
    ...SKILLS.map(mapBuiltInSkill),
    ...listImportedSkills().map(mapImportedSkill),
  ]
}

export function getRuntimeSkill(id) {
  return listRuntimeSkills().find((skill) => skill.id === id) || null
}

export function listRuntimeSkillIds() {
  return listRuntimeSkills().map((skill) => skill.id)
}
