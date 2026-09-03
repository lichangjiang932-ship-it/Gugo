import {
  ARTIFACT_PATH_FIELDS,
  artifactFilenameAliases,
  artifactHasInlineLink,
  decodedPathText,
  findArtifactReferenceByFilename,
  findArtifactReferenceByLocalPath,
  localFileHrefMatchesReference,
  normalizeArtifactLocalPath,
  sameArtifactReference,
  uniqueArtifactReference,
} from './artifactReferencePath.js'
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

// Unlike the compact bare-path matcher used for generic file:// links, this
// matcher keeps spaces inside a Windows filename/path. That lets the verified
// artifact pass treat an unknown absolute path as one indivisible span and
// prevents its trailing basename from linking to a file in another directory.
const ABSOLUTE_FILE_PATH_WITH_SPACES_RE = new RegExp(
  '(^|[`\\s(（\\[：:])([a-zA-Z]:[\\\\/][^\\r\\n<>\\x22|?*，。；：、（）\\[\\]…]*?\\.[a-zA-Z0-9]{1,12})(?=$|[`\\s,;:!?，。；：、）)\\]…！？]|\\.(?=$|[`\\s,;:!?，。；：、）)\\]…！？]))',
  'g',
)

function absoluteFilePathSpans(value = '') {
  const source = String(value || '')
  const spans = []
  ABSOLUTE_FILE_PATH_WITH_SPACES_RE.lastIndex = 0
  let match
  while ((match = ABSOLUTE_FILE_PATH_WITH_SPACES_RE.exec(source)) !== null) {
    const prefix = String(match[1] || '')
    const path = trimPathTrailingPunctuation(match[2])
    if (!path) continue
    const start = match.index + prefix.length
    spans.push({ start, end: start + path.length, path })
  }
  return spans
}

export function artifactHasInlineReference(content = '', artifact = {}, references = [artifact]) {
  const candidates = Array.isArray(references) && references.length > 0 ? references : [artifact]
  if (artifactHasInlineLink(content, artifact, candidates)) return true
  const filename = String(artifact?.filename || artifact?.title || '').trim()
  if (!filename) return false
  const visibleContent = markdownWithoutNonLinkableContent(content)
  const absoluteSpans = absoluteFilePathSpans(visibleContent)
  for (const span of absoluteSpans) {
    const reference = findArtifactReferenceByLocalPath(candidates, span.path)
    if (sameArtifactReference(reference, artifact)) return true
  }
  const maskedContent = [...visibleContent]
  for (const span of absoluteSpans) {
    for (let index = span.start; index < span.end; index += 1) maskedContent[index] = ' '
  }
  const filenameContent = maskedContent.join('')
  let cursor = 0
  while (cursor < filenameContent.length) {
    const match = findFilenameMatch(filenameContent, candidates, cursor)
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

function findExactArtifactReferenceByLocalPath(references = [], value = '') {
  const target = normalizeArtifactLocalPath(value)
  if (!target) return null
  return uniqueArtifactReference(references.filter((reference) => (
    reference?.url && ARTIFACT_PATH_FIELDS.some((field) => (
      normalizeArtifactLocalPath(reference?.[field]) === target
    ))
  )))
}

function pathContainsRegisteredArtifactFilename(value = '', references = []) {
  const lowerPath = String(value || '').toLowerCase()
  return references.some((reference) => (
    artifactFilenameAliases(reference).some((alias) => {
      const index = lowerPath.indexOf(alias.value.toLowerCase())
      return index > 0 && /[\\/]/.test(lowerPath[index - 1])
    })
  ))
}

function exactReferencePathMatch(value, references, fromIndex = 0) {
  const source = String(value || '')
  const lowerSource = source.toLowerCase()
  let best = null
  const hasPathBoundary = (index, length) => {
    const before = index > 0 ? source[index - 1] : ''
    const after = index + length < source.length ? source[index + length] : ''
    const pathCharacter = /[\p{L}\p{N}\p{M}_./\\:%+~-]/u
    return (!before || !pathCharacter.test(before))
      && (!after || !pathCharacter.test(after))
  }
  for (const reference of references) {
    for (const field of ARTIFACT_PATH_FIELDS) {
      const raw = decodedPathText(reference?.[field]).trim()
      if (!normalizeArtifactLocalPath(raw)) continue
      const candidates = [...new Set([raw, raw.replaceAll('\\', '/')])]
      for (const candidate of candidates) {
        const lowerCandidate = candidate.toLowerCase()
        let index = lowerSource.indexOf(lowerCandidate, fromIndex)
        while (index >= 0 && !hasPathBoundary(index, candidate.length)) {
          index = lowerSource.indexOf(lowerCandidate, index + 1)
        }
        if (index < 0) continue
        if (!best || index < best.index || (index === best.index && candidate.length > best.path.length)) {
          best = {
            index,
            path: source.slice(index, index + candidate.length),
            reference,
          }
        }
      }
    }
  }
  return best
}

function linkVerifiedCompactPaths(value, references) {
  const source = String(value || '')
  if (!/[a-zA-Z]:[\\/]/.test(source)) return linkTextNode(source, references)
  const nodes = []
  let cursor = 0
  for (const span of absoluteFilePathSpans(source)) {
    const { path, start, end } = span
    const reference = findExactArtifactReferenceByLocalPath(references, path)
    if (start > cursor) nodes.push(...linkTextNode(source.slice(cursor, start), references))
    if (reference?.url) {
      nodes.push({
        type: 'link',
        url: reference.url,
        children: [{ type: 'text', value: path }],
      })
    } else if (pathContainsRegisteredArtifactFilename(path, references)) {
      // An absolute path is an indivisible identity. If its complete path is
      // not registered, keep the whole span as text instead of falling back
      // to a same-named file from another directory.
      nodes.push({ type: 'text', value: path })
    } else {
      nodes.push(...linkTextNode(path, references))
    }
    cursor = end
  }
  if (cursor < source.length) nodes.push(...linkTextNode(source.slice(cursor), references))
  return nodes.length > 0 ? nodes : [{ type: 'text', value: source }]
}

function linkVerifiedAbsolutePaths(value, references) {
  const source = String(value || '')
  const nodes = []
  let cursor = 0
  let match = exactReferencePathMatch(source, references, cursor)
  while (match) {
    if (match.index > cursor) {
      nodes.push(...linkVerifiedCompactPaths(source.slice(cursor, match.index), references))
    }
    nodes.push({
      type: 'link',
      url: match.reference.url,
      children: [{ type: 'text', value: match.path }],
    })
    cursor = match.index + match.path.length
    match = exactReferencePathMatch(source, references, cursor)
  }
  if (cursor < source.length) nodes.push(...linkVerifiedCompactPaths(source.slice(cursor), references))
  return nodes.length > 0 ? nodes : [{ type: 'text', value: source }]
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
  if (normalizeArtifactLocalPath(node.url)) return null
  return uniqueArtifactReference(references.filter((reference) => (
    reference?.url
      && artifactFilenameAliases(reference).some((alias) => alias.normalized === normalizedLabel)
      && localFileHrefMatchesReference(node.url, reference)
  )))
}

function linkArtifactNodes(parent, references, markdownSource) {
  if (!Array.isArray(parent?.children)) return
  parent.children = parent.children.flatMap((node) => {
    if (node?.type === 'text') return linkVerifiedAbsolutePaths(String(node.value || ''), references)
    if (node?.type === 'inlineCode') {
      const source = String(node.value || '')
      const trimmed = source.trim()
      const reference = normalizeArtifactLocalPath(trimmed)
        ? findArtifactReferenceByLocalPath(references, trimmed)
        : findArtifactReferenceByFilename(references, trimmed)
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

const BARE_ABSOLUTE_PATH_RE = /(^|[\s(（[：:])([a-zA-Z]:[\\/][^\]\s<>\x22|?*，。；：、（）()[…]+)/g

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
        if (node?.type === 'link') {
          const path = normalizeArtifactLocalPath(node.url)
          if (path) return [{ ...node, url: `file:///${path}` }]
        }
        if (!NON_LINKABLE_MARKDOWN_NODES.has(node?.type)) visit(node)
        return [node]
      })
    }
    visit(tree)
  }
}
