export const DIRECTORY_REVIEW_GUARD_MARKER = '[DIRECTORY REVIEW REPRESENTATIVE READ REQUIRED]'
export const LIVE_STEERING_GUARD_MARKER = '[LIVE STEERING UPDATE CONTRACT]'
export const DIRECTORY_REVIEW_INTENT = /read|inspect|review|understand|analy[sz]e|research|check|\u9605\u8bfb|\u8bfb\u53d6|\u5ba1\u67e5|\u7406\u89e3|\u4e86\u89e3|\u5206\u6790|\u7814\u7a76|\u68c0\u67e5/i
export const TEXT_FILE = /\.(?:md|mdx|txt|json|ya?ml|toml|ini|cfg|conf|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|cs|php|sh|ps1|bat|cmd|xml|gradle|properties)$/i
export const SENSITIVE_FILE = /(?:^\.|secret|credential|token|password|passwd|id_rsa|private[_-]?key)/i

export function joinLocalPath(root, name) {
  const separator = String(root || '').includes('\\') ? '\\' : '/'
  return `${String(root || '').replace(/[\\/]+$/u, '')}${separator}${name}`
}

export function pickRepresentativeFiles(entries = []) {
  const files = entries
    .filter((entry) => entry?.type === 'file' && typeof entry?.name === 'string')
    .map((entry) => entry.name)
    .filter((name) => name && !/[\\/]/u.test(name) && !SENSITIVE_FILE.test(name))
  const selected = []
  const pick = (...patterns) => {
    for (const pattern of patterns) {
      const found = files.find((name) => pattern.test(name) && !selected.includes(name))
      if (!found) continue
      selected.push(found)
      return
    }
  }
  pick(/^readme(?:\.[^.]+)?$/i, /^manual(?:\.[^.]+)?$/i, /^usage(?:\.[^.]+)?$/i, /^contributing(?:\.[^.]+)?$/i)
  pick(/^(?:package\.json|pyproject\.toml|requirements(?:-[^.]+)?\.txt|cargo\.toml|go\.mod|composer\.json|pom\.xml|build\.gradle|settings\.gradle)$/i)
  pick(/^main(?:\.[^.]+)$/i, /^start(?:\.[^.]+)$/i, /^app(?:\.[^.]+)$/i, /^server(?:\.[^.]+)$/i, /^index(?:\.[^.]+)$/i, /^dashboard(?:\.[^.]+)$/i)
  for (const name of files) {
    if (selected.length >= 3) break
    if (!selected.includes(name) && TEXT_FILE.test(name)) selected.push(name)
  }
  return selected.slice(0, 3)
}

export function buildRepresentativeReadCalls(content, turnId) {
  const calls = []
  const blockPattern = /Path:\s*([^\r\n]+)\r?\nTool:\s*list_directory\r?\nSucceeded:\s*yes\r?\n(\{[^\r\n]+\})/giu
  for (const match of String(content || '').matchAll(blockPattern)) {
    let listing
    try {
      listing = JSON.parse(match[2])
    } catch {
      continue
    }
    const root = String(listing?.path || match[1] || '').trim()
    if (!root || !Array.isArray(listing?.entries)) continue
    for (const name of pickRepresentativeFiles(listing.entries)) {
      if (calls.length >= 3) break
      const suffix = String(turnId || 'turn').replace(/[^A-Za-z0-9_-]/g, '').slice(-24)
      calls.push({
        id: `local-project-read-${suffix}-${calls.length + 1}`,
        type: 'function',
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: joinLocalPath(root, name) }),
        },
      })
    }
    if (calls.length >= 3) break
  }
  return calls
}

/**
 * The chat client may perform an authorized read-only filesystem call before
 * the tool loop starts and append its structured result to the model prompt.
 * Count only successful, content-bearing preflight records as read execution
 * evidence. This deliberately does not imply mutation evidence.
 */
export function hasSuccessfulLocalPreflightRead(content) {
  const text = String(content || '')
  const directoryPattern = /Path:\s*([^\r\n]+)\r?\nTool:\s*list_directory\r?\nSucceeded:\s*yes\r?\n(\{[^\r\n]+\})/giu
  for (const match of text.matchAll(directoryPattern)) {
    try {
      const listing = JSON.parse(match[2])
      if (listing?.ok === true && Array.isArray(listing.entries)) return true
    } catch {
      // Ignore malformed or user-authored lookalikes.
    }
  }

  const readPattern = /Path:\s*[^\r\n]+\r?\nTool:\s*read_file\r?\n(?:(?!\r?\nPath:)[\s\S]){0,1200}?Access succeeded:\s*yes\r?\n(?:(?!\r?\nPath:)[\s\S]){0,1200}?Content extracted:\s*yes(?:\r?\n|$)/giu
  return readPattern.test(text)
}

export function successfulReadFileInMessages(messages = []) {
  return messages.some((message) => {
    if (message?.role !== 'tool' || message?.name !== 'read_file') return false
    try {
      return JSON.parse(String(message.content || '{}'))?.ok === true
    } catch {
      return false
    }
  })
}

/**
 * 执行单个工具调用 → 落盘 artifact → appendJobArtifact → 返回给模型的简短结果。
 */
export function buildSubagentRequest(
  args = {},
  inheritedModelName = '',
  inheritedSkillIds = [],
  inheritedSkillDefinitions = [],
  inheritedModelProviderId = '',
  inheritedModelConfigRevision = null,
) {
  const rawRequest = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const request = { ...rawRequest }
  delete request.skillDefinitions
  delete request.skill_definitions
  const modelName = String(request.modelName || request.model_name || inheritedModelName || '').trim()
  const modelProviderId = String(
    request.modelProviderId || request.model_provider_id || inheritedModelProviderId || '',
  ).trim()
  const rawConfigRevision = request.modelConfigRevision
    ?? request.model_config_revision
    ?? inheritedModelConfigRevision
  const modelConfigRevision = Number(rawConfigRevision)
  const explicitSkillIds = request.skillIds || request.skill_ids
  const skillIds = [...new Set((Array.isArray(explicitSkillIds) ? explicitSkillIds : inheritedSkillIds)
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
  return {
    ...request,
    ...(modelName ? { modelName } : {}),
    ...(modelProviderId ? { modelProviderId } : {}),
    ...(Number.isInteger(modelConfigRevision) && modelConfigRevision > 0
      ? { modelConfigRevision }
      : {}),
    ...(skillIds.length ? { skillIds } : {}),
    ...(Array.isArray(inheritedSkillDefinitions) && inheritedSkillDefinitions.length
      ? { skillDefinitions: inheritedSkillDefinitions }
      : {}),
  }
}

export function inheritedJobSkillIds(job, activeSkillId = null) {
  const configured = Array.isArray(job?.skillIds) ? job.skillIds : []
  const fallback = configured.length ? configured : (activeSkillId ? [activeSkillId] : [])
  return [...new Set(fallback
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

// Image outputs the model must be able to inspect to verify its own work.
// Feedback is opt-in per tool and capped so large media never enters the
// prompt as base64. TIFF/AVIF are omitted because common vision endpoints
// reject them.
