import fs from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import sharp from 'sharp'

const MAX_HTML_BYTES = 16 * 1024 * 1024
const MAX_TEXT_DEPENDENCY_BYTES = 8 * 1024 * 1024
const MAX_RESOURCE_COUNT = 2_000
const MAX_IMAGE_PIXELS = 100_000_000

const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'";]+))\s*\)/gi
const CSS_IMPORT_PATTERN = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s)'";]+))(?:\s*\))?/gi
const CSS_IMAGE_SET_PATTERN = /(?:-webkit-)?image-set\s*\(/gi
const JS_STATIC_MODULE_PATTERN = /\b(?:import\s+(?:[^"'();]*?\s+from\s+)?|export\s+[^"'();]*?\s+from\s+)["']([^"']+)["']/gi
const JS_DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`$]*)`)/gi
const JS_NEW_URL_PATTERN = /\bnew\s+URL\s*\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`$]*)`)\s*,\s*import\.meta\.url\b/gi
const JS_LOCAL_FETCH_PATTERN = /\bfetch\s*\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`$]*)`)/gi
const JS_WORKER_PATTERN = /\bnew\s+(?:Worker|SharedWorker)\s*\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`$]*)`)/gi
const JS_XHR_PATTERN = /\.\s*open\s*\(\s*(?:"(?:GET|HEAD)"|'(?:GET|HEAD)'|`(?:GET|HEAD)`)\s*,\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`$]*)`)/gi
const WINDOWS_PATH_PATTERN = /^(?:[a-z]:[\\/]|\\\\)/i
const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])
const HTML_EXTENSIONS = new Set(['.htm', '.html'])
const TEXT_DEPENDENCY_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.cjs', '.htm', '.html'])
const EXECUTABLE_SCRIPT_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'module',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
])

const HTML_RESOURCE_ATTRIBUTES = Object.freeze([
  ['audio', 'src', 'media'],
  ['embed', 'src', 'resource'],
  ['iframe', 'src', 'html'],
  ['img', 'src', 'image'],
  ['input[type="image"]', 'src', 'image'],
  ['object', 'data', 'resource'],
  ['script', 'src', 'script'],
  ['source', 'src', 'resource'],
  ['track', 'src', 'resource'],
  ['video', 'src', 'media'],
  ['video', 'poster', 'image'],
  ['svg image', 'href', 'image'],
  ['svg image', 'xlink:href', 'image'],
  ['svg use', 'href', 'resource'],
  ['svg use', 'xlink:href', 'resource'],
])

export class LocalHtmlDeliveryValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LocalHtmlDeliveryValidationError'
    this.code = code
    this.retryable = true
    this.statusCode = 422
    this.htmlDeliveryValidationFailure = true
    Object.assign(this, details)
  }
}

function invalid(code, message, details = {}) {
  throw new LocalHtmlDeliveryValidationError(code, message, details)
}

function bytesWithinLimit(value, limit, code, label) {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > limit) invalid(code, `${label} exceeds the bounded validation limit.`)
  return bytes
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function stripQueryAndFragment(value) {
  const text = String(value || '').trim()
  const marker = text.search(/[?#]/)
  return marker >= 0 ? text.slice(0, marker) : text
}

function classifyReference(rawValue, { sourceLabel = 'HTML' } = {}) {
  const value = String(rawValue || '').trim()
  if (!value || value.startsWith('#')) return null
  if (/^(?:data|blob|about|mailto|tel):/i.test(value)) return null
  if (/^(?:https?:)?\/\//i.test(value)) {
    invalid(
      'HTML_DELIVERY_REMOTE_RESOURCE_UNSUPPORTED',
      `${sourceLabel} references a remote resource that the side preview cannot load: ${value.slice(0, 160)}`,
      { reference: value },
    )
  }
  if (/^(?:gugo-asset|attachment):\/\//i.test(value)) {
    invalid(
      'HTML_DELIVERY_UNRESOLVED_RESOURCE',
      `${sourceLabel} contains an unresolved managed resource URI: ${value.slice(0, 160)}`,
      { reference: value },
    )
  }
  if (/^file:/i.test(value) || WINDOWS_PATH_PATTERN.test(value)) {
    invalid(
      'HTML_DELIVERY_LOCAL_PATH_UNSUPPORTED',
      `${sourceLabel} uses an absolute local path that the side preview cannot load: ${value.slice(0, 160)}`,
      { reference: value },
    )
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    invalid(
      'HTML_DELIVERY_ROOT_PATH_UNSUPPORTED',
      `${sourceLabel} uses a root-relative resource. Keep preview assets beside the HTML file or in its subdirectories: ${value.slice(0, 160)}`,
      { reference: value },
    )
  }
  if (value.includes('\\')) {
    invalid(
      'HTML_DELIVERY_RESOURCE_PATH_INVALID',
      `${sourceLabel} uses backslashes in a browser resource URL: ${value.slice(0, 160)}`,
      { reference: value },
    )
  }
  const withoutSuffix = stripQueryAndFragment(value)
  if (!withoutSuffix) return null
  let decoded
  try {
    decoded = decodeURIComponent(withoutSuffix)
  } catch {
    invalid('HTML_DELIVERY_RESOURCE_URL_INVALID', `${sourceLabel} contains a malformed resource URL: ${value.slice(0, 160)}`)
  }
  if (decoded.includes('\0')) {
    invalid('HTML_DELIVERY_RESOURCE_URL_INVALID', `${sourceLabel} contains an invalid resource URL.`)
  }
  return { external: false, value, decoded }
}

function canonicalResourcePath({ rootDirectory, ownerPath, reference, sourceLabel }) {
  const classified = classifyReference(reference, { sourceLabel })
  if (!classified) return null
  const candidate = path.resolve(path.dirname(ownerPath), ...classified.decoded.split('/'))
  if (!isPathInside(rootDirectory, candidate)) {
    invalid(
      'HTML_DELIVERY_RESOURCE_OUTSIDE_ROOT',
      `${sourceLabel} references a file outside the HTML preview directory: ${classified.value.slice(0, 160)}`,
      { reference: classified.value, resourcePath: candidate },
    )
  }
  return { ...classified, candidate }
}

function authorizedReadPath(candidate, resolveReadPath, context) {
  if (typeof resolveReadPath !== 'function') return candidate
  const resolved = resolveReadPath(candidate, context)
  if (resolved == null) return candidate
  const value = typeof resolved === 'string' ? resolved : resolved?.fullPath
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new TypeError('resolveReadPath must synchronously return an absolute path, { fullPath }, or undefined.')
  }
  return path.normalize(value)
}

function rethrowPathAuthorization(cause) {
  if (cause?.code === 'PATH_NOT_AUTHORIZED') throw cause
}

function readResourceFile({ rootDirectory, ownerPath, reference, sourceLabel, resolveReadPath }) {
  const resolved = canonicalResourcePath({ rootDirectory, ownerPath, reference, sourceLabel })
  if (!resolved) return null
  let canonical
  let stat
  const context = {
    role: 'dependency',
    ownerPath,
    reference: resolved.value,
    sourceLabel,
  }
  try {
    const realpathInput = authorizedReadPath(resolved.candidate, resolveReadPath, {
      ...context,
      operation: 'realpath',
    })
    canonical = fs.realpathSync(realpathInput)
    const statInput = authorizedReadPath(canonical, resolveReadPath, {
      ...context,
      operation: 'stat',
    })
    stat = fs.statSync(statInput)
  } catch (cause) {
    rethrowPathAuthorization(cause)
    invalid(
      'HTML_DELIVERY_RESOURCE_MISSING',
      `${sourceLabel} references a missing or unreadable file: ${resolved.value.slice(0, 160)}`,
      { reference: resolved.value, resourcePath: resolved.candidate, cause },
    )
  }
  if (!isPathInside(rootDirectory, canonical)) {
    invalid(
      'HTML_DELIVERY_RESOURCE_OUTSIDE_ROOT',
      `${sourceLabel} resolves outside the HTML preview directory: ${resolved.value.slice(0, 160)}`,
      { reference: resolved.value, resourcePath: canonical },
    )
  }
  if (!stat.isFile() || stat.size <= 0) {
    invalid(
      'HTML_DELIVERY_RESOURCE_INVALID',
      `${sourceLabel} references an empty file or a non-file path: ${resolved.value.slice(0, 160)}`,
      { reference: resolved.value, resourcePath: canonical },
    )
  }
  return { ...resolved, canonical, stat }
}

function imageSetBodies(source) {
  const bodies = []
  for (const match of source.matchAll(CSS_IMAGE_SET_PATTERN)) {
    const start = match.index + match[0].length
    let depth = 1
    let quote = ''
    let escaped = false
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]
      if (quote) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === quote) quote = ''
        continue
      }
      if (character === '"' || character === "'") quote = character
      else if (character === '(') depth += 1
      else if (character === ')') {
        depth -= 1
        if (depth === 0) {
          bodies.push(source.slice(start, index))
          break
        }
      }
    }
  }
  CSS_IMAGE_SET_PATTERN.lastIndex = 0
  return bodies
}

function imageSetCandidates(body) {
  const candidates = []
  let start = 0
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') depth += 1
    else if (character === ')') depth = Math.max(0, depth - 1)
    else if ((character === ',' && depth === 0) || index === body.length) {
      const item = body.slice(start, index)
      const match = item.match(/^\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/)
      if (match) candidates.push(match[1] ?? match[2])
      start = index + 1
    }
  }
  return candidates
}

function cssReferences(source) {
  const clean = String(source || '').replace(/\/\*[\s\S]*?\*\//g, '')
  const references = []
  for (const match of clean.matchAll(CSS_URL_PATTERN)) {
    references.push({ value: match[1] ?? match[2] ?? match[3], kind: 'resource' })
  }
  CSS_URL_PATTERN.lastIndex = 0
  for (const match of clean.matchAll(CSS_IMPORT_PATTERN)) {
    references.push({ value: match[1] ?? match[2] ?? match[3], kind: 'style' })
  }
  CSS_IMPORT_PATTERN.lastIndex = 0
  for (const body of imageSetBodies(clean)) {
    for (const value of imageSetCandidates(body)) references.push({ value, kind: 'image' })
  }
  return references
}

function pushScriptMatches(references, source, pattern, kind) {
  for (const match of source.matchAll(pattern)) {
    const value = match.slice(1).find((candidate) => candidate !== undefined)
    if (value !== undefined) references.push({ value, kind })
  }
  pattern.lastIndex = 0
}

function scriptReferences(source) {
  const references = []
  const text = String(source || '')
  pushScriptMatches(references, text, JS_STATIC_MODULE_PATTERN, 'script')
  pushScriptMatches(references, text, JS_DYNAMIC_IMPORT_PATTERN, 'script')
  pushScriptMatches(references, text, JS_NEW_URL_PATTERN, 'resource')
  pushScriptMatches(references, text, JS_LOCAL_FETCH_PATTERN, 'resource')
  pushScriptMatches(references, text, JS_WORKER_PATTERN, 'script')
  pushScriptMatches(references, text, JS_XHR_PATTERN, 'resource')
  return references
}

function srcsetReferences(value) {
  const source = String(value || '').trim()
  if (!source || /^data:/i.test(source)) return []
  return source.split(',').map((candidate) => candidate.trim().split(/\s+/, 1)[0]).filter(Boolean)
}

function htmlReferences(source) {
  const document = new JSDOM(source).window.document
  const references = []
  for (const [selector, attribute, kind] of HTML_RESOURCE_ATTRIBUTES) {
    for (const element of document.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute)
      if (value) references.push({ value, kind })
    }
  }
  for (const element of document.querySelectorAll('img[srcset], source[srcset]')) {
    const kind = element.closest('picture') ? 'image' : 'resource'
    for (const value of srcsetReferences(element.getAttribute('srcset'))) references.push({ value, kind })
  }
  for (const element of document.querySelectorAll('link[href]')) {
    const rel = String(element.getAttribute('rel') || '').toLowerCase().split(/\s+/)
    const kind = rel.includes('stylesheet') ? 'style'
      : rel.some((value) => ['icon', 'apple-touch-icon', 'mask-icon'].includes(value)) ? 'image'
        : rel.some((value) => ['preload', 'modulepreload', 'manifest'].includes(value)) ? 'resource'
          : null
    if (kind) references.push({ value: element.getAttribute('href'), kind })
  }
  for (const element of document.querySelectorAll('[style]')) {
    references.push(...cssReferences(element.getAttribute('style')))
  }
  for (const element of document.querySelectorAll('style')) references.push(...cssReferences(element.textContent))
  for (const element of document.querySelectorAll('script:not([src])')) {
    const type = String(element.getAttribute('type') || '').trim().toLowerCase().split(';', 1)[0].trim()
    if (!type || EXECUTABLE_SCRIPT_TYPES.has(type)) references.push(...scriptReferences(element.textContent))
  }
  return references
}

async function assertDecodableImage(file, label) {
  try {
    const options = { animated: true, failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }
    const metadata = await sharp(file.canonical, options).metadata()
    const width = Number(metadata.width)
    const height = Number(metadata.pageHeight || metadata.height)
    const pages = Number(metadata.pages || 1)
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(pages)
      || width <= 0 || height <= 0 || pages <= 0 || width * height * pages > MAX_IMAGE_PIXELS) {
      throw new Error('invalid image dimensions')
    }
    const decoded = await sharp(file.canonical, options)
      .resize({ width: 1, height: 1, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer()
    if (!decoded.length) throw new Error('image has no decodable pixels')
    return { width, height, pages }
  } catch (cause) {
    invalid(
      'HTML_DELIVERY_IMAGE_INVALID',
      `${label} references an image that cannot be decoded: ${file.value.slice(0, 160)}`,
      { reference: file.value, resourcePath: file.canonical, cause },
    )
  }
}

function resourceKind(referenceKind, filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (referenceKind === 'image' || IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (referenceKind === 'style' || extension === '.css') return 'style'
  if (referenceKind === 'script' || ['.js', '.mjs', '.cjs'].includes(extension)) return 'script'
  if (referenceKind === 'html' || HTML_EXTENSIONS.has(extension)) return 'html'
  return 'resource'
}

function readTextDependency(file, label, resolveReadPath) {
  if (file.stat.size > MAX_TEXT_DEPENDENCY_BYTES) {
    invalid('HTML_DELIVERY_DEPENDENCY_TOO_LARGE', `${label} dependency is too large to validate: ${file.value.slice(0, 160)}`)
  }
  try {
    const readPath = authorizedReadPath(file.canonical, resolveReadPath, {
      operation: 'readFile',
      role: 'dependency',
      ownerPath: file.candidate,
      reference: file.value,
      sourceLabel: label,
    })
    return fs.readFileSync(readPath, 'utf8')
  } catch (cause) {
    rethrowPathAuthorization(cause)
    invalid(
      'HTML_DELIVERY_RESOURCE_UNREADABLE',
      `${label} dependency cannot be read: ${file.value.slice(0, 160)}`,
      { reference: file.value, resourcePath: file.canonical, cause },
    )
  }
}

function completeHtmlSource(source) {
  return /<(?:!doctype\s+html|html|head|body|title|main|section|article|canvas|svg)\b/i.test(source)
}

/**
 * Validate a local/workspace HTML deliverable as the side preview will load
 * it: every local dependency must stay beneath the HTML file's directory,
 * exist as a non-empty file, and every referenced image must decode.
 * Linked CSS and static JavaScript imports are followed recursively.
 */
export async function validateLocalHtmlDelivery({
  filePath,
  source: suppliedSource,
  decodeImages = true,
  resolveReadPath,
} = {}) {
  const rawPath = String(filePath || '').trim()
  if (!rawPath || !path.isAbsolute(rawPath) || !HTML_EXTENSIONS.has(path.extname(rawPath).toLowerCase())) {
    invalid('HTML_DELIVERY_PATH_INVALID', 'Local HTML delivery validation requires an absolute .html or .htm path.')
  }
  const normalizedPath = path.normalize(rawPath)
  let canonicalHtmlPath = normalizedPath
  let source
  try {
    const realpathInput = authorizedReadPath(normalizedPath, resolveReadPath, {
      operation: 'realpath',
      role: 'entry',
      ownerPath: null,
      reference: null,
      sourceLabel: 'HTML',
    })
    canonicalHtmlPath = fs.realpathSync(realpathInput)
    const readPath = authorizedReadPath(canonicalHtmlPath, resolveReadPath, {
      operation: 'readFile',
      role: 'entry',
      ownerPath: null,
      reference: null,
      sourceLabel: 'HTML',
    })
    source = fs.readFileSync(readPath, 'utf8')
  } catch (cause) {
    rethrowPathAuthorization(cause)
    if (typeof suppliedSource !== 'string') {
      invalid('HTML_DELIVERY_FILE_UNREADABLE', 'The final HTML file cannot be reopened for delivery validation.', {
        resourcePath: normalizedPath,
        cause,
      })
    }
    source = suppliedSource
  }
  if (!source.trim()) invalid('HTML_DELIVERY_FILE_EMPTY', 'The final HTML file is empty.')
  bytesWithinLimit(source, MAX_HTML_BYTES, 'HTML_DELIVERY_FILE_TOO_LARGE', 'The final HTML file')
  if (!completeHtmlSource(source)) {
    invalid('HTML_DELIVERY_DOCUMENT_INCOMPLETE', 'The final HTML does not contain a complete webpage structure.')
  }
  if (/<base\b[^>]*\bhref\s*=/i.test(source)) {
    invalid('HTML_DELIVERY_BASE_URL_UNSUPPORTED', 'The final HTML overrides its base URL, so side-preview resources cannot be resolved safely.')
  }

  const rootDirectory = path.dirname(canonicalHtmlPath)
  const queue = htmlReferences(source).map((reference) => ({
    ...reference,
    ownerPath: canonicalHtmlPath,
    label: 'HTML',
  }))
  const visited = new Set()
  const resources = []
  let decodedImageCount = 0

  while (queue.length > 0) {
    if (visited.size + queue.length > MAX_RESOURCE_COUNT) {
      invalid('HTML_DELIVERY_RESOURCE_LIMIT_EXCEEDED', `The HTML preview references more than ${MAX_RESOURCE_COUNT} local resources.`)
    }
    const item = queue.shift()
    const file = readResourceFile({
      rootDirectory,
      ownerPath: item.ownerPath,
      reference: item.value,
      sourceLabel: item.label,
      resolveReadPath,
    })
    if (!file) continue
    const kind = resourceKind(item.kind, file.canonical)
    const key = `${kind}\0${process.platform === 'win32' ? file.canonical.toLowerCase() : file.canonical}`
    if (visited.has(key)) continue
    visited.add(key)
    resources.push({
      path: file.canonical,
      requestPath: file.candidate,
      kind,
      size: file.stat.size,
    })

    if (kind === 'image') {
      if (decodeImages) {
        await assertDecodableImage(file, item.label)
        decodedImageCount += 1
      }
      continue
    }
    if (!TEXT_DEPENDENCY_EXTENSIONS.has(path.extname(file.canonical).toLowerCase())) continue
    const dependencySource = readTextDependency(file, item.label, resolveReadPath)
    const childReferences = kind === 'style' ? cssReferences(dependencySource)
      : kind === 'script' ? scriptReferences(dependencySource)
        : kind === 'html' ? htmlReferences(dependencySource)
          : []
    for (const reference of childReferences) {
      queue.push({
        ...reference,
        ownerPath: file.canonical,
        label: `${kind} ${path.basename(file.canonical)}`,
      })
    }
  }

  return {
    ok: true,
    filePath: canonicalHtmlPath,
    resourceCount: resources.length,
    decodedImageCount,
    resources,
  }
}
