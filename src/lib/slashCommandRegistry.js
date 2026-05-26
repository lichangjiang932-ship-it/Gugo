const RECENT_STORAGE_KEY = 'yma:slash:recent'
const RECENT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_RECENT = 5

function defaultStorage() {
  if (typeof window === 'undefined') return null
  return window.localStorage || null
}

export function normalizeSlashCommandName(raw) {
  return String(raw || '')
    .trim()
    .replace(/^\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function parseSlashCommandInput(value) {
  const text = String(value || '').trim()
  const match = text.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  return {
    name: normalizeSlashCommandName(match[1]),
    args: (match[2] || '').trim(),
    raw: text,
  }
}

function sourceRank(source) {
  return source === 'core' ? 0 : 1
}

function matchesQuery(entry, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  const fields = [
    entry.name,
    entry.description,
    entry.hint,
    entry.meta?.displayName,
  ].map((v) => String(v || '').toLowerCase())
  return fields.some((field) => field.includes(q) || isSubsequence(q, field))
}

function matchScore(entry, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return 0
  const name = String(entry.name || '').toLowerCase()
  const displayName = String(entry.meta?.displayName || '').toLowerCase()
  const description = String(entry.description || '').toLowerCase()
  if (name === q) return 100
  if (name.startsWith(q)) return 90
  if (displayName.startsWith(q)) return 80
  if (name.includes(q)) return 70
  if (displayName.includes(q)) return 60
  if (description.includes(q)) return 40
  if (isSubsequence(q, name)) return 30
  if (isSubsequence(q, displayName)) return 20
  return 10
}

function isSubsequence(needle, haystack) {
  if (!needle) return true
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1
    if (i === needle.length) return true
  }
  return false
}

export class SlashCommandRegistry {
  constructor({ storage = defaultStorage(), now = () => Date.now() } = {}) {
    this.commands = new Map()
    this.storage = storage
    this.now = now
  }

  register(cmd, source = 'core') {
    if (source !== 'core' && source !== 'plugin') {
      throw new Error(`invalid slash command source: ${source}`)
    }
    const name = normalizeSlashCommandName(cmd?.name)
    if (!name) throw new Error('slash command name is required')
    if (!cmd?.description) throw new Error(`slash command /${name} missing description`)
    if (typeof cmd?.handler !== 'function') throw new Error(`slash command /${name} missing handler`)

    const existing = this.commands.get(name)
    if (existing?.source === 'core' && source !== 'core') {
      return existing
    }

    const entry = {
      ...cmd,
      name,
      source,
      description: String(cmd.description || ''),
      hint: cmd.hint ? String(cmd.hint) : '',
      meta: cmd.meta || {},
    }
    this.commands.set(name, entry)
    return entry
  }

  unregister(name) {
    return this.commands.delete(normalizeSlashCommandName(name))
  }

  clearSource(source) {
    let count = 0
    for (const [name, entry] of this.commands.entries()) {
      if (entry.source === source) {
        this.commands.delete(name)
        count += 1
      }
    }
    return count
  }

  clearKind(kind) {
    let count = 0
    for (const [name, entry] of this.commands.entries()) {
      if (entry.kind === kind) {
        this.commands.delete(name)
        count += 1
      }
    }
    return count
  }

  getCommand(name) {
    return this.commands.get(normalizeSlashCommandName(name)) || null
  }

  listCommands({ query = '' } = {}) {
    const recent = this.readRecent()
    const recentRank = new Map(recent.map((item, index) => [item.name, index]))
    return Array.from(this.commands.values())
      .filter((entry) => matchesQuery(entry, query))
      .sort((a, b) => {
        const ar = recentRank.has(a.name) ? recentRank.get(a.name) : Infinity
        const br = recentRank.has(b.name) ? recentRank.get(b.name) : Infinity
        if (ar !== br) return ar - br
        if (query) {
          const scoreDiff = matchScore(b, query) - matchScore(a, query)
          if (scoreDiff !== 0) return scoreDiff
        }
        const sourceDiff = sourceRank(a.source) - sourceRank(b.source)
        if (sourceDiff !== 0) return sourceDiff
        return a.name.localeCompare(b.name)
      })
  }

  recordRecent(name) {
    const normalized = normalizeSlashCommandName(name)
    if (!this.getCommand(normalized)) return []
    const now = this.now()
    const next = [
      { name: normalized, usedAt: now },
      ...this.readRecent().filter((item) => item.name !== normalized),
    ].slice(0, MAX_RECENT)
    this.writeRecent(next)
    return next
  }

  readRecent() {
    if (!this.storage) return []
    try {
      const parsed = JSON.parse(this.storage.getItem(RECENT_STORAGE_KEY) || '[]')
      if (!Array.isArray(parsed)) return []
      const cutoff = this.now() - RECENT_TTL_MS
      const seen = new Set()
      const kept = []
      for (const item of parsed) {
        const name = normalizeSlashCommandName(item?.name)
        const usedAt = Number(item?.usedAt)
        if (!name || !Number.isFinite(usedAt) || usedAt < cutoff || seen.has(name)) continue
        if (!this.getCommand(name)) continue
        seen.add(name)
        kept.push({ name, usedAt })
        if (kept.length >= MAX_RECENT) break
      }
      if (kept.length !== parsed.length) this.writeRecent(kept)
      return kept
    } catch {
      return []
    }
  }

  writeRecent(items) {
    if (!this.storage) return
    try {
      this.storage.setItem(RECENT_STORAGE_KEY, JSON.stringify(items))
    } catch {
      // Ignore storage failures; slash commands still work without recency.
    }
  }
}

export function createSlashCommandRegistry(options) {
  return new SlashCommandRegistry(options)
}

export const slashCommandRegistry = createSlashCommandRegistry()

