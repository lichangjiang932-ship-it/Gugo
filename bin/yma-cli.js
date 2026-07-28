#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HELP = `yma-cli — server-first CLI for Gugo

Usage:
  yma-cli login --email <email>
  yma-cli verify --email <email> --code <code>
  yma-cli session list [--archived true|false|all]
  yma-cli agent list
  yma-cli skill list
  yma-cli --help

Environment:
  SERVER_PORT   server port (default 5173)
  SERVER_HOST   server host (default 127.0.0.1)

Auth token is stored at ~/.yma-cli/token (chmod 0600).
`

function parseFlags(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    }
  }
  return out
}

function tokenDir() {
  return join(homedir(), '.yma-cli')
}
function tokenPath() {
  return join(tokenDir(), 'token')
}

function readToken() {
  const p = tokenPath()
  if (!existsSync(p)) return null
  const raw = readFileSync(p, 'utf8').trim()
  return raw || null
}

function writeToken(token) {
  const dir = tokenDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(tokenPath(), token, { mode: 0o600 })
  chmodSync(tokenPath(), 0o600)
}

function baseUrl() {
  const host = process.env.SERVER_HOST || '127.0.0.1'
  const port = process.env.SERVER_PORT || '5173'
  return `http://${host}:${port}`
}

function requireToken() {
  const token = readToken()
  if (!token) {
    process.stderr.write('Not logged in. Run: yma-cli login --email <email>\n')
    process.exit(2)
  }
  return token
}

async function apiFetch(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (auth) headers.authorization = `Bearer ${requireToken()}`
  let res
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    process.stderr.write(`Request failed: ${err.message}\n`)
    process.exit(1)
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const msg = json?.error || text || `HTTP ${res.status}`
    process.stderr.write(`Error: ${msg}\n`)
    process.exit(1)
  }
  return json
}

async function cmdLogin(flags) {
  const email = flags.email
  if (!email || email === true) {
    process.stderr.write('Missing --email\n')
    process.exit(2)
  }
  const res = await apiFetch('/api/auth/send-code', {
    method: 'POST',
    body: { email },
    auth: false,
  })
  process.stdout.write(`Sent code to ${email}.\n`)
  if (res?.devCode) {
    process.stdout.write(`devCode: ${res.devCode}\n`)
  }
  process.stdout.write(`Next: yma-cli verify --email ${email} --code <code>\n`)
}

async function cmdVerify(flags) {
  const email = flags.email
  const code = flags.code
  if (!email || email === true || !code || code === true) {
    process.stderr.write('Missing --email or --code\n')
    process.exit(2)
  }
  const res = await apiFetch('/api/auth/verify', {
    method: 'POST',
    body: { email, code: String(code) },
    auth: false,
  })
  if (!res?.token) {
    process.stderr.write('Verify failed: no token in response\n')
    process.exit(1)
  }
  writeToken(res.token)
  process.stdout.write(`Logged in as ${res.user?.email || email}.\n`)
}

async function cmdSessionList(flags) {
  const archived = flags.archived ?? 'false'
  const res = await apiFetch(`/api/sessions?archived=${encodeURIComponent(archived)}`)
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

async function cmdAgentList() {
  const res = await apiFetch('/api/agents')
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

async function cmdSkillList() {
  const res = await apiFetch('/api/skills')
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(HELP)
    return
  }

  const [cmd, sub, ...rest] = argv
  const flags = parseFlags([sub, ...rest].filter((x) => x !== undefined))

  if (cmd === 'login') {
    return cmdLogin(parseFlags(argv.slice(1)))
  }
  if (cmd === 'verify') {
    return cmdVerify(parseFlags(argv.slice(1)))
  }
  if (cmd === 'session' && sub === 'list') return cmdSessionList(flags)
  if (cmd === 'agent' && sub === 'list') return cmdAgentList()
  if (cmd === 'skill' && sub === 'list') return cmdSkillList()

  process.stderr.write(`Unknown command: ${argv.join(' ')}\n\n${HELP}`)
  process.exit(2)
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err?.message || err}\n`)
  process.exit(1)
})
