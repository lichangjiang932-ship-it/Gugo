/** Shared deterministic lexical representation and scoring; no storage or network access. */
import { blendMemoryScores } from './memoryEmbeddingService.js'

const MAX_QUERY_TERMS = 24
const BODY_LENGTH_REFERENCE_CHARS = 600

export function normalizedSearchText(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

export function memoryQueryTerms(query) {
  const normalized = normalizedSearchText(query)
  if (!normalized) return []
  const terms = new Set([normalized])
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) || []
  for (const word of words) {
    if (word.length > 1) terms.add(word)
    for (const run of word.match(/\p{Script=Han}+/gu) || []) {
      if (run.length < 3) continue
      for (let index = 0; index < run.length - 1; index += 1) terms.add(run.slice(index, index + 2))
    }
  }
  return [...terms].filter(Boolean).sort((a, b) => b.length - a.length).slice(0, MAX_QUERY_TERMS)
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0
  let count = 0
  let offset = 0
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1
    offset += Math.max(needle.length, 1)
    if (count >= 8) break
  }
  return count
}

export function scoreMemoryRelevance(memory, query) {
  const fullQuery = normalizedSearchText(query)
  const terms = memoryQueryTerms(query)
  if (!fullQuery || !terms.length || !memory) return 0
  const title = normalizedSearchText(memory.title)
  const slug = normalizedSearchText(memory.slug)
  const body = normalizedSearchText(memory.body)
  const type = normalizedSearchText(memory.type)
  const tags = Array.isArray(memory.frontmatter?.tags)
    ? memory.frontmatter.tags.map(normalizedSearchText).filter(Boolean) : []
  let score = 0
  const bodyLengthFactor = 1 / (1 + Math.max(0, Math.log10(body.length / BODY_LENGTH_REFERENCE_CHARS)))
  if (title === fullQuery) score += 140
  else if (title.includes(fullQuery)) score += 80
  if (slug === fullQuery) score += 90
  else if (slug.includes(fullQuery)) score += 45
  if (body.includes(fullQuery)) score += (36 + Math.min(12, countOccurrences(body, fullQuery) * 2)) * bodyLengthFactor
  if (tags.includes(fullQuery)) score += 70
  let matchedTerms = 0
  for (const term of terms) {
    let matched = false
    if (title === term) { score += 32; matched = true }
    else if (title.includes(term)) { score += 22; matched = true }
    if (slug === term) { score += 24; matched = true }
    else if (slug.includes(term)) { score += 12; matched = true }
    if (body.includes(term)) {
      score += (7 + Math.min(9, countOccurrences(body, term))) * bodyLengthFactor
      matched = true
    }
    if (tags.some((tag) => tag === term || tag.includes(term))) { score += 18; matched = true }
    if (type === term) { score += 8; matched = true }
    if (matched) matchedTerms += 1
  }
  if (!matchedTerms) return 0
  const coverage = matchedTerms / terms.length
  score += coverage * 24
  if (coverage === 1) score += 12
  return Math.round(score * 1000) / 1000
}

export function compareMemoryRelevance(left, right, { keepPinned = false } = {}) {
  const recency = (memory) => Number(memory.lastUsedAt || memory.updatedAt || memory.createdAt || 0)
  return (keepPinned ? Number(right.memory.pinned) - Number(left.memory.pinned) : 0)
    || right.score - left.score
    || recency(right.memory) - recency(left.memory)
    || String(left.memory.id).localeCompare(String(right.memory.id))
}

export function rankMemoriesByQuery(memories, query, { keepPinned = false, similarityById = null } = {}) {
  return memories.map((memory) => ({ memory, score: blendMemoryScores({
    lexicalScore: scoreMemoryRelevance(memory, query), similarity: similarityById?.get(memory.id) ?? null,
  }) }))
    .filter(({ memory, score }) => score > 0 || (keepPinned && memory.pinned))
    .sort((a, b) => compareMemoryRelevance(a, b, { keepPinned }))
}
