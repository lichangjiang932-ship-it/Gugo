function normalizedId(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : ''
}

function parsedResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function collectArtifactIds(value, target) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const single = normalizedId(value.artifactId)
  if (single) target.add(single)
  if (Array.isArray(value.artifactIds)) {
    for (const id of value.artifactIds) {
      const normalized = normalizedId(id)
      if (normalized) target.add(normalized)
    }
  }
  if (Array.isArray(value.artifacts)) {
    for (const artifact of value.artifacts) {
      const normalized = normalizedId(artifact?.id)
      if (normalized) target.add(normalized)
    }
  }
}

function uniqueArtifacts(artifacts) {
  const seen = new Set()
  return artifacts.filter((artifact) => {
    const id = normalizedId(artifact?.id)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/**
 * Resolve persisted artifacts owned by one tool call without using filenames.
 *
 * Live events retain toolCallId, which is the strongest association. Session
 * snapshots do not currently persist that field, so exact artifact IDs from
 * the durable tool result provide the recovery path after a reload.
 */
export function findToolCallArtifacts(call = {}, artifacts = []) {
  const candidates = Array.isArray(artifacts) ? artifacts.filter(Boolean) : []
  if (!candidates.length) return []

  const callId = normalizedId(call?.id || call?.toolCallId)
  const artifactIds = new Set()
  collectArtifactIds(call, artifactIds)
  collectArtifactIds(parsedResult(call?.result), artifactIds)

  return uniqueArtifacts(candidates.filter((artifact) => {
    const owner = normalizedId(artifact?.toolCallId)
    if (callId && owner === callId) return true

    const artifactId = normalizedId(artifact?.id)
    if (!artifactId || !artifactIds.has(artifactId)) return false
    return !owner || !callId || owner === callId
  }))
}
