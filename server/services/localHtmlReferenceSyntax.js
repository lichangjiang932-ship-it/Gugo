import { parse } from 'acorn'

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

function stripQueryAndFragment(value) {
  const text = String(value || '').trim()
  const marker = text.search(/[?#]/)
  return marker >= 0 ? text.slice(0, marker) : text
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
    } else if (node.type === 'ArrayExpression') {
      // JS-driven galleries declare their media in array literals (for example
      // var images = ['a.jpg', 'b.png']) and assign img.src later from a
      // variable, which static property scans cannot follow. Collect only
      // bare media filenames with no spaces or separators so descriptive
      // strings such as 'a.jpg missing' cannot widen the dependency graph.
      for (const element of node.elements) {
        if (element?.type === 'Literal' && typeof element.value === 'string'
          && /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(element.value)
          && isStaticLocalResourceShape(element.value)
          && /^[A-Za-z0-9._/\\-]+$/.test(element.value)) {
          references.push({ value: element.value, kind: 'image' })
        }
      }
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

export {
  WINDOWS_PATH_PATTERN,
  scriptReferences,
  srcsetReferences,
  stripQueryAndFragment,
}
