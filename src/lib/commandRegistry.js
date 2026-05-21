const BUILTIN_COMMANDS = [
  {
    id: 'clear',
    name: 'clear',
    description: 'Clear the current conversation after confirmation',
    kind: 'builtin',
    args: [],
    handler: ({ dispatch }) => {
      const ok = typeof window === 'undefined' || window.confirm?.('Clear the current conversation? This cannot be undone.')
      if (ok) dispatch({ type: 'CLEAR_CURRENT_SESSION' })
    },
  },
  {
    id: 'new',
    name: 'new',
    description: 'Start a new conversation',
    kind: 'builtin',
    args: [],
    handler: ({ dispatch, navigate }) => {
      dispatch({ type: 'NEW_SESSION' })
      navigate?.('/chat')
    },
  },
  {
    id: 'compress',
    name: 'compress',
    description: 'Compress the earlier context in the current session',
    kind: 'builtin',
    args: [],
    handler: ({ dispatch }) => dispatch({ type: 'COMPRESS_CURRENT_SESSION' }),
  },
  {
    id: 'permissions',
    name: 'permissions',
    description: 'Open permissions center',
    kind: 'builtin',
    args: [],
    handler: ({ navigate }) => navigate?.('/permissions'),
  },
  {
    id: 'settings',
    name: 'settings',
    description: 'Open settings',
    kind: 'builtin',
    args: [],
    handler: ({ navigate }) => navigate?.('/settings'),
  },
  {
    id: 'history',
    name: 'history',
    description: 'Open conversation history',
    kind: 'builtin',
    args: [],
    handler: ({ navigate }) => navigate?.('/history'),
  },
  {
    id: 'help',
    name: 'help',
    description: 'Insert a short help prompt into the composer',
    kind: 'builtin',
    args: [],
    handler: () => 'Show me available shortcuts and slash commands.',
  },
]

const dynamicCommands = new Map()

export function registerCommand(cmd) {
  if (!cmd?.id) throw new Error('command missing id')
  dynamicCommands.set(cmd.id, cmd)
}

export function unregisterCommand(id) {
  return dynamicCommands.delete(id)
}

export function unregisterByKind(kind) {
  const toRemove = []
  for (const [id, c] of dynamicCommands) {
    if (c.kind === kind) toRemove.push(id)
  }
  toRemove.forEach((id) => dynamicCommands.delete(id))
  return toRemove.length
}

export function syncSkillsToCommands(skills) {
  unregisterByKind('skill')
  for (const s of skills || []) {
    if (!s?.id) continue
    registerCommand({
      id: s.id,
      name: s.id,
      description: s.name || s.description || s.id,
      kind: 'skill',
      args: [{ name: 'prompt', type: 'string', description: 'Prompt content', default: '' }],
      handler: null,
      skill: s,
    })
  }
}

export function listCommands() {
  return [...BUILTIN_COMMANDS, ...dynamicCommands.values()]
}

export function findCommand(id) {
  if (!id) return null
  return BUILTIN_COMMANDS.find((c) => c.id === id) || dynamicCommands.get(id) || null
}

export function parseCommand(content = '') {
  const text = String(content || '')
  const match = text.match(/^\/([a-z0-9_:-]+)(?:\s+([\s\S]*))?$/i)
  if (!match) return { commandId: null, args: {}, raw: text }
  const id = match[1]
  const rest = (match[2] || '').trim()
  const cmd = findCommand(id)
  const args = {}
  if (cmd?.args?.length) {
    if (cmd.args.length === 1) {
      args[cmd.args[0].name] = rest
    } else {
      const tokens = tokenize(rest)
      let positional = 0
      for (const token of tokens) {
        const eq = token.indexOf('=')
        if (eq > 0) {
          args[token.slice(0, eq)] = strip(token.slice(eq + 1))
        } else if (positional < cmd.args.length) {
          args[cmd.args[positional].name] = strip(token)
          positional += 1
        }
      }
      for (const arg of cmd.args) {
        if (args[arg.name] === undefined && arg.default !== undefined) args[arg.name] = arg.default
      }
    }
  }
  return { commandId: id, args, raw: rest }
}

function tokenize(s) {
  const out = []
  let current = ''
  let quote = null
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) { quote = null; continue }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (current) { out.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

function strip(s) {
  return String(s).replace(/^["']|["']$/g, '')
}

export function fuzzySearch(commands, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return commands.map((cmd) => ({ cmd, score: 50 }))
  const out = []
  for (const cmd of commands) {
    const id = (cmd.id || '').toLowerCase()
    const name = (cmd.name || '').toLowerCase()
    const desc = (cmd.description || '').toLowerCase()
    let score = 0
    if (id === q || name === q) score = 100
    else if (id.startsWith(q) || name.startsWith(q)) score = 80
    else if (id.includes(q) || name.includes(q)) score = 60
    else if (desc.includes(q)) score = 30
    if (score > 0) out.push({ cmd, score })
  }
  return out.sort((a, b) => b.score - a.score)
}
