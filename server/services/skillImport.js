import { z } from 'zod'
import { installSkill } from './skillStore.js'

export const SKILL_PACK_LIMITS = Object.freeze({
  maxFiles: 128,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxSystemPromptBytes: 512 * 1024,
  maxPathLength: 240,
})

const sourceSchema = z.object({
  type: z.enum(['github', 'upload', 'plugin']).optional(),
  repository: z.string().max(300).optional(),
  url: z.string().max(1_000).optional(),
  revision: z.string().max(200).optional(),
  subpath: z.string().max(SKILL_PACK_LIMITS.maxPathLength).optional(),
  license: z.string().max(100).optional(),
  licenseEvidence: z.enum(['github-api', 'manifest', 'frontmatter', 'unverified']).optional(),
}).strict()

const manifestSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2_000),
  version: z.string().min(1).max(64),
  icon: z.string().min(1).max(64),
  permissions: z.array(z.string().min(1).max(100)).max(32).default([]),
  source: sourceSchema.optional(),
}).passthrough()

function normalizePackPath(value) {
  if (typeof value !== 'string' || !value || value.length > SKILL_PACK_LIMITS.maxPathLength) return null
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-z]:/i.test(value)) return null
  if ([...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })) return null
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

function validatePackFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return { ok: false, reason: '技能包文件必须是对象' }
  }
  const entries = Object.entries(files)
  if (entries.length > SKILL_PACK_LIMITS.maxFiles) {
    return { ok: false, reason: `技能包文件数不能超过 ${SKILL_PACK_LIMITS.maxFiles}` }
  }

  const normalized = {}
  let totalBytes = 0
  for (const [rawPath, content] of entries) {
    const filePath = normalizePackPath(rawPath)
    if (!filePath || Object.prototype.hasOwnProperty.call(normalized, filePath)) {
      return { ok: false, reason: `技能包包含不安全或重复路径: ${String(rawPath)}` }
    }
    if (typeof content !== 'string') {
      return { ok: false, reason: `技能包文件必须是文本或 Base64 字符串: ${filePath}` }
    }
    // 与 seed 加载器一致：内容禁止混入控制字节，避免损坏/恶意包把控制字符
    // 写入 skill_assets 并作为 system 提示词注入。
    if (hasInvalidTextControls(content)) {
      return { ok: false, reason: `技能包文件包含非法控制字符: ${filePath}` }
    }
    const fileBytes = Buffer.byteLength(content, 'utf8')
    if (fileBytes > SKILL_PACK_LIMITS.maxFileBytes) {
      return { ok: false, reason: `技能包文件过大: ${filePath}` }
    }
    totalBytes += fileBytes
    if (totalBytes > SKILL_PACK_LIMITS.maxTotalBytes) {
      return { ok: false, reason: `技能包总大小不能超过 ${SKILL_PACK_LIMITS.maxTotalBytes} bytes` }
    }
    normalized[filePath] = content
  }
  return { ok: true, files: normalized, totalBytes }
}

function hasInvalidTextControls(content) {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true
  }
  return false
}

export function resolveImportedSkillId(baseId, existingIds = []) {
  if (!existingIds.includes(baseId)) return baseId
  let suffix = 2
  while (existingIds.includes(`${baseId}-${suffix}`)) suffix += 1
  return `${baseId}-${suffix}`
}

export function validateSkillPack(files = {}) {
  const fileValidation = validatePackFiles(files)
  if (!fileValidation.ok) return fileValidation
  const normalizedFiles = fileValidation.files

  if (!normalizedFiles['skill.json']) return { ok: false, reason: '缺少 skill.json' }
  if (!normalizedFiles['prompts/system.md']) return { ok: false, reason: '缺少 prompts/system.md' }
  if (Buffer.byteLength(normalizedFiles['prompts/system.md'], 'utf8') > SKILL_PACK_LIMITS.maxSystemPromptBytes) {
    return { ok: false, reason: `prompts/system.md 不能超过 ${SKILL_PACK_LIMITS.maxSystemPromptBytes} bytes` }
  }

  let parsed
  try {
    parsed = JSON.parse(normalizedFiles['skill.json'])
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
      systemPrompt: normalizedFiles['prompts/system.md'],
    },
    files: normalizedFiles,
  }
}

export function installValidatedSkillPack({ files, existingIds = [], userId }) {
  if (!userId) return { ok: false, reason: '缺少 userId' }
  const validation = validateSkillPack(files)
  if (!validation.ok) return validation
  const id = resolveImportedSkillId(validation.skill.id, existingIds)
  return {
    ok: true,
    skill: installSkill({
      ...validation.skill,
      id,
      userId,
      files: validation.files,
    }),
  }
}

export const _skillImportInternals = Object.freeze({ normalizePackPath, validatePackFiles })
