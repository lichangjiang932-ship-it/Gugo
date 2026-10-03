/**
 * Definition-shaped patterns per language, used by `find_symbol`.
 *
 * The JavaScript family no longer depends on these: its candidates are confirmed
 * against a real parse in `jsSymbolIndex.js`, because a pattern matches shaped
 * text (a definition inside a string or a comment) and cannot describe methods.
 * Every other language still needs the patterns, and they stay a heuristic.
 */
// 多语言符号识别正则(启发式,M1.5 接 tree-sitter 之前的过渡方案)
// 注意:这里只匹配"定义",不匹配引用 — 引用走 grep_code 即可
const SYMBOL_PATTERNS = {
  // JS/TS
  function: [
    String.raw`\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+__NAME__\b`,
    String.raw`\b(?:export\s+)?const\s+__NAME__\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>`,
    String.raw`\b(?:export\s+)?const\s+__NAME__\s*=\s*(?:async\s+)?function\b`,
    // Python def
    String.raw`^\s*(?:async\s+)?def\s+__NAME__\s*\(`,
    // Go func
    String.raw`^\s*func\s+(?:\([^)]+\)\s+)?__NAME__\s*\(`,
    // Rust fn
    String.raw`^\s*(?:pub\s+(?:\([^)]+\)\s+)?)?(?:async\s+)?fn\s+__NAME__\b`,
    // Java/C# method - 粗略,会漏修饰符组合,可接受
    String.raw`\b(?:public|private|protected|static|final|\s)+[\w<>\[\],?\s]+\s+__NAME__\s*\([^)]*\)\s*\{`,
  ],
  class: [
    String.raw`\b(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+__NAME__\b`,
    // Python
    String.raw`^\s*class\s+__NAME__\s*[\(:]`,
    // Rust struct/enum/trait
    String.raw`^\s*(?:pub\s+(?:\([^)]+\)\s+)?)?(?:struct|enum|trait)\s+__NAME__\b`,
    // Go type
    String.raw`^\s*type\s+__NAME__\s+(?:struct|interface)\b`,
  ],
  const: [
    String.raw`\b(?:export\s+)?(?:const|let|var)\s+__NAME__\s*=`,
    // Python module-level
    String.raw`^__NAME__\s*=\s*[^=]`,
    // Go
    String.raw`^\s*(?:const|var)\s+__NAME__\b`,
    // Rust
    String.raw`^\s*(?:pub\s+(?:\([^)]+\)\s+)?)?(?:const|static)\s+__NAME__\s*:`,
  ],
}

export function buildSymbolRegex(name, kind) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const kinds = kind === 'all' || !kind
    ? ['function', 'class', 'const']
    : [kind]
  const patterns = []
  for (const k of kinds) {
    const arr = SYMBOL_PATTERNS[k]
    if (!arr) continue
    for (const p of arr) patterns.push(p.replace(/__NAME__/g, esc))
  }
  // rg 用 | 联结成一个 PCRE-like 正则
  return patterns.map((p) => `(?:${p})`).join('|')
}
