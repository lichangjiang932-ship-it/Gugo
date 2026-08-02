export function parseKeyValueLines(source) {
  const result = {}
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) {
      const error = new Error('MCP_KEY_VALUE_LINE_INVALID')
      error.line = index + 1
      throw error
    }
    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      const error = new Error('MCP_KEY_VALUE_KEY_INVALID')
      error.line = index + 1
      throw error
    }
    result[key] = line.slice(separator + 1).trim()
  }
  return result
}

export function serializeKeyValueLines(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${key}=${String(entry ?? '')}`)
    .join('\n')
}
