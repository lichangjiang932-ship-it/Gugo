/**
 * AST-aware match selection for `edit_file`.
 *
 * A unique exact match is edited as before. When the same `old_string` appears
 * several times, a naive replace cannot tell which one the model meant — and a
 * string that shows up both in a comment and in real code is the common case.
 * For JavaScript-family files we confirm each occurrence against a real parse
 * and pick the one that lies in code (not inside a comment or a string/template
 * literal). Only an unambiguous single code occurrence is accepted; anything
 * else falls back to the caller's "not unique" error rather than guessing.
 *
 * Non-JavaScript files, and sources acorn cannot parse, return null so the
 * caller keeps its existing exact-match behaviour.
 */
import { parse } from 'acorn'
import { isJavaScriptPath } from './jsSymbolIndex.js'

// Node keys that are never child nodes; walking them wastes time and can loop.
const NON_CHILD_KEYS = new Set(['loc', 'start', 'end', 'range', 'parent', 'raw'])

function collectNonCodeRanges(source) {
  const comments = []
  const options = {
    ecmaVersion: 'latest',
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
    onComment: comments,
  }
  let ast
  try {
    ast = parse(source, { ...options, sourceType: 'module' })
  } catch {
    try {
      ast = parse(source, { ...options, sourceType: 'script', allowReturnOutsideFunction: true })
    } catch {
      return null
    }
  }
  const ranges = comments.map((comment) => [comment.start, comment.end])
  const stack = [ast]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') continue
    // String literals and template literal text are code-shaped but not code.
    if (node.type === 'Literal' && typeof node.value === 'string') ranges.push([node.start, node.end])
    else if (node.type === 'TemplateElement') ranges.push([node.start, node.end])
    for (const key of Object.keys(node)) {
      if (NON_CHILD_KEYS.has(key)) continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) stack.push(child)
      } else if (value && typeof value === 'object') {
        stack.push(value)
      }
    }
  }
  return ranges
}

function allOccurrences(source, text) {
  const out = []
  let index = source.indexOf(text)
  while (index !== -1) {
    out.push(index)
    index = source.indexOf(text, index + text.length)
  }
  return out
}

/**
 * The offset of the single occurrence of `text` that sits in real code, or null
 * when the file is not parseable JavaScript, or when the code occurrences are
 * anything other than exactly one.
 */
export function codeMatchOffset(file, source, text) {
  if (!text || !isJavaScriptPath(file)) return null
  const nonCode = collectNonCodeRanges(source)
  if (!nonCode) return null
  const overlapsNonCode = (start, end) => nonCode.some(([from, to]) => start < to && from < end)
  const codeHits = allOccurrences(source, text)
    .filter((index) => !overlapsNonCode(index, index + text.length))
  return codeHits.length === 1 ? codeHits[0] : null
}
