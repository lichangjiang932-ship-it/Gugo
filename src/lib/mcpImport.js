/**
 * Paste-JSON import for MCP servers.
 *
 * Accepts the config shapes users already have on disk from other MCP hosts:
 * - Claude Desktop / standard: `{ "mcpServers": { "<name>": { command, args, env } } }`
 * - VS Code style: `{ "servers": { ... } }` or `{ "mcp": { "servers": { ... } } }`
 * - Bare name map: `{ "<name>": { command | url, ... } }`
 * - Single server object or an array of server objects
 *
 * Returns a normalized list ready for the editor/upsert payload; throws a
 * descriptive Error when nothing recognizable is found.
 */

const REMOTE_TYPES = new Set(['http', 'sse', 'streamable-http', 'streamable_http', 'ws'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function coerceStringMap(value) {
  if (!isPlainObject(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue
    out[String(key)] = typeof item === 'string' ? item : String(item)
  }
  return out
}

function normalizeArgs(args) {
  if (Array.isArray(args)) return args.map((item) => String(item))
  if (typeof args === 'string') return args.trim().split(/\s+/).filter(Boolean)
  return []
}

function looksLikeServerEntry(value) {
  return isPlainObject(value)
    && (typeof value.command === 'string'
      || typeof value.url === 'string'
      || typeof value.type === 'string')
}

function normalizeServer(raw, fallbackName = '') {
  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  const remote = REMOTE_TYPES.has(type) || (!raw.command && url.startsWith('http'))
  const name = String(raw.name || fallbackName || '').trim()
  const base = {
    name,
    transport: remote ? (type === 'sse' ? 'sse' : 'http') : 'stdio',
    enabled: true,
    autoApprove: Array.isArray(raw.autoApprove) ? raw.autoApprove.map(String) : [],
  }
  if (remote) {
    return {
      ...base,
      command: '',
      args: [],
      env: {},
      cwd: '',
      url,
      headers: coerceStringMap(raw.headers),
    }
  }
  return {
    ...base,
    command: String(raw.command || '').trim(),
    args: normalizeArgs(raw.args),
    env: coerceStringMap(raw.env),
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    url: '',
    headers: {},
  }
}

function collectFromMap(map) {
  const servers = []
  const warnings = []
  for (const [name, entry] of Object.entries(map)) {
    if (!isPlainObject(entry)) {
      warnings.push(name)
      continue
    }
    servers.push(normalizeServer({ ...entry, name: entry.name || name }, name))
  }
  return { servers, warnings }
}

export function parseMcpImportJson(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${error.message}`, { cause: error })
  }

  // Claude Desktop / standard wrapper
  if (isPlainObject(parsed) && isPlainObject(parsed.mcpServers)) {
    return collectFromMap(parsed.mcpServers)
  }
  // VS Code style wrappers
  if (isPlainObject(parsed) && isPlainObject(parsed.servers)) {
    return collectFromMap(parsed.servers)
  }
  if (isPlainObject(parsed) && isPlainObject(parsed.mcp?.servers)) {
    return collectFromMap(parsed.mcp.servers)
  }
  // Single server object (with or without a name)
  if (looksLikeServerEntry(parsed)) {
    return { servers: [normalizeServer(parsed)], warnings: [] }
  }
  // Array of server objects
  if (Array.isArray(parsed) && parsed.every(looksLikeServerEntry)) {
    return { servers: parsed.map((entry) => normalizeServer(entry)), warnings: [] }
  }
  // Bare name map: every value must look like a server entry
  if (isPlainObject(parsed)) {
    const values = Object.values(parsed)
    if (values.length > 0 && values.every(looksLikeServerEntry)) {
      return collectFromMap(parsed)
    }
  }

  throw new Error('no recognizable MCP server entries found')
}
