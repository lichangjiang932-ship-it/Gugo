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
  return ids.map((id) => byId.get(id)).filter(Boolean)
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

const ARTIFACT_PATH_FIELDS = Object.freeze([
  'path',
  'fullPath',
  'sourcePath',
  'outputPath',
  'localPath',
])

function decodedPathText(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try { return decodeURIComponent(raw) } catch { return raw }
}

function unwrappedPathText(value = '') {
  let raw = decodedPathText(value)
  if ((raw.startsWith('<') && raw.endsWith('>'))
    || (raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim()
  }
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      const host = url.hostname && url.hostname.toLowerCase() !== 'localhost' ? `//${url.hostname}` : ''
      raw = `${host}${decodeURIComponent(url.pathname)}`
    } catch {
      raw = raw.replace(/^file:\/\//i, '')
    }
  }
  return raw.replaceAll('\\', '/')
}

/**
 * Normalize a Windows absolute path for comparison only. This never grants
 * filesystem access; it is used to resolve prose back to an already persisted
 * artifact URL.
 */
export function normalizeArtifactLocalPath(value = '') {
  let raw = unwrappedPathText(value)
  if (/^\/[a-z]:\//i.test(raw)) raw = raw.slice(1)
  const drive = raw.match(/^([a-z]):\/(.*)$/i)
  const unc = raw.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/)
  if (!drive && !unc) return ''

  const root = drive ? `${drive[1].toLowerCase()}:/` : `//${unc[1].toLowerCase()}/${unc[2].toLowerCase()}/`
  const tail = drive ? drive[2] : (unc[3] || '')
  const segments = []
  for (const segment of tail.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment.normalize('NFC').toLowerCase())
  }
  return `${root}${segments.join('/')}`.replace(/\/$/, segments.length > 0 ? '' : '/')
}

function normalizedArtifactFilenameValue(value = '') {
  const raw = decodedPathText(value)
  if (!raw) return ''
  const path = normalizeArtifactLocalPath(raw)
  const filename = path ? path.split('/').pop() : raw.split(/[\\/]/).pop()
  return String(filename || '').normalize('NFC').trim().toLowerCase()
}

function artifactFilenameAliases(reference = {}) {
  const filename = decodedPathText(reference?.filename || '')
  const title = decodedPathText(reference?.title || '')
  const values = filename ? [filename] : [title]
  // Local artifacts retain the original source basename in `title` when the
  // artifact store adds a collision suffix (report.pdf -> report-2.pdf).
  // Semantic titles such as "Quarterly report" are intentionally excluded.
  if (filename && title && /\.[a-z0-9]{1,12}$/i.test(title.split(/[\\/]/).pop() || '')) values.push(title)
  const aliases = []
  const seen = new Set()
  for (const value of values) {
    const normalized = normalizedArtifactFilenameValue(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    aliases.push({ normalized, value: String(value).split(/[\\/]/).pop() || String(value) })
  }
  return aliases
}

function uniqueArtifactReference(references = []) {
  const unique = []
  const keys = new Set()
  for (const reference of references) {
    const key = String(reference?.id || reference?.url || '')
    if (key ? keys.has(key) : unique.includes(reference)) continue
    if (key) keys.add(key)
    unique.push(reference)
  }
  return unique.length === 1 ? unique[0] : null
}

function findArtifactReferenceByFilename(references = [], filename = '') {
  const normalized = decodedPathText(filename).normalize('NFC').trim().toLowerCase()
  if (!normalized || normalized.includes('/') || normalized.includes('\\')) return null
  return uniqueArtifactReference(references.filter((reference) => (
    reference?.url && artifactFilenameAliases(reference).some((alias) => alias.normalized === normalized)
  )))
}

/**
 * Resolve an absolute Windows path only against registered artifact URLs.
 * References that carry a real absolute source path must match exactly.
 * Managed artifacts that do not know their source path may still use a unique
 * basename, because their persisted URL is the only available identity.
 */
export function findArtifactReferenceByLocalPath(references = [], value = '') {
  const target = normalizeArtifactLocalPath(value)
  if (!target || !Array.isArray(references)) return null
  const registered = references.filter((reference) => reference?.url)
  const exactMatches = registered.filter((reference) => ARTIFACT_PATH_FIELDS.some((field) => (
    normalizeArtifactLocalPath(reference?.[field]) === target
  )))
  const exact = uniqueArtifactReference(exactMatches)
  if (exact) return exact
  const pathless = registered.filter((reference) => !ARTIFACT_PATH_FIELDS.some((field) => (
    normalizeArtifactLocalPath(reference?.[field])
  )))
  return findArtifactReferenceByFilename(pathless, target.split('/').pop() || '')
}

function localFileHrefMatchesReference(href, reference) {
  const raw = String(href || '').trim()
  const aliases = artifactFilenameAliases(reference)
  if (!raw || aliases.length === 0) return false
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { /* compare the original href */ }
  const localPath = /^(?:file:\/\/|[a-z]:[\\/]|\.\.?[\\/])/i.test(decoded)
  if (!localPath) return false
  const targetName = normalizedArtifactFilenameValue(decoded.replace(/[?#].*$/, '').split(/[\\/]/).pop() || '')
  return aliases.some((alias) => alias.normalized === targetName)
}

function sameArtifactReference(left, right) {
  if (!left || !right) return false
  if (left === right) return true
  return ['identity', 'id', 'url'].some((key) => (
    left[key] && right[key] && String(left[key]) === String(right[key])
  ))
}

function referenceForInlineHref(references, label, href) {
  const direct = findArtifactReferenceByHref(references, href)
    || findArtifactReferenceByLocalPath(references, href)
  if (direct) return direct
  const normalizedLabel = String(label || '').normalize('NFC').trim().toLowerCase()
  if (!normalizedLabel) return null
  return uniqueArtifactReference(references.filter((reference) => (
    reference?.url
      && artifactFilenameAliases(reference).some((alias) => alias.normalized === normalizedLabel)
      && localFileHrefMatchesReference(href, reference)
  )))
}

export function artifactHasInlineLink(content = '', artifact = {}, references = [artifact]) {
  const markdown = String(content || '')
  const candidates = Array.isArray(references) && references.length > 0 ? references : [artifact]
  const links = /\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[\x22\x27][^\x22\x27]*[\x22\x27])?\s*\)|<((?:https?:\/\/|\/)[^>]+)>/g
  let match
  while ((match = links.exec(markdown)) !== null) {
    const href = match[2] || match[3] || match[4] || ''
    const reference = referenceForInlineHref(candidates, match[1], href)
    if (sameArtifactReference(reference, artifact)) return true
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
    for (const alias of artifactFilenameAliases(reference)) {
      const filename = alias.value
      const lowerFilename = filename.toLowerCase()
      let index = lowerSource.indexOf(lowerFilename, fromIndex)
      while (index >= 0 && !filenameMatchHasBoundaries(source, index, filename)) {
        index = lowerSource.indexOf(lowerFilename, index + 1)
      }
      if (index < 0) continue
      // A bare filename cannot identify one of several same-named files.
      // Leave the text untouched in that case so a following absolute-path
      // pass can still resolve the complete path exactly.
      const resolvedReference = findArtifactReferenceByFilename(references, filename)
      if (!resolvedReference) continue
      if (!best || index < best.index || (index === best.index && filename.length > best.filename.length)) {
        best = { filename, index, reference: resolvedReference }
      }
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

export function artifactHasInlineReference(content = '', artifact = {}, references = [artifact]) {
  const candidates = Array.isArray(references) && references.length > 0 ? references : [artifact]
  if (artifactHasInlineLink(content, artifact, candidates)) return true
  const filename = String(artifact?.filename || artifact?.title || '').trim()
  if (!filename) return false
  const visibleContent = markdownWithoutNonLinkableContent(content)
  BARE_ABSOLUTE_PATH_RE.lastIndex = 0
  let pathMatch
  while ((pathMatch = BARE_ABSOLUTE_PATH_RE.exec(visibleContent)) !== null) {
    const path = trimPathTrailingPunctuation(pathMatch[2])
    const reference = findArtifactReferenceByLocalPath(candidates, path)
    if (sameArtifactReference(reference, artifact)) return true
  }
  let cursor = 0
  while (cursor < visibleContent.length) {
    const match = findFilenameMatch(visibleContent, candidates, cursor)
    if (!match) return false
    if (sameArtifactReference(match.reference, artifact)) return true
    cursor = match.index + match.filename.length
  }
  return false
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
  return findArtifactReferenceByFilename(references, label)
}

function persistedReferenceForLocalFileLink(node, references) {
  if (node?.type !== 'link') return null
  const label = markdownNodeText(node).trim().toLowerCase()
  if (!label) return null
  const normalizedLabel = label.normalize('NFC')
  const absoluteReference = findArtifactReferenceByLocalPath(references, node.url)
  if (absoluteReference && artifactFilenameAliases(absoluteReference).some((alias) => alias.normalized === normalizedLabel)) {
    return absoluteReference
  }
  return uniqueArtifactReference(references.filter((reference) => (
    reference?.url
      && artifactFilenameAliases(reference).some((alias) => alias.normalized === normalizedLabel)
      && localFileHrefMatchesReference(node.url, reference)
  )))
}

function linkArtifactNodes(parent, references, markdownSource) {
  if (!Array.isArray(parent?.children)) return
  parent.children = parent.children.flatMap((node) => {
    if (node?.type === 'text') return linkTextNode(String(node.value || ''), references)
    if (node?.type === 'inlineCode') {
      const source = String(node.value || '')
      const trimmed = source.trim()
      const reference = findArtifactReferenceByLocalPath(references, trimmed)
        || findArtifactReferenceByFilename(references, trimmed)
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

// ── Bare absolute paths become clickable links ───────────────────────────

const BARE_ABSOLUTE_PATH_RE = /(^|[\s(（[])([a-zA-Z]:[\\/][^\]\s<>\x22|?*，。；：、（）()[…]+)/g

function trimPathTrailingPunctuation(value) {
  let raw = String(value || '')
  while (raw && /[.,;:!?\x27\x22)\]，。；：、…)]$/.test(raw)) raw = raw.slice(0, -1)
  return raw
}

function barePathLinkNodes(text) {
  const source = String(text || '')
  if (!/[a-zA-Z]:[\\/]/.test(source)) return [{ type: 'text', value: source }]
  const nodes = []
  let cursor = 0
  BARE_ABSOLUTE_PATH_RE.lastIndex = 0
  let match
  while ((match = BARE_ABSOLUTE_PATH_RE.exec(source)) !== null) {
    const prefix = String(match[1] || '')
    const rawPath = String(match[2] || '')
    const path = trimPathTrailingPunctuation(rawPath)
    if (!/[a-zA-Z]:[\\/]/.test(path) || path.length < 4) continue
    const start = match.index + prefix.length
    const end = start + rawPath.length
    if (start > cursor) nodes.push({ type: 'text', value: source.slice(cursor, start) })
    nodes.push({
      type: 'link',
      url: `file:///${path.replace(/\\/g, '/')}`,
      children: [{ type: 'text', value: path }],
    })
    cursor = end
  }
  if (cursor < source.length) nodes.push({ type: 'text', value: source.slice(cursor) })
  return nodes.length > 0 ? nodes : [{ type: 'text', value: source }]
}

/**
 * Turn bare Windows absolute paths (D:\... / C:/...) in text nodes into
 * file:/// links so users can click a path to open the file. The click is
 * handled by MarkdownRenderer's onLinkClick: paths that resolve to persisted
 * artifacts open the preview; everything else just blocks navigation.
 * Code and existing links are left untouched.
 */
export function remarkLocalPathLinks() {
  return (tree) => {
    const visit = (parent) => {
      if (!Array.isArray(parent?.children)) return
      parent.children = parent.children.flatMap((node) => {
        if (node?.type === 'text') return barePathLinkNodes(node.value)
        if (!NON_LINKABLE_MARKDOWN_NODES.has(node?.type)) visit(node)
        return [node]
      })
    }
    visit(tree)
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
