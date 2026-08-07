import { parseTurnEvent } from '../../../shared/turnEvents.js'
import { headers, normalizeContextIds, normalizeToolsConfig, parseResponse } from './turnTransport.js'

export async function startServerTurn({
  sessionId,
  content,
  displayContent,
  modelName,
  turnId,
  history,
  agentId,
  skillIds,
  toolsConfig,
  signal,
  fetchImpl = fetch,
}) {
  const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() || null : null
  const response = await fetchImpl('/api/turns/run', {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({
      sessionId,
      content,
      displayContent,
      modelName,
      turnId,
      history,
      agentId: normalizedAgentId,
      skillIds: normalizeContextIds(skillIds),
      toolsConfig: normalizeToolsConfig(toolsConfig),
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

export async function cancelServerTurn({ sessionId, turnId, fetchImpl = fetch }) {
  const response = await fetchImpl(`/api/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ sessionId }),
  })
  return (await parseResponse(response)).turn
}

export async function resumeServerTurnRequest({ sessionId, turnId, signal, fetchImpl = fetch }) {
  const response = await fetchImpl(`/api/turns/${encodeURIComponent(turnId)}/resume`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ sessionId }),
    signal,
  })
  return (await parseResponse(response)).turn
}

