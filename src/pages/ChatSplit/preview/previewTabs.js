function normalizeDirectFileType(file, filename) {
  const extension = String(filename.split('.').pop() || '').toLowerCase()
  const rawType = String(file?.type || extension || 'file').toLowerCase()
  return rawType.includes('/') ? (extension || rawType.split('/').pop()) : rawType
}

function fallbackArtifactName(artifact) {
  return String(
    artifact?.preview?.filename
      || artifact?.preview?.title
      || artifact?.directFile?.filename
      || artifact?.directFile?.title
      || 'artifact',
  )
}

function stableIdentityText(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableIdentityText).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableIdentityText(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function stableIdentityDigest(value) {
  const text = stableIdentityText(value)
  let first = 2166136261
  let second = 5381
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    first ^= code
    first = Math.imul(first, 16777619)
    second = Math.imul(second, 33) ^ code
  }
  return `${text.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`
}

function firstStableValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '')
}

export function previewArtifactTabId(artifact) {
  const artifactIdentity = String(artifact?.artifactIdentity || '').trim()
  if (artifactIdentity) return `artifact:${artifactIdentity}`

  const file = artifact?.directFile
  if (file) {
    const fileIdentity = firstStableValue(
      file.id,
      file.uri,
      file.path,
      file.fullPath,
      file.sourcePath,
      file.downloadUrl,
      file.url,
    )
    if (fileIdentity !== undefined) return `file:${String(fileIdentity).trim()}`
    return `file:fallback:${stableIdentityDigest({
      messageId: artifact?.messageId || '',
      type: file.type || artifact?.preview?.type || 'file',
      filename: fallbackArtifactName(artifact),
      path: firstStableValue(file.path, file.fullPath, file.sourcePath, artifact?.path) || '',
      source: firstStableValue(file.source, artifact?.source) || '',
      content: firstStableValue(file.content, artifact?.content) || '',
    })}`
  }

  const preview = artifact?.preview
  return `preview:${stableIdentityDigest({
    messageId: artifact?.messageId || '',
    type: preview?.type || 'file',
    filename: fallbackArtifactName(artifact),
    path: firstStableValue(preview?.path, artifact?.path) || '',
    source: firstStableValue(preview?.source, artifact?.source) || '',
    content: firstStableValue(artifact?.content, preview?.content) || '',
  })}`
}

export function createPreviewTab(artifact) {
  if (!artifact) return null
  const file = artifact.directFile
  if (file) {
    const filename = fallbackArtifactName(artifact)
    const type = normalizeDirectFileType(file, filename)
    return {
      id: previewArtifactTabId(artifact),
      artifact,
      preview: {
        type,
        filename,
        label: type.toUpperCase(),
        summary: file.summary || file.mimeType || '',
      },
    }
  }

  const preview = artifact.preview || {}
  return {
    id: previewArtifactTabId(artifact),
    artifact,
    preview: {
      type: preview.type || 'file',
      filename: fallbackArtifactName(artifact),
      label: preview.label || String(preview.type || 'file').toUpperCase(),
      summary: preview.summary || '',
    },
  }
}

export function createPreviewTabState(artifact) {
  const tab = createPreviewTab(artifact)
  return tab ? { tabs: [tab], activeId: tab.id } : { tabs: [], activeId: '' }
}

export function upsertPreviewTab(state, artifact) {
  const tab = createPreviewTab(artifact)
  if (!tab) return state
  const index = state.tabs.findIndex((item) => item.id === tab.id)
  if (index < 0) return { tabs: [...state.tabs, tab], activeId: tab.id }
  if (state.tabs[index].artifact === artifact && state.activeId === tab.id) return state
  const tabs = [...state.tabs]
  tabs[index] = tab
  return { tabs, activeId: tab.id }
}

export function activatePreviewTab(state, tabId) {
  if (state.activeId === tabId || !state.tabs.some((tab) => tab.id === tabId)) return state
  return { ...state, activeId: tabId }
}

export function removePreviewTab(state, tabId) {
  const index = state.tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return state
  const tabs = state.tabs.filter((tab) => tab.id !== tabId)
  if (!tabs.length) return { tabs: [], activeId: '' }
  if (state.activeId !== tabId) return { tabs, activeId: state.activeId }
  const adjacent = tabs[Math.min(index, tabs.length - 1)]
  return { tabs, activeId: adjacent.id }
}
