import { parseTurnEvent } from '../../../shared/turnEvents.js'
import {
  INLINE_SKILL_DEFINITION_LIMITS,
  truncateInlineSkillText,
} from '../../../shared/inlineSkillDefinitions.js'
import { headers, normalizeContextIds, normalizeToolsConfig, parseResponse } from './turnTransport.js'

export function normalizeSkillDefinitions(skillDefinitions, skillIds = []) {
  const limits = INLINE_SKILL_DEFINITION_LIMITS
  const allowedIds = new Set(normalizeContextIds(skillIds))
  const seen = new Set()
  return (Array.isArray(skillDefinitions) ? skillDefinitions : [])
    .map((skill) => {
      const id = truncateInlineSkillText(skill?.id, limits.id)
      const systemPrompt = truncateInlineSkillText(skill?.systemPrompt, limits.systemPrompt)
      if (!id || !allowedIds.has(id) || seen.has(id) || !systemPrompt) return null
      seen.add(id)
      const permissions = [...new Set(
        (Array.isArray(skill?.permissions) ? skill.permissions : Array.isArray(skill?.perms) ? skill.perms : [])
          .map((permission) => truncateInlineSkillText(permission, limits.permission))
          .filter(Boolean),
      )].slice(0, limits.maxPermissions)
      return {
        id,
        name: truncateInlineSkillText(skill?.name || id, limits.name),
        description: truncateInlineSkillText(skill?.description || skill?.desc, limits.description),
        permissions,
        systemPrompt,
      }
    })
    .filter(Boolean)
    .slice(0, limits.maxDefinitions)
}

function normalizeModelConfigRevision(value) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value <= 0) {
    const error = new Error('modelConfigRevision must be a positive safe integer')
    error.code = 'MODEL_CONFIG_REVISION_INVALID'
    error.status = 400
    throw error
  }
  return value
}

export async function startServerTurn({
  sessionId,
  content,
  displayContent,
  attachments,
  modelConfigRevision,
  modelName,
  modelProviderId,
  modelMode = 'agent',
  turnId,
  history,
  agentId,
  skillIds,
  skillDefinitions,
  toolsConfig,
  intentMode,
  signal,
  fetchImpl = fetch,
}) {
  const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() || null : null
  const normalizedSkillIds = normalizeContextIds(skillIds)
  const normalizedModelConfigRevision = normalizeModelConfigRevision(modelConfigRevision)
  const response = await fetchImpl('/api/turns/run', {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({
      sessionId,
      content,
      displayContent,
      attachments: Array.isArray(attachments) ? attachments : [],
      modelName,
      ...(modelProviderId ? { modelProviderId } : {}),
      ...(normalizedModelConfigRevision === null
        ? {}
        : { modelConfigRevision: normalizedModelConfigRevision }),
      modelMode: modelMode === 'chat_only' ? 'chat_only' : 'agent',
      turnId,
      history,
      agentId: normalizedAgentId,
      skillIds: normalizedSkillIds,
      skillDefinitions: normalizeSkillDefinitions(skillDefinitions, normalizedSkillIds),
      toolsConfig: normalizeToolsConfig(toolsConfig),
      intentMode: ['answer', 'execute'].includes(intentMode) ? intentMode : 'auto',
    }),
    signal,
  })
  return (await parseResponse(response)).turn
}

export async function replayServerTurn({ sessionId, turnId, after = -1, limit = 500, signal, fetchImpl = fetch }) {
  const query = new URLSearchParams({
    sessionId,
    turnId,
    after: String(after),
    limit: String(limit),
  })
  const response = await fetchImpl(`/api/turns/events?${query}`, { headers: headers(), signal })
  const body = await parseResponse(response)
  return (body.events || []).map(parseTurnEvent)
}

export async function getServerTurn({ sessionId, turnId, signal, fetchImpl = fetch }) {
  const query = new URLSearchParams({ sessionId })
  const response = await fetchImpl(`/api/turns/${encodeURIComponent(turnId)}?${query}`, {
    headers: headers(),
    signal,
  })
  return (await parseResponse(response)).turn
}

export async function cancelServerTurn({ sessionId, turnId, signal, fetchImpl = fetch }) {
  const response = await fetchImpl(`/api/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ sessionId }),
    signal,
  })
  return (await parseResponse(response)).turn
}

export async function steerServerTurn({
  sessionId,
  turnId,
  content,
  clientRequestId,
  signal,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`/api/turns/${encodeURIComponent(turnId)}/steer`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ sessionId, content, clientRequestId }),
    signal,
  })
  return (await parseResponse(response)).steering
}

export async function resumeServerTurnRequest({
  sessionId,
  turnId,
  resolution,
  retryFailed = false,
  retryRecovery = false,
  signal,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`/api/turns/${encodeURIComponent(turnId)}/resume`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({
      sessionId,
      ...(resolution ? { resolution } : {}),
      ...(retryFailed ? { retryFailed: true } : {}),
      ...(retryRecovery ? { retryRecovery: true } : {}),
    }),
    signal,
  })
  return (await parseResponse(response)).turn
}

