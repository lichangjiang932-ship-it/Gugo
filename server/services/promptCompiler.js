import crypto from 'node:crypto'
import { getAgentTemplateSystemPrompt } from './agentTemplates.js'
import { listRuntimeSkills } from './skillRegistry.js'
import { getCompactionArchive } from './compactionService.js'

const BLOCK_TYPES = ['identity', 'ishiki', 'skills', 'sessions']
const CACHE_LIMIT = 64
const EMPTY_RESULT = Object.freeze({ text: '', fingerprint: 'empty', sources: {} })

const caches = Object.fromEntries(BLOCK_TYPES.map((type) => [type, new Map()]))
const stats = Object.fromEntries(BLOCK_TYPES.map((type) => [type, { hits: 0, misses: 0 }]))

function stableJson(value) {
  return JSON.stringify(normalizeStable(value))
}

function normalizeStable(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeStable(item))
  if (!value || typeof value !== 'object') return value
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      if (value[key] !== undefined) acc[key] = normalizeStable(value[key])
      return acc
    }, {})
}

function fingerprintFor(input) {
  return crypto.createHash('sha256').update(stableJson(input)).digest('hex').slice(0, 16)
}

function getCachedText(blockType, fingerprint) {
  const cache = caches[blockType]
  const key = `${blockType}:${fingerprint}`
  if (!cache.has(key)) {
    stats[blockType].misses += 1
    return null
  }
  const text = cache.get(key)
  cache.delete(key)
  cache.set(key, text)
  stats[blockType].hits += 1
  return text
}

function setCachedText(blockType, fingerprint, text) {
  const cache = caches[blockType]
  const key = `${blockType}:${fingerprint}`
  if (cache.has(key)) cache.delete(key)
  cache.set(key, text)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

function cachedBuild(blockType, input, sources, buildText) {
  const fingerprint = fingerprintFor(input)
  const cached = getCachedText(blockType, fingerprint)
  if (cached != null) return { text: cached, fingerprint, sources }
  const text = buildText()
  setCachedText(blockType, fingerprint, text)
  return { text, fingerprint, sources }
}

function personaPrompt(agent) {
  return getAgentTemplateSystemPrompt(agent?.personaTemplate || '', { lang: 'zh' }).trim()
}

function hasAgentPromptContent(agent) {
  return !!(
    (agent?.soulMd || '').trim() ||
    (agent?.identityMd || '').trim() ||
    (agent?.personaTemplate || '').trim()
  )
}

function hasIdentityBlock(agent) {
  return !!((agent?.identityMd || '').trim() || (agent?.personaTemplate || '').trim())
}

export function buildIdentityBlock({ agent } = {}) {
  if (!agent || !hasAgentPromptContent(agent) || !hasIdentityBlock(agent)) return EMPTY_RESULT

  const input = {
    agentId: agent.id || '',
    name: agent.name || '',
    identityMd: agent.identityMd || '',
    avatarUrl: agent.avatarUrl || null,
    personaTemplate: agent.personaTemplate || '',
  }
  const sources = {
    agentId: agent.id || null,
    fields: ['id', 'name', 'identityMd', 'avatarUrl', 'personaTemplate'],
  }
  return cachedBuild('identity', input, sources, () => {
    const identity = (agent.identityMd || '').trim()
    const persona = personaPrompt(agent)
    const parts = [`# Agent: ${agent.name || 'Agent'}`]
    if (persona) parts.push('\n## PERSONA TEMPLATE\n' + persona)
    if (identity) parts.push('\n## IDENTITY\n' + identity)
    return parts.join('\n')
  })
}

export function buildIshikiBlock({ agent } = {}) {
  if (!agent || !hasAgentPromptContent(agent)) return EMPTY_RESULT

  const soul = (agent.soulMd || '').trim()
  const identityPresent = hasIdentityBlock(agent)
  const input = {
    agentId: agent.id || '',
    name: identityPresent ? null : (agent.name || ''),
    soulMd: agent.soulMd || '',
    personaTemplate: agent.personaTemplate || '',
    identityBlockPresent: identityPresent,
  }
  const sources = {
    agentId: agent.id || null,
    fields: ['id', 'soulMd', 'personaTemplate'],
  }
  return cachedBuild('ishiki', input, sources, () => {
    const parts = []
    if (!identityPresent) parts.push(`# Agent: ${agent.name || 'Agent'}`)
    if (soul) parts.push(`\n## SOUL\n${soul}`)
    parts.push('\nFollow the persona above. Stay in character.')
    return parts.join('\n')
  })
}

function normalizeSkill(skill) {
  return {
    id: skill.id,
    name: skill.name || '',
    description: skill.description || skill.desc || '',
    permissions: Array.isArray(skill.permissions) ? [...skill.permissions].sort() : [],
    recommended: !!skill.recommended,
    custom: !!skill.custom,
    imported: !!skill.imported,
    system: !!skill.system,
    version: skill.version || '',
    systemPrompt: skill.systemPrompt || '',
  }
}

export function buildSkillsBlock({ userId, agentId = null, skillIds = [] } = {}) {
  const normalizedIds = [...new Set((Array.isArray(skillIds) ? skillIds : []).map(String).filter(Boolean))].sort()
  if (!normalizedIds.length) return EMPTY_RESULT

  const skillsById = new Map(listRuntimeSkills({ userId }).map((skill) => [skill.id, normalizeSkill(skill)]))
  const skills = normalizedIds.map((id) => skillsById.get(id)).filter(Boolean)
  if (!skills.length) return EMPTY_RESULT

  const input = { userId: userId || null, agentId: agentId || null, skillIds: normalizedIds, skills }
  const sources = {
    userId: userId || null,
    agentId: agentId || null,
    skillIds: skills.map((skill) => skill.id),
    fields: ['id', 'name', 'description', 'permissions', 'systemPrompt'],
  }
  return cachedBuild('skills', input, sources, () => {
    const sections = skills.map((skill) => {
      const lines = [`## ${skill.name || skill.id} (${skill.id})`]
      if (skill.description) lines.push(skill.description)
      if (skill.permissions.length) lines.push(`Permissions: ${skill.permissions.join(', ')}`)
      if (skill.systemPrompt) lines.push('', skill.systemPrompt.trim())
      return lines.join('\n')
    })
    return ['# Skills', ...sections].join('\n\n')
  })
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => part?.text || (part?.type === 'image_url' ? '[image]' : '')).join(' ')
  }
  return ''
}

function normalizeRecentMessage(message) {
  return {
    role: message?.role || '',
    content: textOf(message).slice(0, 2000),
    name: message?.name || null,
    toolCallId: message?.tool_call_id || null,
    archiveId: message?.meta?.archiveId || message?.meta?.compactionArchiveId || null,
  }
}

function findArchiveId(recentMessages) {
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const id = recentMessages[index]?.meta?.archiveId || recentMessages[index]?.meta?.compactionArchiveId
    if (id) return id
  }
  return null
}

function loadArchive({ userId, recentMessages }) {
  const archiveId = findArchiveId(recentMessages)
  if (!userId || !archiveId) return null
  try {
    return getCompactionArchive({ userId, id: archiveId })
  } catch {
    return null
  }
}

export function buildSessionsBlock({ userId, sessionId, recentMessages = [] } = {}) {
  const normalizedMessages = (Array.isArray(recentMessages) ? recentMessages : []).slice(-12).map(normalizeRecentMessage)
  const archive = loadArchive({ userId, recentMessages: Array.isArray(recentMessages) ? recentMessages : [] })
  if (!sessionId && !normalizedMessages.length && !archive?.summaryText) return EMPTY_RESULT

  const normalizedArchive = archive
    ? {
        id: archive.id,
        sessionId: archive.sessionId,
        summaryText: archive.summaryText || '',
        replacedMessageCount: archive.replacedMessageCount || 0,
        createdAt: archive.createdAt || 0,
      }
    : null
  const input = {
    userId: userId || null,
    sessionId: sessionId || null,
    recentMessages: normalizedMessages,
    archive: normalizedArchive,
  }
  const sources = {
    userId: userId || null,
    sessionId: sessionId || null,
    archiveId: normalizedArchive?.id || null,
    fields: ['sessionId', 'recentMessages', 'compactionArchive.summaryText'],
  }
  return cachedBuild('sessions', input, sources, () => {
    const sections = ['# Session Context']
    if (normalizedArchive?.summaryText) {
      sections.push(`## Compacted Archive\n${normalizedArchive.summaryText.trim()}`)
    }
    if (normalizedMessages.length) {
      const tail = normalizedMessages
        .map((message) => `- ${message.role || 'message'}: ${message.content.replace(/\s+/g, ' ').slice(0, 240)}`)
        .join('\n')
      sections.push(`## Recent Tail\n${tail}`)
    }
    return sections.join('\n\n')
  })
}

export function getPromptCompilerStats() {
  return Object.fromEntries(BLOCK_TYPES.map((type) => [
    type,
    {
      hits: stats[type].hits,
      misses: stats[type].misses,
      size: caches[type].size,
    },
  ]))
}

export function clearPromptCompilerCache(blockType) {
  const types = blockType ? [blockType] : BLOCK_TYPES
  for (const type of types) {
    if (!caches[type]) continue
    caches[type].clear()
    stats[type].hits = 0
    stats[type].misses = 0
  }
}
