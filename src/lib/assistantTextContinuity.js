export function mergeAssistantText(currentText = '', candidateText = '') {
  const current = String(currentText || '')
  const candidate = String(candidateText || '')
  if (!candidate) return current
  if (!current) return candidate
  if (candidate === current || current.endsWith(candidate) || current.includes(candidate)) return current
  if (candidate.startsWith(current)) return candidate

  const maxOverlap = Math.min(current.length, candidate.length)
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (current.endsWith(candidate.slice(0, size))) return `${current}${candidate.slice(size)}`
  }
  const separator = /\s$/u.test(current) || /^\s/u.test(candidate) ? '' : '\n\n'
  return `${current}${separator}${candidate}`
}

export function missingAssistantTextSuffix(currentText = '', candidateText = '') {
  const current = String(currentText || '')
  const merged = mergeAssistantText(current, candidateText)
  return merged.startsWith(current) ? merged.slice(current.length) : merged
}
