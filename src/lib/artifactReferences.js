import { resolveArtifactToolForSkillId } from '../../shared/artifactIntent.js'
import { buildArtifactPreview } from './artifactPreview.js'

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
  const artifactSource = String(meta.artifactSource || '').trim()
  if (artifactSource) return buildArtifactPreview({ content: artifactSource, meta })

  const serverArtifacts = Array.isArray(meta.serverArtifacts) ? meta.serverArtifacts : []
  if (meta.failed || meta.streaming) return null

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
  if (artifactUrl) return Boolean(target && target === artifactUrl)
  const filename = String(reference.filename || reference.title || '').trim().toLowerCase()
  if (!filename) return false
  const targetName = target.split('/').pop() || ''
  return targetName === filename || target.endsWith(`/${filename}`)
}

export function findArtifactReferenceByHref(references = [], href = '') {
  return references.find((reference) => artifactReferenceMatchesHref(reference, href)) || null
}

function localFileHrefMatchesReference(href, reference) {
  const raw = String(href || '').trim()
  const filename = String(reference?.filename || reference?.title || '').trim().toLowerCase()
  if (!raw || !filename) return false
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { /* compare the original href */ }
  const localPath = /^(?:file:\/\/|[a-z]:[\\/]|\.\.?[\\/])/i.test(decoded)
  if (!localPath) return false
  const targetName = decoded.replace(/[?#].*$/, '').split(/[\\/]/).pop()?.toLowerCase() || ''
  return targetName === filename
}

export function artifactHasInlineLink(content = '', artifact = {}) {
  const markdown = String(content || '')
  const filename = String(artifact.filename || artifact.title || '').trim().toLowerCase()
  const links = /\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)|<((?:https?:\/\/|\/)[^>]+)>/g
  let match
  while ((match = links.exec(markdown)) !== null) {
    const label = String(match[1] || '').trim().toLowerCase()
    const href = match[2] || match[3] || match[4] || ''
    if (artifactReferenceMatchesHref(artifact, href)) return true
    if (label === filename && localFileHrefMatchesReference(href, artifact)) return true
    if (!artifact.url && filename && label === filename) return true
  }
  return false
}

function isAsciiFilenameWordCharacter(value = '') {
  return /^[a-z0-9_-]$/i.test(value)
}

function filenameMatchHasBoundaries(value, index, filename) {
  const before = index > 0 ? value[index - 1] : ''
  const beforeBefore = index > 1 ? value[index - 2] : ''
  const afterIndex = index + filename.length
  const after = afterIndex < value.length ? value[afterIndex] : ''
  const afterAfter = afterIndex + 1 < value.length ? value[afterIndex + 1] : ''
  if (isAsciiFilenameWordCharacter(filename[0])) {
    if (isAsciiFilenameWordCharacter(before)) return false
    if (before === '.' && isAsciiFilenameWordCharacter(beforeBefore)) return false
  }
  if (isAsciiFilenameWordCharacter(filename.at(-1))) {
    if (isAsciiFilenameWordCharacter(after)) return false
    if (after === '.' && isAsciiFilenameWordCharacter(afterAfter)) return false
  }
  return true
}

function findFilenameMatch(value = '', references = [], fromIndex = 0) {
  const source = String(value || '')
  const lowerSource = source.toLowerCase()
  let best = null
  for (const reference of references) {
    const filename = String(reference?.filename || reference?.title || '').trim()
    if (!filename) continue
    const lowerFilename = filename.toLowerCase()
    let index = lowerSource.indexOf(lowerFilename, fromIndex)
    while (index >= 0 && !filenameMatchHasBoundaries(source, index, filename)) {
      index = lowerSource.indexOf(lowerFilename, index + 1)
    }
    if (index < 0) continue
    if (!best || index < best.index || (index === best.index && filename.length > best.filename.length)) {
      best = { filename, index, reference }
    }
  }
  return best
}

function markdownWithoutNonLinkableContent(content = '') {
  const visibleLines = []
  let fence = null
  for (const line of String(content || '').split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/i)?.[1] || ''
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    if (/^(?: {4}|\t)/.test(line)) continue
    visibleLines.push(line)
  }
  return visibleLines.join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<(?:(?:https?:\/\/|\/)[^>]+|[^>]+)>/g, '')
}

export function artifactHasInlineReference(content = '', artifact = {}) {
  if (artifactHasInlineLink(content, artifact)) return true
  const filename = String(artifact?.filename || artifact?.title || '').trim()
  if (!filename) return false
  return Boolean(findFilenameMatch(markdownWithoutNonLinkableContent(content), [{ ...artifact, filename }]))
}

function linkTextNode(value, references) {
  const nodes = []
  let cursor = 0
  while (cursor < value.length) {
    const match = findFilenameMatch(value, references, cursor)
    if (!match) break
    if (match.index > cursor) nodes.push({ type: 'text', value: value.slice(cursor, match.index) })
    const label = value.slice(match.index, match.index + match.filename.length)
    nodes.push({
      type: 'link',
      url: match.reference.url,
      children: [{ type: 'text', value: label }],
    })
    cursor = match.index + match.filename.length
  }
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) })
  return nodes.length > 0 ? nodes : [{ type: 'text', value }]
}

const NON_LINKABLE_MARKDOWN_NODES = new Set([
  'code',
  'definition',
  'html',
  'image',
  'imageReference',
  'link',
  'linkReference',
])

function markdownNodeText(node) {
  if (node?.type === 'text' || node?.type === 'inlineCode') return String(node.value || '')
  if (!Array.isArray(node?.children)) return ''
  return node.children.map(markdownNodeText).join('')
}

function persistedReferenceForBareAutolink(node, references, markdownSource) {
  if (node?.type !== 'link') return null
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const label = markdownNodeText(node).trim()
  const originalSource = markdownSource.slice(start, end)
  // GFM turns filename-like text such as `deck.pptx` into an http link. Only
  // rewrite a source-level bare label; explicit Markdown links stay untouched.
  if (!label || originalSource !== label) return null
  return references.find((reference) => (
    String(reference.filename || reference.title || '').trim().toLowerCase() === label.toLowerCase()
  )) || null
}

function persistedReferenceForLocalFileLink(node, references) {
  if (node?.type !== 'link') return null
  const label = markdownNodeText(node).trim().toLowerCase()
  if (!label) return null
  return references.find((reference) => {
    const filename = String(reference.filename || reference.title || '').trim().toLowerCase()
    return filename === label && localFileHrefMatchesReference(node.url, reference)
  }) || null
}

function linkArtifactNodes(parent, references, markdownSource) {
  if (!Array.isArray(parent?.children)) return
  parent.children = parent.children.flatMap((node) => {
    if (node?.type === 'text') return linkTextNode(String(node.value || ''), references)
    if (node?.type === 'inlineCode') {
      const source = String(node.value || '')
      const trimmed = source.trim()
      const reference = references.find((candidate) => (
        String(candidate.filename || candidate.title || '').trim().toLowerCase() === trimmed.toLowerCase()
      ))
      if (!reference) return [node]
      return [{ type: 'link', url: reference.url, children: [node] }]
    }
    const localFileReference = persistedReferenceForLocalFileLink(node, references)
    if (localFileReference) return [{ ...node, url: localFileReference.url }]
    const bareAutolinkReference = persistedReferenceForBareAutolink(node, references, markdownSource)
    if (bareAutolinkReference) return [{ ...node, url: bareAutolinkReference.url }]
    if (!NON_LINKABLE_MARKDOWN_NODES.has(node?.type)) linkArtifactNodes(node, references, markdownSource)
    return [node]
  })
}

/**
 * Turn only persisted server artifact filenames into Markdown links. The
 * artifact URL remains the identity used by MessageRow when opening the real
 * bytes in the workbench; ordinary filenames and existing links are untouched.
 */
export function remarkArtifactReferences({ references = [] } = {}) {
  const linkableReferences = Array.isArray(references)
    ? references.filter((reference) => reference?.url && String(reference.filename || reference.title || '').trim())
    : []
  return (tree, file) => {
    if (linkableReferences.length > 0) linkArtifactNodes(tree, linkableReferences, String(file?.value || ''))
  }
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
