function parseInlineScalar(value) {
  const input = String(value || '').trim()
  if (input.length >= 2 && input.startsWith('"') && input.endsWith('"')) {
    try { return JSON.parse(input) } catch { return input.slice(1, -1) }
  }
  if (input.length >= 2 && input.startsWith("'") && input.endsWith("'")) {
    return input.slice(1, -1).replace(/''/g, "'")
  }
  return input
}

function parseBlockScalar(lines, startIndex, style, chomping) {
  const captured = []
  let index = startIndex
  while (index < lines.length) {
    const line = lines[index]
    if (line && !/^\s/.test(line)) break
    captured.push(line)
    index += 1
  }
  const indents = captured.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)?.[0].length || 0)
  const indent = indents.length ? Math.min(...indents) : 0
  const values = captured.map((line) => line ? line.slice(Math.min(indent, line.length)) : '')
  let value = style === '|'
    ? values.join('\n')
    : values.reduce((result, line, lineIndex) => {
        if (lineIndex === 0) return line
        const previous = values[lineIndex - 1]
        return result + ((!line || !previous) ? '\n' : ' ') + line
      }, '')
  if (chomping === '-') value = value.replace(/\n+$/g, '')
  else if (chomping !== '+' && captured.length) value = value.replace(/\n*$/g, '\n')
  return { value, nextIndex: index }
}

export function parseCodexSkillMarkdown(content) {
  const input = String(content || '').replace(/^\uFEFF/, '')
  const match = input.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: input }
  const lines = match[1].split(/\r?\n/)
  const meta = {}
  let index = 0
  while (index < lines.length) {
    const parsed = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(lines[index])
    index += 1
    if (!parsed) continue
    const key = parsed[1].toLowerCase()
    const block = /^([>|])([+-])?$/.exec(parsed[2].trim())
    if (block) {
      const scalar = parseBlockScalar(lines, index, block[1], block[2] || '')
      meta[key] = scalar.value
      index = scalar.nextIndex
    } else {
      meta[key] = parseInlineScalar(parsed[2])
    }
  }
  return { meta, body: match[2] }
}
