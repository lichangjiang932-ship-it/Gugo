import { resolveArtifactToolForSkillId } from '../../shared/artifactIntent.js'
import { buildArtifactPreview } from './artifactPreview.js'
import { normalizeVerifiedLocalFilePath } from './verifiedLocalFileIdentity.js'

const PREVIEW_TYPE_ALIASES = Object.freeze({
  htm: 'html',
  html: 'html',
  mmd: 'mermaid',
  md: 'text',
  markdown: 'text',
  txt: 'text',
  jsx: 'react',
})

const FILE_ARTIFACT_TYPES = new Set(['html', 'pptx', 'docx', 'xlsx'])

export function resolveDeliveryArtifacts(meta = {}) {
  const artifacts = Array.isArray(meta?.serverArtifacts) ? meta.serverArtifacts : []
  if (!meta || typeof meta !== 'object' || !Object.hasOwn(meta, 'serverDeliveryArtifactIds')) {
    // A server turn can persist drafts, previews, and validation helpers beside
    // the actual deliverable. Without an explicit selection there is no safe
    // way to tell them apart, so fail closed instead of exposing every artifact.
    return []
  }
  const byId = new Map(artifacts
    .filter((artifact) => artifact?.id)
    .map((artifact) => [String(artifact.id), artifact]))
  const ids = [...new Set((Array.isArray(meta.serverDeliveryArtifactIds)
    ? meta.serverDeliveryArtifactIds
    : []).map((id) => String(id || '').trim()).filter(Boolean))]
  const localFileReceipts = [
    ...(Array.isArray(meta?.verifiedLocalFiles) ? meta.verifiedLocalFiles : []),
    ...(Array.isArray(meta?.retainedLocalFiles) ? meta.retainedLocalFiles : []),
  ]
  const supersededIds = new Set(localFileReceipts.flatMap((receipt) => {
    if (!receipt?.id || !normalizeVerifiedLocalFilePath(receipt?.path)) return []
    return [
      receipt.relatedArtifactIds,
      receipt.artifactIds,
      receipt.managedArtifactIds,
      receipt.artifactId,
      receipt.managedArtifactId,
    ].flatMap((value) => (Array.isArray(value) ? value : [value]))
  }).map((id) => String(id || '').trim()).filter(Boolean))
  return ids
    .filter((id) => !supersededIds.has(id))
    .map((id) => byId.get(id))
    .filter(Boolean)
}

function declaresManagedFileArtifact(meta = {}) {
  const type = normalizeArtifactReferenceType({ type: meta?.artifactType })
  return FILE_ARTIFACT_TYPES.has(type) || Boolean(resolveArtifactToolForSkillId(meta?.skillId))
}

/**
 * Build a preview only from verifiable artifact evidence.
 *
 * Managed HTML/Office tasks must have either persisted server bytes or a
 * separate artifactSource. A slash-command label alone is not evidence: when a
 * model returns an error or a "copy this into a file" explanation, treating
 * that prose as HTML/Word/Excel/PPT creates a convincing but fake file.
 */
export function buildMessageArtifactPreview(message = {}) {
  if (message?.role !== 'assistant') return null
  const meta = message?.meta || {}
  if (meta.failed || meta.streaming) return null

  const deliverySelectionExplicit = Object.hasOwn(meta, 'serverDeliveryArtifactIds')
  const serverArtifacts = resolveDeliveryArtifacts(meta)
  const hasServerArtifactContract = Boolean(
    meta.serverTurnId
      || meta.serverAuthoritative
      || Object.hasOwn(meta, 'serverArtifacts')
      || Object.hasOwn(meta, 'serverArtifactIds')
      || deliverySelectionExplicit,
  )
  // Server-backed files follow the same explicit-delivery contract as the
  // links below the message. Do not recreate a draft card from artifactSource
  // or raw HTML when the selection is absent, empty, or cannot be resolved.
  if (hasServerArtifactContract && (!deliverySelectionExplicit || serverArtifacts.length === 0)) return null
  const artifactSource = String(meta.artifactSource || '').trim()
  if (artifactSource) {
    const preview = buildArtifactPreview({ content: artifactSource, meta })
    if (!deliverySelectionExplicit) return preview
    return preview && serverArtifacts.some((artifact) => artifactReferenceMatchesPreview(artifact, preview))
      ? preview
      : null
  }

  const content = String(message?.content || '')
  if (!content.trim()) return null
  if (serverArtifacts.length > 0) {
    // Persisted bytes are the source of truth, but a few model adapters still
    // put the complete generated source in `content`. Detect that source only
    // by its contents and only when its type matches a real persisted file.
    // This keeps raw HTML/Office source collapsed without ever hiding ordinary
    // narration or turning a failed explanation into a synthetic artifact.
    const inferred = buildArtifactPreview({ content, meta: {} })
    return inferred && serverArtifacts.some((artifact) => artifactReferenceMatchesPreview(artifact, inferred))
      ? inferred
      : null
  }
  // Preserve content sniffing for a complete raw HTML document, but strip the
  // unverified file declaration so ordinary narration cannot force a preview.
  if (declaresManagedFileArtifact(meta)) return buildArtifactPreview({ content, meta: {} })
  return buildArtifactPreview({ content, meta })
}

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

export {
  artifactHasInlineLink,
  artifactReferenceMatchesHref,
  findArtifactReferenceByHref,
  findArtifactReferenceByLocalPath,
  normalizeArtifactLocalPath,
} from './artifactReferencePath.js'
export {
  artifactHasInlineReference,
  remarkArtifactReferences,
  remarkLocalPathLinks,
} from './artifactReferenceMarkdown.js'

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
