export const LOCAL_SKILLS_KEY = 'your-model-atelier:custom-skills:v1'

function normalizeLocalSkill(skill) {
  if (!skill || typeof skill !== 'object') return null
  const id = String(skill.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  const name = String(skill.name || '').trim()
  if (!id || !name) return null
  const desc = String(skill.desc || skill.description || '').trim() || '自定义技能'
  const systemPrompt = String(skill.systemPrompt || skill.instructions || '').trim()
    || `你正在使用“${name}”技能。${desc}`
  return {
    ...skill,
    id,
    name,
    desc,
    description: desc,
    icon: String(skill.icon || '*').slice(0, 2),
    perms: Array.isArray(skill.perms) ? skill.perms.filter(Boolean) : [],
    permissions: Array.isArray(skill.perms) ? skill.perms.filter(Boolean) : [],
    systemPrompt,
    recommended: false,
    custom: true,
    localCustom: true,
  }
}

export function listLocalSkills(storage = globalThis.localStorage) {
  if (!storage) return []
  try {
    const parsed = JSON.parse(storage.getItem(LOCAL_SKILLS_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.map(normalizeLocalSkill).filter(Boolean) : []
  } catch {
    return []
  }
}

export function saveLocalSkills(skills, storage = globalThis.localStorage) {
  if (!storage) return
  const normalized = Array.isArray(skills) ? skills.map(normalizeLocalSkill).filter(Boolean) : []
  storage.setItem(LOCAL_SKILLS_KEY, JSON.stringify(normalized))
}

export function mergeRuntimeSkills(...groups) {
  const merged = []
  const seen = new Set()
  for (const group of groups) {
    for (const skill of Array.isArray(group) ? group : []) {
      if (!skill?.id || seen.has(skill.id)) continue
      seen.add(skill.id)
      merged.push(skill)
    }
  }
  return merged
}
