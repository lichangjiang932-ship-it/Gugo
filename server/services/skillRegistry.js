import { SKILLS } from '../../src/data.js'
import { canonicalizeSkillId, PPT_SKILL_ID_ALIASES } from '../../shared/artifactIntent.js'
import { getCodexPluginSkill, listCodexPluginSkills } from '../adapters/codexPluginSkills.js'
import { getImportedSkill, listAllSkillIds, listImportedSkills } from './skillStore.js'

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
  const full = getImportedSkill(skill.id, { userId: skill.userId })
  const fileList = full?.files ? Object.keys(full.files) : []
  return {
    id: skill.id,
    name: skill.name,
    desc: skill.description,
    description: skill.description,
    icon: skill.icon,
    permissions: skill.permissions || [],
    perms: skill.permissions || [],
    recommended: !!skill.system, // 系统内置默认推荐
    custom: !skill.system,
    imported: !skill.system,
    system: !!skill.system,
    version: skill.version,
    assetCount: fileList.length,
    hasTemplates: fileList.some((p) => p.startsWith('templates/')),
    systemPrompt: full?.files?.['prompts/system.md'] || '',
  }
}

/**
 * 返回当前用户可见的全部技能。内置 SKILLS 对所有用户可见,
 * 导入技能必须带 userId 才会被附加进列表——避免跨用户泄漏。
 */
export function listRuntimeSkills({ userId } = {}) {
  const primary = [
    ...SKILLS.map(mapBuiltInSkill),
    ...listImportedSkills({ userId })
      .filter((skill) => canonicalizeSkillId(skill.id) === skill.id)
      .map(mapImportedSkill),
  ]
  const primaryIds = new Set(primary.map((skill) => skill.id))
  return [
    ...primary,
    ...listCodexPluginSkills().filter((skill) => !primaryIds.has(skill.id)),
  ]
}

export function getRuntimeSkill(id, { userId } = {}) {
  const canonicalId = canonicalizeSkillId(id)
  const primary = [
    ...SKILLS.map(mapBuiltInSkill),
    ...listImportedSkills({ userId })
      .filter((skill) => canonicalizeSkillId(skill.id) === skill.id)
      .map(mapImportedSkill),
  ].find((skill) => skill.id === canonicalId)
  if (primary) return primary
  return getCodexPluginSkill(canonicalId, { runnableOnly: true, loadPrompt: true })
}

export function listRuntimeSkillIds({ userId } = {}) {
  return listRuntimeSkills({ userId }).map((skill) => skill.id)
}

export function listAllRuntimeSkillIds() {
  return [...new Set([
    ...SKILLS.map((skill) => skill.id),
    ...PPT_SKILL_ID_ALIASES,
    ...listAllSkillIds(),
    ...listCodexPluginSkills().map((skill) => skill.id),
  ])]
}
