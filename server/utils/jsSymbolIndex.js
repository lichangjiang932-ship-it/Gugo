/**
 * AST-accurate declaration lookup for JavaScript-family files.
 *
 * The ripgrep pass in front of this module is fast but matches *shaped text*: it
 * reports `function foo` inside a string or a comment, and it misses class and
 * object methods entirely. For `.js`/`.mjs`/`.cjs` candidates the matches are
 * confirmed against a real parse, while every other language keeps the existing
 * pattern behaviour.
 *
 * `parseScriptAst` returns null when the source does not parse (vendor syntax,
 * newer-than-parser syntax, TypeScript in a `.js` file). The caller then keeps
 * the pattern result instead of dropping findings it cannot verify.
 */
import { parse } from 'acorn'

const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])
// Node keys that are never child nodes; walking them wastes time and can loop.
const NON_CHILD_KEYS = new Set(['loc', 'start', 'end', 'range', 'parent', 'raw'])

function extensionOf(file) {
  const name = String(file || '')
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase().split(/[?#]/u)[0]
}

export function isJavaScriptPath(file) {
  return JAVASCRIPT_EXTENSIONS.has(extensionOf(file))
}

export function parseScriptAst(source) {
  const options = {
    ecmaVersion: 'latest',
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
    locations: true,
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
      // Never execute the code; the pattern result stands for this file.
      return null
    }
  }
}

function declaredName(node) {
  const id = node?.id
  if (id?.type === 'Identifier') return String(id.name || '')
  return ''
}

function propertyName(node) {
  const key = node?.key
  if (!key) return ''
  if (key.type === 'Identifier') return String(key.name || '')
  if (key.type === 'Literal') return String(key.value ?? '')
  return ''
}

function isFunctionNode(node) {
  return node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression'
}

function isClassNode(node) {
  return node?.type === 'ClassExpression'
}

/**
 * Record one declaration if it carries the requested name and kind.
 * `kind` of 'all' accepts every kind.
 */
function collect(node, { name, kind }, out, seen) {
  if (!node || typeof node !== 'object' || seen.has(node)) return
  seen.add(node)
  const record = (declaredKind) => {
    if (kind !== 'all' && kind !== declaredKind) return
    out.push({ name, kind: declaredKind, line: node.loc?.start?.line || 0 })
  }

  switch (node.type) {
    case 'FunctionDeclaration':
      if (declaredName(node) === name) record('function')
      break
    case 'FunctionExpression':
      // A named function expression binds its own name.
      if (declaredName(node) === name) record('function')
      break
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (declaredName(node) === name) record('class')
      break
    case 'VariableDeclarator':
      if (declaredName(node) === name) {
        if (isFunctionNode(node.init)) record('function')
        else if (isClassNode(node.init)) record('class')
        else if (node.init) record('const')
      }
      break
    case 'MethodDefinition':
    case 'PropertyDefinition':
      if (propertyName(node) === name) {
        const value = node.value
        record(node.type === 'MethodDefinition' || isFunctionNode(value) ? 'function' : 'const')
      }
      break
    case 'Property':
      // `{ handler() {} }` and `{ handler: () => {} }` are both functions; a
      // plain `{ handler: 1 }` is a value binding.
      if (propertyName(node) === name && (node.method === true || isFunctionNode(node.value))) {
        record('function')
      }
      break
    default:
      break
  }

  for (const [key, value] of Object.entries(node)) {
    if (NON_CHILD_KEYS.has(key)) continue
    if (Array.isArray(value)) {
      for (const item of value) collect(item, { name, kind }, out, seen)
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      collect(value, { name, kind }, out, seen)
    }
  }
}

/** Every declaration of `name` in `source`, in source order, or null if unparsable. */
export function extractDeclarations(source, { name, kind = 'all' } = {}) {
  const ast = parseScriptAst(source)
  if (!ast) return null
  const out = []
  collect(ast, { name, kind }, out, new Set())
  return out
}

function definitionLine(source, line) {
  const lines = String(source || '').split('\n')
  return String(lines[line - 1] || '').trim()
}

function contextBefore(source, line) {
  const lines = String(source || '').split('\n')
  const previous = lines[line - 2]
  return previous == null ? [] : [{ line: line - 1, text: String(previous) }]
}

/**
 * Confirm ripgrep's candidate matches against a real parse for JS files.
 *
 * `readFile(file)` returns the file's source (or null when it cannot be read).
 * A file that yields no declaration for the name drops its pattern matches, so a
 * name that only appears in a string, a comment, or a call site stops being
 * reported as a definition.
 */
export function refineSymbolMatches(matches = [], { name, kind = 'all', readFile } = {}) {
  if (typeof readFile !== 'function') return matches
  const byFile = new Map()
  for (const match of matches) {
    if (!byFile.has(match.file)) byFile.set(match.file, [])
    byFile.get(match.file).push(match)
  }

  const refined = []
  for (const [file, fileMatches] of byFile) {
    if (!isJavaScriptPath(file)) {
      refined.push(...fileMatches)
      continue
    }
    let source
    try { source = String(readFile(file) ?? '') } catch { source = '' }
    const declarations = source ? extractDeclarations(source, { name, kind }) : null
    if (!declarations) {
      // Unreadable or unparsable: the pattern result is the best available.
      refined.push(...fileMatches)
      continue
    }
    for (const declaration of declarations) {
      const line = declaration.line
      if (!line) continue
      refined.push({
        file,
        line,
        // Column is not needed by the tool's contract; keep it stable.
        col: 1,
        text: definitionLine(source, line),
        definition: definitionLine(source, line),
        submatches: [],
        context_before: contextBefore(source, line),
        astKind: declaration.kind,
      })
    }
  }
  return refined
    .sort((left, right) => (
      String(left.file).localeCompare(String(right.file)) || left.line - right.line
    ))
    .filter((match, index, all) => (
      all.findIndex((other) => other.file === match.file && other.line === match.line) === index
    ))
}
