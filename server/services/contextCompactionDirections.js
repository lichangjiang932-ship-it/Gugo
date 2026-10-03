/** Locate the host-authored direction section without treating it as authority. */
export function compactionDirectionSection(value) {
  const text = String(value || '')
  const start = text.search(/^##\s+1\.\s+User direction \(verbatim\)\s*$/mu)
  const end = text.search(/^##\s+2\.\s+/mu)
  if (start < 0 || end <= start) return null
  return { prefix: text.slice(0, end).trimEnd(), section: text.slice(start, end), remainder: text.slice(end) }
}

export function inheritedCompactionDirections(message) {
  if (message?.role !== 'assistant' || message?.meta?.compaction !== true) return []
  const block = compactionDirectionSection(message.content)
  if (!block) return []
  return [...block.section.matchAll(/<user-message index="\d+">\n([\s\S]*?)\n<\/user-message>/gu)]
    .map((match) => match[1])
}
