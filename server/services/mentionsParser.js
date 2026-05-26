const PREFIX_BOUNDARY = new Set([
  '(', '[', '{', '<', '（', '【', '《', '「', '『',
  ',', '，', '.', '。', '!', '！', '?', '？', ';', '；', ':', '：',
  '\n', '\r', '\t',
])

const SUFFIX_BOUNDARY = new Set([
  ')', ']', '}', '>', '）', '】', '》', '」', '』',
  ',', '，', '.', '。', '!', '！', '?', '？', ';', '；', ':', '：',
  '\n', '\r', '\t',
])

function isPrefixBoundary(ch) {
  return !ch || /\s/u.test(ch) || PREFIX_BOUNDARY.has(ch)
}

function isSuffixBoundary(ch) {
  return !ch || /\s/u.test(ch) || SUFFIX_BOUNDARY.has(ch)
}

function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end
}

function normalizeAlias(value) {
  return String(value || '').replace(/^@+/, '').trim()
}

function aliasesForAgent(agent) {
  if (!agent) return []
  if (typeof agent === 'string') return [normalizeAlias(agent)]
  return [
    agent.handle,
    agent.name,
    agent.agentName,
    agent.id,
  ].map(normalizeAlias).filter(Boolean)
}

function buildCandidates(knownAgentHandles = []) {
  const byAlias = new Map()
  for (const agent of Array.isArray(knownAgentHandles) ? knownAgentHandles : []) {
    const id = typeof agent === 'string' ? agent : agent?.id
    if (!id) continue
    for (const alias of aliasesForAgent(agent)) {
      const key = alias.toLocaleLowerCase()
      if (!byAlias.has(key)) byAlias.set(key, new Set())
      byAlias.get(key).add(id)
    }
  }

  const candidates = []
  for (const [key, ids] of byAlias) {
    if (ids.size !== 1) continue
    const [agentId] = ids
    candidates.push({ agentId, aliasLower: key, aliasLength: key.length })
  }
  candidates.sort((a, b) => b.aliasLength - a.aliasLength)
  return candidates
}

function findMentionRange(text, lower, candidate, usedRanges) {
  let start = -1
  const needle = `@${candidate.aliasLower}`
  while ((start = lower.indexOf(needle, start + 1)) !== -1) {
    const end = start + needle.length
    const before = start > 0 ? text[start - 1] : ''
    const after = text[end] || ''
    const range = { start, end }
    if (before === '\\') continue
    if (!isPrefixBoundary(before) || !isSuffixBoundary(after)) continue
    if (usedRanges.some((used) => rangesOverlap(used, range))) continue
    return range
  }
  return null
}

export function parseMentions(text, knownAgentHandles = []) {
  const body = String(text || '')
  if (!body.includes('@')) {
    return { mentions: [], cleanedText: body.replace(/\\@/g, '@') }
  }

  const lower = body.toLocaleLowerCase()
  const candidates = buildCandidates(knownAgentHandles)
  const usedRanges = []
  const mentions = []
  const seen = new Set()

  for (const candidate of candidates) {
    let range = findMentionRange(body, lower, candidate, usedRanges)
    while (range) {
      usedRanges.push(range)
      if (!seen.has(candidate.agentId)) {
        seen.add(candidate.agentId)
        mentions.push(candidate.agentId)
      }
      range = findMentionRange(body, lower, candidate, usedRanges)
    }
  }

  usedRanges.sort((a, b) => a.start - b.start)
  let cleanedText = ''
  let cursor = 0
  for (const range of usedRanges) {
    cleanedText += body.slice(cursor, range.start)
    cursor = range.end
  }
  cleanedText += body.slice(cursor)
  cleanedText = cleanedText.replace(/\\@/g, '@').replace(/[ \t]{2,}/g, ' ').trim()

  return { mentions, cleanedText }
}
