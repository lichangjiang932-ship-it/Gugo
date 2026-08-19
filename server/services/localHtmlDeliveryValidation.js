import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'acorn'
import { JSDOM } from 'jsdom'
import sharp from 'sharp'
import {
  htmlPreviewRemoteImageOrigins,
  isAllowedHtmlPreviewRemoteImage,
} from './htmlPreviewRemoteImagePolicy.js'

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
const JS_RESOURCE_PROPERTIES = new Map([
  ['src', 'resource'],
  ['srcset', 'srcset'],
  ['poster', 'image'],
  ['href', 'resource'],
  ['data', 'resource'],
])
const MAX_STATIC_VALUE_DEPTH = 24
const MAX_STATIC_STRING_CHOICES = 256
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

function classifyReference(rawValue, {
  referenceKind = 'resource',
  remoteImageOrigins = [],
  sourceLabel = 'HTML',
} = {}) {
  const value = String(rawValue || '').trim()
  if (!value || value.startsWith('#')) return null
  if (/^(?:data|blob|about|mailto|tel):/i.test(value)) return null
  if (/^(?:https?:)?\/\//i.test(value)) {
    if (referenceKind === 'image' && isAllowedHtmlPreviewRemoteImage(value, remoteImageOrigins)) {
      return { external: true, value }
    }
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

function canonicalResourcePath({
  rootDirectory,
  ownerPath,
  reference,
  referenceKind,
  remoteImageOrigins,
  sourceLabel,
}) {
  const classified = classifyReference(reference, { referenceKind, remoteImageOrigins, sourceLabel })
  if (!classified || classified.external) return null
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

function readResourceFile({
  rootDirectory,
  ownerPath,
  reference,
  referenceKind,
  remoteImageOrigins,
  sourceLabel,
  resolveReadPath,
}) {
  const resolved = canonicalResourcePath({
    rootDirectory,
    ownerPath,
    reference,
    referenceKind,
    remoteImageOrigins,
    sourceLabel,
  })
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

function parseScriptAst(source) {
  const options = {
    ecmaVersion: 'latest',
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
  }
  try {
    return parse(source, { ...options, sourceType: 'module' })
  } catch {
    try {
      return parse(source, {
        ...options,
        sourceType: 'script',
        allowReturnOutsideFunction: true,
      })
    } catch {
      // Existing regex extraction remains available for syntactically invalid,
      // vendor-specific, or newer-than-parser scripts. Never execute the code.
      return null
    }
  }
}

function staticPropertyName(node) {
  if (!node) return ''
  if (!node.computed && node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? ''
  }
  return ''
}

function forEachScriptChild(node, visit) {
  for (const [key, value] of Object.entries(node || {})) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && typeof child.type === 'string') visit(child)
      }
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      visit(value)
    }
  }
}

function declaredPatternNames(pattern, names = []) {
  if (!pattern) return names
  if (pattern.type === 'Identifier') {
    names.push(pattern.name)
  } else if (pattern.type === 'RestElement') {
    declaredPatternNames(pattern.argument, names)
  } else if (pattern.type === 'AssignmentPattern') {
    declaredPatternNames(pattern.left, names)
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements || []) declaredPatternNames(element, names)
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties || []) {
      declaredPatternNames(property?.type === 'Property' ? property.value : property?.argument, names)
    }
  }
  return names
}

function createScriptScope(parent, kind) {
  return { parent, kind, bindings: new Map() }
}

function addScriptBinding(scope, name, binding) {
  if (!scope || !name) return
  const next = { ...binding, scope }
  if (scope.bindings.has(name)) {
    scope.bindings.set(name, { kind: 'ambiguous', init: null, availableAfter: Number.POSITIVE_INFINITY, scope })
    return
  }
  scope.bindings.set(name, next)
}

function addUnavailablePatternBindings(scope, pattern) {
  for (const name of declaredPatternNames(pattern)) {
    addScriptBinding(scope, name, {
      kind: 'unavailable',
      init: null,
      availableAfter: Number.POSITIVE_INFINITY,
    })
  }
}

function nearestFunctionScope(scope) {
  let current = scope
  while (current?.parent && current.kind !== 'function' && current.kind !== 'program') current = current.parent
  return current
}

function buildStaticScopeIndex(ast) {
  const scopeByNode = new WeakMap()
  const root = createScriptScope(null, 'program')

  const visit = (node, scope) => {
    if (!node || typeof node !== 'object') return

    if (node.type === 'Program') {
      scopeByNode.set(node, root)
      for (const child of node.body || []) visit(child, root)
      return
    }

    if (node.type === 'FunctionDeclaration'
      || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression') {
      scopeByNode.set(node, scope)
      if (node.type === 'FunctionDeclaration' && node.id?.name) {
        addScriptBinding(scope, node.id.name, {
          kind: 'unavailable',
          init: null,
          availableAfter: Number.POSITIVE_INFINITY,
        })
      }
      const functionScope = createScriptScope(scope, 'function')
      if (node.id?.name) addUnavailablePatternBindings(functionScope, node.id)
      for (const parameter of node.params || []) addUnavailablePatternBindings(functionScope, parameter)
      for (const parameter of node.params || []) visit(parameter, functionScope)
      visit(node.body, functionScope)
      return
    }

    if (node.type === 'BlockStatement' || node.type === 'StaticBlock') {
      const blockScope = createScriptScope(scope, 'block')
      scopeByNode.set(node, blockScope)
      for (const child of node.body || []) visit(child, blockScope)
      return
    }

    if (node.type === 'CatchClause') {
      const catchScope = createScriptScope(scope, 'block')
      scopeByNode.set(node, catchScope)
      addUnavailablePatternBindings(catchScope, node.param)
      visit(node.param, catchScope)
      visit(node.body, catchScope)
      return
    }

    if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      const loopScope = createScriptScope(scope, 'block')
      scopeByNode.set(node, loopScope)
      forEachScriptChild(node, (child) => visit(child, loopScope))
      return
    }

    if (node.type === 'SwitchStatement') {
      const switchScope = createScriptScope(scope, 'block')
      scopeByNode.set(node, switchScope)
      forEachScriptChild(node, (child) => visit(child, switchScope))
      return
    }

    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      scopeByNode.set(node, scope)
      if (node.type === 'ClassDeclaration' && node.id?.name) addUnavailablePatternBindings(scope, node.id)
      const classScope = createScriptScope(scope, 'block')
      if (node.id?.name) addUnavailablePatternBindings(classScope, node.id)
      forEachScriptChild(node, (child) => visit(child, classScope))
      return
    }

    scopeByNode.set(node, scope)
    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers || []) addUnavailablePatternBindings(scope, specifier.local)
    } else if (node.type === 'VariableDeclaration') {
      const bindingScope = node.kind === 'var' ? nearestFunctionScope(scope) : scope
      for (const declaration of node.declarations || []) {
        const isStaticConst = node.kind === 'const'
          && declaration?.id?.type === 'Identifier'
          && declaration.init
        if (isStaticConst) {
          addScriptBinding(bindingScope, declaration.id.name, {
            kind: 'const',
            init: declaration.init,
            availableAfter: Number(declaration.end) || Number.POSITIVE_INFINITY,
          })
        } else {
          addUnavailablePatternBindings(bindingScope, declaration?.id)
        }
      }
    } else if (node.type === 'ClassDeclaration' || node.type === 'FunctionDeclaration') {
      addUnavailablePatternBindings(scope, node.id)
    }
    forEachScriptChild(node, (child) => visit(child, scope))
  }

  visit(ast, root)
  return { root, scopeByNode }
}

function resolveStaticBinding(scopeIndex, node) {
  const name = node?.type === 'Identifier' ? node.name : ''
  const referenceStart = Number(node?.start)
  if (!name || !Number.isFinite(referenceStart)) return null
  let scope = scopeIndex.scopeByNode.get(node) || scopeIndex.root
  while (scope) {
    if (scope.bindings.has(name)) {
      const binding = scope.bindings.get(name)
      if (binding.kind !== 'const'
        || !binding.init
        || binding.availableAfter > referenceStart) return null
      return binding
    }
    scope = scope.parent
  }
  return null
}

function combineStaticStrings(left, right) {
  const combined = []
  for (const leftValue of left) {
    for (const rightValue of right) {
      combined.push(`${leftValue}${rightValue}`)
      if (combined.length >= MAX_STATIC_STRING_CHOICES) return combined
    }
  }
  return combined
}

function staticStringValues(node, scopeIndex, seen = new Set(), depth = 0) {
  if (!node || depth > MAX_STATIC_VALUE_DEPTH) return []
  if (node.type === 'Literal') return typeof node.value === 'string' ? [node.value] : []
  if (node.type === 'TemplateLiteral') {
    let values = ['']
    for (let index = 0; index < node.quasis.length; index += 1) {
      const quasi = node.quasis[index]
      values = combineStaticStrings(values, [quasi?.value?.cooked ?? quasi?.value?.raw ?? ''])
      if (index < node.expressions.length) {
        const expressionValues = staticStringValues(node.expressions[index], scopeIndex, seen, depth + 1)
        if (expressionValues.length === 0) return []
        values = combineStaticStrings(values, expressionValues)
      }
    }
    return values
  }
  if (node.type === 'Identifier') {
    const binding = resolveStaticBinding(scopeIndex, node)
    if (!binding) return []
    if (seen.has(binding)) return []
    const nextSeen = new Set(seen)
    nextSeen.add(binding)
    return staticStringValues(binding.init, scopeIndex, nextSeen, depth + 1)
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return combineStaticStrings(
      staticStringValues(node.left, scopeIndex, seen, depth + 1),
      staticStringValues(node.right, scopeIndex, seen, depth + 1),
    )
  }
  if (node.type === 'ConditionalExpression') {
    return [
      ...staticStringValues(node.consequent, scopeIndex, seen, depth + 1),
      ...staticStringValues(node.alternate, scopeIndex, seen, depth + 1),
    ].slice(0, MAX_STATIC_STRING_CHOICES)
  }
  if (node.type === 'LogicalExpression') {
    return [
      ...staticStringValues(node.left, scopeIndex, seen, depth + 1),
      ...staticStringValues(node.right, scopeIndex, seen, depth + 1),
    ].slice(0, MAX_STATIC_STRING_CHOICES)
  }
  if (node.type === 'SequenceExpression') {
    return staticStringValues(node.expressions.at(-1), scopeIndex, seen, depth + 1)
  }
  if (node.type === 'MemberExpression') {
    const property = staticPropertyName(node.property)
    let owner = node.object
    let ownerSeen = seen
    while (owner?.type === 'Identifier') {
      const binding = resolveStaticBinding(scopeIndex, owner)
      if (!binding || ownerSeen.has(binding)) return []
      ownerSeen = new Set(ownerSeen)
      ownerSeen.add(binding)
      owner = binding.init
    }
    if (owner?.type === 'ObjectExpression' && property) {
      const matching = owner.properties.find((item) => item?.type === 'Property'
        && item.kind === 'init'
        && staticPropertyName(item.key) === property)
      return staticStringValues(matching?.value, scopeIndex, ownerSeen, depth + 1)
    }
    if (owner?.type === 'ArrayExpression' && /^\d+$/.test(property)) {
      return staticStringValues(owner.elements[Number(property)], scopeIndex, ownerSeen, depth + 1)
    }
  }
  return []
}

function isStaticLocalResourceShape(value) {
  const raw = String(value || '').trim()
  if (!raw || raw.startsWith('#')) return false
  if (/^(?:data|blob|about|mailto|tel):/i.test(raw)) return false
  if (/^(?:https?:)?\/\//i.test(raw)) return false
  if (/^(?:file|gugo-asset|attachment):/i.test(raw)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !WINDOWS_PATH_PATTERN.test(raw)) return false

  const withoutSuffix = stripQueryAndFragment(raw)
  if (!withoutSuffix) return false
  let decoded = withoutSuffix
  try {
    decoded = decodeURIComponent(withoutSuffix)
  } catch {
    // A malformed but clearly path-like value must still reach the normal
    // classifier so it is rejected instead of silently widening the preview.
  }
  const normalized = decoded.replaceAll('\\', '/')
  if (/^\.{1,2}\//.test(normalized) || WINDOWS_PATH_PATTERN.test(decoded)) return true
  const filename = normalized.split('/').pop() || ''
  return /\.[a-z0-9][a-z0-9._-]{0,15}$/i.test(filename)
}

function appendStaticResourceReferences(references, node, kind, scopeIndex, { localShapeOnly = false } = {}) {
  const values = staticStringValues(node, scopeIndex)
  for (const value of values) {
    if (kind === 'srcset') {
      for (const candidate of srcsetReferences(value)) {
        if (!localShapeOnly || isStaticLocalResourceShape(candidate)) {
          references.push({ value: candidate, kind: 'resource' })
        }
      }
    } else {
      if (!localShapeOnly || isStaticLocalResourceShape(value)) references.push({ value, kind })
    }
  }
}

function astScriptReferences(source) {
  const ast = parseScriptAst(source)
  if (!ast) return []
  const scopeIndex = buildStaticScopeIndex(ast)
  const references = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return

    if (node.type === 'Property' && node.kind === 'init') {
      const property = staticPropertyName(node.key)
      const kind = JS_RESOURCE_PROPERTIES.get(String(property).toLowerCase())
      if (kind) appendStaticResourceReferences(references, node.value, kind, scopeIndex, { localShapeOnly: true })
    } else if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression') {
      const property = staticPropertyName(node.left.property)
      const kind = JS_RESOURCE_PROPERTIES.get(String(property).toLowerCase())
      if (kind) appendStaticResourceReferences(references, node.right, kind, scopeIndex)
    } else if (node.type === 'CallExpression'
      && node.callee?.type === 'MemberExpression'
      && staticPropertyName(node.callee.property) === 'setAttribute') {
      const attributeNames = staticStringValues(node.arguments?.[0], scopeIndex)
      for (const attributeName of attributeNames) {
        const kind = JS_RESOURCE_PROPERTIES.get(String(attributeName).toLowerCase())
        if (kind) appendStaticResourceReferences(references, node.arguments?.[1], kind, scopeIndex)
      }
    }

    forEachScriptChild(node, visit)
  }
  visit(ast)
  return references
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
  references.push(...astScriptReferences(text))
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
  remoteImageOrigins = htmlPreviewRemoteImageOrigins(),
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
      referenceKind: item.kind,
      remoteImageOrigins,
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
