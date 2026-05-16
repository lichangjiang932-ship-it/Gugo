import { z } from 'zod'
import { installSkill } from './skillStore.js'

const manifestSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  icon: z.string().min(1),
  permissions: z.array(z.string()).default([]),
})

export function resolveImportedSkillId(baseId, existingIds = []) {
  if (!existingIds.includes(baseId)) return baseId
  let suffix = 2
  while (existingIds.includes(`${baseId}-${suffix}`)) suffix += 1
  return `${baseId}-${suffix}`
}

export function validateSkillPack(files = {}) {
  if (!files['skill.json']) {
    return { ok: false, reason: '缺少 skill.json' }
  }
  if (!files['prompts/system.md']) {
    return { ok: false, reason: '缺少 prompts/system.md' }
  }

  let parsed
  try {
    parsed = JSON.parse(files['skill.json'])
  } catch {
    return { ok: false, reason: 'skill.json 不是合法 JSON' }
  }

  const result = manifestSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, reason: result.error.issues[0]?.message || 'skill.json 校验失败' }
  }

  return {
    ok: true,
    skill: {
      ...result.data,
      systemPrompt: String(files['prompts/system.md'] || ''),
    },
    files,
  }
}

export function installValidatedSkillPack({ files, existingIds = [] }) {
  const validation = validateSkillPack(files)
  if (!validation.ok) return validation
  const id = resolveImportedSkillId(validation.skill.id, existingIds)
  return {
    ok: true,
    skill: installSkill({
      ...validation.skill,
      id,
      files,
    }),
  }
}

