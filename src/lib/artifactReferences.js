const PREVIEW_TYPE_ALIASES = Object.freeze({
  htm: 'html',
  html: 'html',
  mmd: 'mermaid',
  md: 'text',
  markdown: 'text',
  txt: 'text',
  jsx: 'react',
})

export function normalizeArtifactReferenceType(artifact = {}) {
  const declared = String(artifact?.type || '').trim().toLowerCase().replace(/^\./, '')
  const filename = String(artifact?.filename || artifact?.title || '').trim()
  const extension = filename.includes('.') ? filename.split('.').at(-1).toLowerCase() : ''
  const type = declared && declared !== 'file' ? declared : extension
  return PREVIEW_TYPE_ALIASES[type] || type || 'file'
}

export function artifactReferenceMatchesPreview(artifact, preview) {
  if (!artifact || !preview) return false
  const artifactType = normalizeArtifactReferenceType(artifact)
  const previewType = normalizeArtifactReferenceType({ type: preview.type, filename: preview.filename })
  return artifactType === previewType
}

export function buildArtifactReferenceIdentity({ artifact = {}, filename = '', messageId = '', type = '' } = {}) {
  const normalizedFilename = String(filename || artifact?.filename || artifact?.title || 'artifact').trim().toLowerCase()
  const normalizedType = normalizeArtifactReferenceType({ ...artifact, filename: normalizedFilename, type })
  // Keep UI identity independent from transient message/preview object instances.
  // Filename + type stays the same when a streamed preview is replaced by the
  // persisted server artifact at turn completion.
  return `${String(messageId || 'artifact')}:${normalizedType}:${normalizedFilename}`
}

function normalizedReferenceUrl(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw, 'http://artifact.local')
    return decodeURIComponent(url.pathname).replace(/\/+$/, '').toLowerCase()
  } catch {
    try { return decodeURIComponent(raw.split(/[?#]/)[0]).replace(/\/+$/, '').toLowerCase() } catch { return raw.toLowerCase() }
  }
}

export function artifactReferenceMatchesHref(reference, href) {
  if (!reference || !href) return false
  const target = normalizedReferenceUrl(href)
  const artifactUrl = normalizedReferenceUrl(reference.url)
  if (target && artifactUrl && target === artifactUrl) return true
  const filename = String(reference.filename || reference.title || '').trim().toLowerCase()
  if (!filename) return false
  const targetName = target.split('/').pop() || ''
  return targetName === filename || target.endsWith(`/${filename}`)
}

export function findArtifactReferenceByHref(references = [], href = '') {
  return references.find((reference) => artifactReferenceMatchesHref(reference, href)) || null
}

export function artifactHasInlineLink(content = '', artifact = {}) {
  const markdown = String(content || '')
  const filename = String(artifact.filename || artifact.title || '').trim().toLowerCase()
  const links = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)|<((?:https?:\/\/|\/)[^>]+)>/g
  let match
  while ((match = links.exec(markdown)) !== null) {
    const label = String(match[1] || '').trim().toLowerCase()
    const href = match[2] || match[3] || ''
    if ((filename && label === filename) || artifactReferenceMatchesHref(artifact, href)) return true
  }
  return false
}

export function artifactReferenceOpenPayload(reference, messageId = '') {
  if (!reference) return null
  // A persisted server file is the source of truth. Always load and parse its
  // actual bytes instead of rebuilding an Office preview from assistant text.
  if (reference.url) {
    return {
      messageId: String(messageId || ''),
      content: '',
      preview: null,
      directFile: {
        id: reference.id,
        filename: reference.filename,
        title: reference.title,
        type: reference.type,
        mimeType: reference.mimeType,
        url: reference.url,
      },
    }
  }
  return reference.previewArtifact || null
}

export function buildServerArtifactReferences({ artifacts = [], content = '', messageId = '', preview = null } = {}) {
  if (!Array.isArray(artifacts)) return []
  return artifacts.map((artifact, index) => {
    const filename = String(artifact?.filename || artifact?.title || 'artifact').trim() || 'artifact'
    const canPreview = artifactReferenceMatchesPreview(artifact, preview)
    const type = normalizeArtifactReferenceType({ ...artifact, filename })
    return {
      ...artifact,
      id: artifact?.id || artifact?.url || `${messageId || 'artifact'}-${index}`,
      filename,
      type,
      identity: buildArtifactReferenceIdentity({ artifact, filename, messageId, type }),
      previewArtifact: canPreview ? {
        messageId: String(messageId || ''),
        artifactIdentity: buildArtifactReferenceIdentity({ artifact, filename, messageId, type }),
        content: String(content || ''),
        preview: { ...preview, filename },
      } : null,
    }
  })
}
