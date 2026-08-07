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
