import { SKILLS } from '../../src/data.js'
import { canonicalizeSkillId, PPT_SKILL_ID_ALIASES } from '../../shared/artifactIntent.js'
import { getCodexPluginSkill, listCodexPluginSkills } from '../adapters/codexPluginSkills.js'
import { getImportedSkill, listAllSkillIds, listImportedSkills } from './skillStore.js'

const SKILL_CATALOG_DESCRIPTION_CHARACTERS = 500

function boundedDescription(value) {
  return Array.from(String(value || '').trim()).slice(0, SKILL_CATALOG_DESCRIPTION_CHARACTERS).join('')
}

function mapBuiltInSkill(skill, { loadPrompt = true } = {}) {
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
    ...(loadPrompt ? { systemPrompt: skill.systemPrompt || '' } : {}),
  }
}

function mapImportedSkill(skill, { loadPrompt = true } = {}) {
  const full = loadPrompt ? getImportedSkill(skill.id, { userId: skill.userId }) : null
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
    ...(loadPrompt ? {
      assetCount: fileList.length,
      hasTemplates: fileList.some((p) => p.startsWith('templates/')),
      systemPrompt: full?.files?.['prompts/system.md'] || '',
    } : {}),
  }
}

function catalogEntry(skill) {
  const id = String(skill?.id || '').trim()
  if (!id) return null
  return {
    id,
    name: String(skill?.name || id).trim(),
    description: boundedDescription(skill?.description || skill?.desc),
    loadable: skill?.runnable !== false,
    loadHint: `/${id}`,
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

/**
 * Prompt-safe runtime catalog. This path deliberately avoids reading imported
 * skill assets or Codex SKILL.md bodies; full instructions are loaded only by
 * getRuntimeSkill() for explicit skillIds.
 */
export function listRuntimeSkillCatalog({ userId } = {}) {
  const primary = [
    ...SKILLS.map((skill) => mapBuiltInSkill(skill, { loadPrompt: false })),
    ...listImportedSkills({ userId })
      .filter((skill) => canonicalizeSkillId(skill.id) === skill.id)
      .map((skill) => mapImportedSkill(skill, { loadPrompt: false })),
  ]
  const primaryIds = new Set(primary.map((skill) => skill.id))
  return [
    ...primary,
    ...listCodexPluginSkills().filter((skill) => !primaryIds.has(skill.id)),
  ].map(catalogEntry).filter(Boolean)
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
