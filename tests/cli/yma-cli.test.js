import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLI_VERSION,
  cmdRun,
  createRunShutdownController,
  parseRunArgs,
  resolveRunTimeoutMs,
  resolveServerUrl,
} from '../../bin/yma-cli.js'
import { runHeadlessTurn } from '../../server/services/headlessTurnRuntime.js'

const CLI = join(process.cwd(), 'bin', 'yma-cli.js')

function runCliProcess(args, {
  input = '',
  env = {},
  timeoutMs = 30_000,
  cwd = process.cwd(),
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`CLI timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (status, signal) => {
      clearTimeout(timeout)
      resolve({ status, signal, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

function parseJsonLines(output) {
  return String(output || '')
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

function cliE2eEnv({ dataDir, modelPort, homeDir }) {
  return {
    APP_DATA_DIR: dataDir,
    APP_DB_PATH: join(dataDir, 'app.db'),
    AUTH_MODE: 'local',
    SERVER_HOST: '127.0.0.1',
    MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
    MODEL_NAME: 'gpt-cli-e2e',
    MODEL_API_KEY: 'sk-cli-e2e',
    MODEL_PROVIDERS: '',
    TURN_EXECUTION_LEASE_MS: '1000',
    HOME: homeDir,
    USERPROFILE: homeDir,
  }
}

function seedCliProvider({ env, baseUrl, modelName }) {
  const authModuleUrl = pathToFileURL(join(
    process.cwd(),
    'server',
    'adapters',
    'authAccount.js',
  )).href
  const providerStoreModuleUrl = pathToFileURL(join(
    process.cwd(),
    'server',
    'services',
    'modelProviderStore.js',
  )).href
  const dbModuleUrl = pathToFileURL(join(process.cwd(), 'server', 'db.js')).href
  const script = `
    const { bootstrapAuth } = await import(${JSON.stringify(authModuleUrl)})
    const { upsertModelProvider, recordModelProviderReadiness } = await import(${JSON.stringify(providerStoreModuleUrl)})
    const { closeDb } = await import(${JSON.stringify(dbModuleUrl)})
    try {
      const auth = bootstrapAuth({ env: process.env })
      const modelName = process.env.GUGO_TEST_PROVIDER_MODEL
      const provider = upsertModelProvider({
        userId: auth.user.id,
        provider: {
          key: 'cli-persisted-provider',
          label: 'CLI persisted Provider',
          baseUrl: process.env.GUGO_TEST_PROVIDER_BASE_URL,
          apiKey: '',
          models: [modelName],
          defaultModel: modelName,
          enabled: true,
          isDefault: true,
        },
      })
      recordModelProviderReadiness({
        userId: auth.user.id,
        id: provider.id,
        modelName,
        expectedConfigRevision: provider.configRevision,
        readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
      })
      process.stdout.write(provider.id)
    } finally {
      closeDb()
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      GUGO_TEST_PROVIDER_BASE_URL: baseUrl,
      GUGO_TEST_PROVIDER_MODEL: modelName,
    },
  })
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  return result.stdout.trim()
}

function sendModelCompletion(res, content) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    id: 'chatcmpl-cli-e2e',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  }))
}

function run(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'yma-cli-test-'))
  try {
    return {
      ...spawnSync('node', [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
      }),
      home,
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function readStoredTokens(homeDir) {
  const dir = join(homeDir, '.yma-cli', 'tokens')
  return readdirSync(dir).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}

test('--help prints usage and exits 0', () => {
  const r = run(['--help'])
  assert.equal(r.status, 0)
  assert.ok(r.stdout.length > 0)
  assert.match(r.stdout, /yma-cli/)
  assert.match(r.stdout, /session list/)
  assert.match(r.stdout, /session search/)
  assert.match(r.stdout, /session show/)
  assert.match(r.stdout, /model list/)
  assert.match(r.stdout, /agent list/)
  assert.match(r.stdout, /skill list/)
  assert.match(r.stdout, /gugo run/)
})

test('no args prints help', () => {
  const r = run([])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Usage:/)
})

test('--version prints the package version', () => {
  const r = run(['--version'])
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
  assert.equal(r.stdout.trim(), CLI_VERSION)
})

test('server URL resolver supports explicit URLs and IPv6 hosts', () => {
  assert.equal(
    resolveServerUrl({ GUGO_SERVER_URL: 'https://gugo.example.test/base/?ignored=1#ignored' }),
    'https://gugo.example.test/base',
  )
  assert.equal(resolveServerUrl({ SERVER_HOST: '::1', SERVER_PORT: '5175' }), 'http://[::1]:5175')
  assert.throws(
    () => resolveServerUrl({ GUGO_SERVER_URL: 'file:///tmp/gugo' }),
    (error) => error?.code === 'CLI_SERVER_URL_INVALID' && error?.exitCode === 2,
  )
  assert.throws(
    () => resolveServerUrl({ GUGO_SERVER_URL: 'https://user:secret@gugo.example.test' }),
    (error) => error?.code === 'CLI_SERVER_URL_INVALID' && error?.exitCode === 2,
  )
})

test('run shutdown controller aborts once, then forces exit and removes listeners', () => {
  const target = new EventEmitter()
  const diagnostics = []
  const forced = []
  const shutdown = createRunShutdownController({
    target,
    diagnostics: { write: (value) => diagnostics.push(String(value)) },
    timeoutMs: 60_000,
    forceExit: (exitCode) => forced.push(exitCode),
  })

  target.emit('SIGINT')
  assert.equal(shutdown.signal.aborted, true)
  assert.equal(shutdown.signal.reason?.code, 'CLI_INTERRUPTED')
  assert.equal(shutdown.exitCode, 130)
  assert.equal(target.exitCode, 130)
  assert.deepEqual(forced, [])
  assert.equal(diagnostics.length, 1)

  target.emit('SIGINT')
  assert.deepEqual(forced, [130])
  shutdown.dispose()
  shutdown.dispose()
  assert.equal(target.listenerCount('SIGINT'), 0)
  assert.equal(target.listenerCount('SIGTERM'), 0)
})

test('run shutdown controller bounds graceful cancellation time', async () => {
  const target = new EventEmitter()
  const forced = []
  const shutdown = createRunShutdownController({
    target,
    diagnostics: { write: () => {} },
    timeoutMs: 5,
    forceExit: (exitCode) => forced.push(exitCode),
  })

  target.emit('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(forced, [143])
  shutdown.dispose()
})

test('local API command bootstraps a token and persists it before listing agents', async () => {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization || '' })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/auth/bootstrap') {
      res.end(JSON.stringify({
        ok: true,
        mode: 'local',
        authenticated: true,
        token: 'local-owner-token',
        user: { id: 'local-owner' },
      }))
      return
    }
    if (req.url === '/api/agents' && req.headers.authorization === 'Bearer local-owner-token') {
      res.end(JSON.stringify([{ id: 'agent-1', name: 'Local agent' }]))
      return
    }
    res.writeHead(401)
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'missing token' } }))
  })
  const port = await listen(server)
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-local-auth-'))
  try {
    const result = await runCliProcess(['agent', 'list'], {
      env: {
        GUGO_SERVER_URL: `http://127.0.0.1:${port}`,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), [{ id: 'agent-1', name: 'Local agent' }])
    assert.deepEqual(requests.map((request) => request.url), ['/api/auth/bootstrap', '/api/agents'])
    assert.deepEqual(readStoredTokens(homeDir), [{
      version: 1,
      serverUrl: `http://127.0.0.1:${port}`,
      token: 'local-owner-token',
    }])
  } finally {
    await closeServer(server)
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('multi-user bootstrap without a session fails with stable AUTH_REQUIRED', async () => {
  let requestCount = 0
  const server = createServer((_req, res) => {
    requestCount += 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, mode: 'multi_user', authenticated: false }))
  })
  const port = await listen(server)
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-multi-auth-'))
  try {
    const result = await runCliProcess(['session', 'list'], {
      env: {
        GUGO_SERVER_URL: `http://127.0.0.1:${port}`,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /AUTH_REQUIRED/)
    assert.match(result.stderr, /gugo login/)
    assert.equal(requestCount, 1)
  } finally {
    await closeServer(server)
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('session list, search, and show expose authenticated pagination APIs', async () => {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization || '' })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/auth/bootstrap') {
      res.end(JSON.stringify({
        ok: true,
        mode: 'local',
        authenticated: true,
        token: 'session-cli-token',
        user: { id: 'local-owner' },
      }))
      return
    }
    if (req.headers.authorization !== 'Bearer session-cli-token') {
      res.writeHead(401)
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'missing token' } }))
      return
    }
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/sessions') {
      res.end(JSON.stringify({ sessions: [{ id: 'session/one', title: 'First' }] }))
      return
    }
    if (url.pathname === '/api/sessions/search') {
      res.end(JSON.stringify({ results: [{ sessionId: 'session/one', snippet: 'alpha beta' }] }))
      return
    }
    if (url.pathname === '/api/sessions/session%2Fone/snapshot') {
      res.end(JSON.stringify({ snapshot: { session: { id: 'session/one' }, messages: [] } }))
      return
    }
    res.writeHead(404)
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }))
  })
  const port = await listen(server)
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-sessions-'))
  const env = {
    GUGO_SERVER_URL: `http://127.0.0.1:${port}`,
    HOME: homeDir,
    USERPROFILE: homeDir,
  }
  try {
    const listed = await runCliProcess([
      'session', 'list', '--archived=all', '--limit', '25', '--offset=5',
    ], { env })
    const searched = await runCliProcess([
      'session', 'search', '--query', 'alpha beta', '--session-id', 'session/one',
      '--limit=10', '--offset', '2',
    ], { env })
    const shown = await runCliProcess([
      'session', 'show', 'session/one', '--limit', '50', '--offset=3',
    ], { env })

    assert.equal(listed.status, 0, listed.stderr)
    assert.equal(searched.status, 0, searched.stderr)
    assert.equal(shown.status, 0, shown.stderr)
    assert.equal(JSON.parse(listed.stdout).sessions[0].id, 'session/one')
    assert.equal(JSON.parse(searched.stdout).results[0].snippet, 'alpha beta')
    assert.equal(JSON.parse(shown.stdout).snapshot.session.id, 'session/one')

    const apiRequests = requests.filter(({ url }) => url !== '/api/auth/bootstrap')
    assert.equal(apiRequests.length, 3)
    for (const request of apiRequests) {
      assert.equal(request.authorization, 'Bearer session-cli-token')
    }
    const listUrl = new URL(apiRequests[0].url, 'http://localhost')
    assert.equal(listUrl.pathname, '/api/sessions')
    assert.deepEqual(Object.fromEntries(listUrl.searchParams), {
      archived: 'all', limit: '25', offset: '5',
    })
    const searchUrl = new URL(apiRequests[1].url, 'http://localhost')
    assert.equal(searchUrl.pathname, '/api/sessions/search')
    assert.deepEqual(Object.fromEntries(searchUrl.searchParams), {
      q: 'alpha beta', limit: '10', offset: '2', sessionId: 'session/one',
    })
    const showUrl = new URL(apiRequests[2].url, 'http://localhost')
    assert.equal(showUrl.pathname, '/api/sessions/session%2Fone/snapshot')
    assert.deepEqual(Object.fromEntries(showUrl.searchParams), { limit: '50', offset: '3' })
  } finally {
    await closeServer(server)
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('model list returns a filtered machine-readable catalog without provider secrets', async () => {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization || '' })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/auth/bootstrap') {
      res.end(JSON.stringify({
        ok: true,
        mode: 'local',
        authenticated: true,
        token: 'model-list-token',
        user: { id: 'local-owner' },
      }))
      return
    }
    if (req.url === '/api/model/providers' && req.headers.authorization === 'Bearer model-list-token') {
      res.end(JSON.stringify({
        ok: true,
        providers: [{
          id: 'provider-1',
          key: 'custom-openai',
          label: 'Primary Models',
          baseUrl: 'https://secret-endpoint.example.test/v1',
          apiKey: 'must-not-be-exposed',
          headers: { Authorization: 'must-not-be-exposed' },
          enabled: true,
          isDefault: true,
          models: ['alpha-large', 'beta-small'],
          defaultModel: 'alpha-large',
          modelReadiness: { 'alpha-large': { chat: true, tools: true } },
          modelProfiles: { 'alpha-large': { contextWindow: 128000 } },
        }, {
          id: 'provider-2',
          key: 'local',
          label: 'Local Models',
          enabled: false,
          models: ['alpha-local'],
          defaultModel: 'alpha-local',
        }],
      }))
      return
    }
    res.writeHead(401)
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'missing token' } }))
  })
  const port = await listen(server)
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-model-list-'))
  try {
    const result = await runCliProcess([
      'model', 'list', '--provider=provider-1', '--search', 'ALPHA',
    ], {
      env: {
        GUGO_SERVER_URL: `http://127.0.0.1:${port}`,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      models: [{
        name: 'alpha-large',
        providerId: 'provider-1',
        providerKey: 'custom-openai',
        providerLabel: 'Primary Models',
        enabled: true,
        isProviderDefault: true,
        isDefault: true,
        readiness: { chat: true, tools: true },
        profile: { contextWindow: 128000 },
      }],
    })
    assert.doesNotMatch(result.stdout, /must-not-be-exposed|secret-endpoint/)
    assert.deepEqual(requests.map(({ url }) => url), [
      '/api/auth/bootstrap',
      '/api/model/providers',
    ])
  } finally {
    await closeServer(server)
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a 401 refreshes local authentication once and retries the API request once', async () => {
  let bootstrapRequests = 0
  let agentRequests = 0
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/auth/bootstrap') {
      bootstrapRequests += 1
      const initial = bootstrapRequests === 1
      assert.equal(req.headers.authorization || '', initial ? '' : 'Bearer expired-token')
      res.end(JSON.stringify({
        ok: true,
        mode: 'local',
        authenticated: true,
        token: initial ? 'expired-token' : 'refreshed-token',
        user: { id: 'local-owner' },
      }))
      return
    }
    agentRequests += 1
    if (req.headers.authorization === 'Bearer refreshed-token') {
      res.end(JSON.stringify([{ id: 'agent-after-refresh' }]))
      return
    }
    res.writeHead(401)
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'expired token' } }))
  })
  const port = await listen(server)
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-refresh-auth-'))
  try {
    const result = await runCliProcess(['agent', 'list'], {
      env: {
        GUGO_SERVER_URL: `http://127.0.0.1:${port}`,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(bootstrapRequests, 2)
    assert.equal(agentRequests, 2)
    assert.equal(readStoredTokens(homeDir)[0].token, 'refreshed-token')
  } finally {
    await closeServer(server)
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('tokens are isolated by normalized server URL and never cross two explicit servers', async () => {
  const makeServer = (token) => {
    const requests = []
    const server = createServer((req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization || '' })
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/auth/bootstrap') {
        res.end(JSON.stringify({
          ok: true,
          mode: 'local',
          authenticated: true,
          token,
          user: { id: token },
        }))
        return
      }
      if (req.url === '/api/agents' && req.headers.authorization === `Bearer ${token}`) {
        res.end(JSON.stringify([{ id: token }]))
        return
      }
      res.writeHead(401)
      res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'wrong token' } }))
    })
    return { server, requests }
  }
  const first = makeServer('token-for-first')
  const second = makeServer('token-for-second')
  const firstPort = await listen(first.server)
  const secondPort = await listen(second.server)
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-origin-scope-'))
  mkdirSync(join(homeDir, '.yma-cli'), { recursive: true })
  writeFileSync(join(homeDir, '.yma-cli', 'token'), 'legacy-token-must-not-leak')
  const envFor = (port) => ({
    GUGO_SERVER_URL: `http://127.0.0.1:${port}/`,
    HOME: homeDir,
    USERPROFILE: homeDir,
  })
  try {
    const firstRun = await runCliProcess(['agent', 'list'], { env: envFor(firstPort) })
    const secondRun = await runCliProcess(['agent', 'list'], { env: envFor(secondPort) })
    const firstAgain = await runCliProcess(['agent', 'list'], { env: envFor(firstPort) })
    assert.equal(firstRun.status, 0, firstRun.stderr)
    assert.equal(secondRun.status, 0, secondRun.stderr)
    assert.equal(firstAgain.status, 0, firstAgain.stderr)
    assert.equal(
      [...first.requests, ...second.requests]
        .some(({ authorization }) => authorization.includes('legacy-token-must-not-leak')),
      false,
    )
    assert.equal(second.requests.some(({ authorization }) => authorization.includes('token-for-first')), false)
    assert.deepEqual(second.requests.map(({ authorization }) => authorization), [
      '',
      'Bearer token-for-second',
    ])
    assert.deepEqual(first.requests.map(({ url }) => url), [
      '/api/auth/bootstrap',
      '/api/agents',
      '/api/agents',
    ])
    assert.deepEqual(
      readStoredTokens(homeDir).map(({ token }) => token).sort(),
      ['token-for-first', 'token-for-second'],
    )
  } finally {
    await closeServer(first.server)
    await closeServer(second.server)
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('legacy token never migrates to a custom loopback server scope', async () => {
  let bootstrapRequests = 0
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/auth/bootstrap') {
      bootstrapRequests += 1
      res.end(JSON.stringify({ ok: true, mode: 'multi_user', authenticated: false }))
      return
    }
    if (req.url === '/api/agents' && req.headers.authorization === 'Bearer legacy-local-token') {
      res.end(JSON.stringify([{ id: 'legacy-authorized' }]))
      return
    }
    res.writeHead(401)
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'wrong token' } }))
  })
  const port = await listen(server)
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-legacy-local-'))
  mkdirSync(join(homeDir, '.yma-cli'), { recursive: true })
  writeFileSync(join(homeDir, '.yma-cli', 'token'), 'legacy-local-token')
  try {
    const result = await runCliProcess(['agent', 'list'], {
      env: {
        GUGO_SERVER_URL: '',
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: String(port),
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /AUTH_REQUIRED/)
    assert.equal(bootstrapRequests, 1)
    assert.equal(existsSync(join(homeDir, '.yma-cli', 'tokens')), false)
  } finally {
    await closeServer(server)
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('unknown command exits non-zero', () => {
  const r = run(['nope'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /Unknown command/)
})

test('login without --email exits non-zero', () => {
  const r = run(['login'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /email/i)
})

test('non-run commands reject unknown, duplicate, and extra arguments with exit 2', () => {
  for (const args of [
    ['agent', 'list', '--typo', 'value'],
    ['login', '--email=a@example.test', '--email', 'b@example.test'],
    ['status', 'extra'],
    ['session', 'list', '--archived=maybe'],
    ['session', 'list', '--limit=0'],
    ['session', 'search'],
    ['session', 'search', '--query=needle', '--limit=101'],
    ['session', 'search', '--query=needle', '--offset=-1'],
    ['session', 'show'],
    ['session', 'show', 'one', 'two'],
    ['session', 'show', 'one', '--limit=2001'],
    ['model', 'list', '--provider'],
    ['model', 'list', '--search=x', '--search=y'],
  ]) {
    const result = run(args)
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`)
    assert.match(
      result.stderr,
      /CLI_(?:OPTION_UNKNOWN|OPTION_DUPLICATE|OPTION_VALUE_REQUIRED|ARGUMENT_UNEXPECTED|ARCHIVED_INVALID|LIMIT_INVALID|OFFSET_INVALID|SESSION_ID_REQUIRED)/,
    )
  }
})

test('status reports public health and doctor preserves degraded full diagnostics', async () => {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization || '' })
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, version: 'test-version', db: { ok: true } }))
      return
    }
    if (req.url === '/api/auth/bootstrap') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        mode: 'local',
        authenticated: true,
        token: 'doctor-token',
        user: { id: 'local-owner' },
      }))
      return
    }
    if (req.url === '/api/health/full' && req.headers.authorization === 'Bearer doctor-token') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: false,
        version: 'test-version',
        db: { ok: true },
        model: {
          configured: false,
          agentReady: false,
          readinessCode: 'MODEL_CONFIG_MISSING',
          code: 'MODEL_CONFIG_MISSING',
          action: 'configure_model',
          modelName: null,
          toolMaxRounds: 32,
        },
      }))
      return
    }
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'missing token' } }))
  })
  const port = await listen(server)
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-doctor-'))
  const env = {
    GUGO_SERVER_URL: `http://127.0.0.1:${port}`,
    HOME: homeDir,
    USERPROFILE: homeDir,
  }
  try {
    const status = await runCliProcess(['status'], { env })
    assert.equal(status.status, 0, status.stderr)
    assert.equal(JSON.parse(status.stdout).ok, true)

    const doctor = await runCliProcess(['doctor'], { env })
    assert.equal(doctor.status, 1, doctor.stderr)
    assert.deepEqual(JSON.parse(doctor.stdout), {
      ok: false,
      version: 'test-version',
      db: { ok: true },
      model: {
        configured: false,
        agentReady: false,
        readinessCode: 'MODEL_CONFIG_MISSING',
        code: 'MODEL_CONFIG_MISSING',
        action: 'configure_model',
        modelName: null,
        toolMaxRounds: 32,
      },
    })
    assert.equal(doctor.stderr, '')
    assert.deepEqual(requests.map((request) => request.url), [
      '/api/health',
      '/api/auth/bootstrap',
      '/api/health/full',
    ])
  } finally {
    await closeServer(server)
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('equals-form flags reach the server and nested API errors stay readable', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: { code: 'EMAIL_INVALID', message: 'email address is invalid' },
    }))
  })
  const port = await listen(server)
  try {
    const result = await runCliProcess(['login', '--email=invalid@example.test'], {
      env: { GUGO_SERVER_URL: `http://127.0.0.1:${port}` },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /EMAIL_INVALID/)
    assert.match(result.stderr, /email address is invalid/)
    assert.doesNotMatch(result.stderr, /\[object Object\]/)
  } finally {
    await closeServer(server)
  }
})

test('API requests fail with a stable timeout error', async () => {
  const server = createServer(() => {})
  const port = await listen(server)
  try {
    const result = await runCliProcess(['status'], {
      env: {
        GUGO_SERVER_URL: `http://127.0.0.1:${port}`,
        GUGO_CLI_HTTP_TIMEOUT_MS: '25',
      },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /REQUEST_TIMEOUT/)
  } finally {
    server.closeAllConnections?.()
    await closeServer(server)
  }
})

test('API timeout covers a response body that stalls after headers', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.flushHeaders()
  })
  const port = await listen(server)
  try {
    const result = await runCliProcess(['status'], {
      env: {
        GUGO_SERVER_URL: `http://127.0.0.1:${port}`,
        GUGO_CLI_HTTP_TIMEOUT_MS: '25',
      },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /REQUEST_TIMEOUT/)
  } finally {
    server.closeAllConnections?.()
    await closeServer(server)
  }
})

test('run parser supports prompt, model, Provider, mode, cwd, session and resume', () => {
  const parsed = parseRunArgs([
    'inspect', 'this', '--model', 'local-model', '--provider', 'provider-1', '--mode=acceptEdits',
    '--cwd', '.', '--session-id', 'session-1', '--timeout=2500', '--output=text',
  ])
  assert.equal(parsed.prompt, 'inspect this')
  assert.equal(parsed.model, 'local-model')
  assert.equal(parsed.modelProviderId, 'provider-1')
  assert.equal(parsed.mode, 'acceptEdits')
  assert.equal(parsed.sessionId, 'session-1')
  assert.equal(parsed.timeoutMs, 2500)
  assert.equal(parsed.outputFormat, 'text')
  assert.equal(parseRunArgs(['plain prompt']).mode, 'normal')
  assert.equal(parseRunArgs(['plain prompt']).outputFormat, 'jsonl')
  assert.equal(parseRunArgs(['--', '--output', 'text']).prompt, '--output text')
  assert.throws(() => parseRunArgs(['prompt', '--resume', 'turn-1']), /cannot be combined/)
  const resumed = parseRunArgs(['--resume', 'turn-1'])
  assert.equal(resumed.resumeTurnId, 'turn-1')
  assert.equal(resumed.mode, null)
  assert.throws(
    () => parseRunArgs(['prompt', '--mode', 'unsafe']),
    (error) => error?.code === 'CLI_MODE_INVALID' && error?.exitCode === 2,
  )
  assert.throws(
    () => parseRunArgs(['--resume', 'turn-1', '--mode', 'bypass']),
    (error) => error?.code === 'CLI_RESUME_MODE_CONFLICT' && error?.exitCode === 2,
  )
  assert.throws(
    () => parseRunArgs(['--resume', 'turn-1', '--provider', 'provider-1']),
    (error) => error?.code === 'CLI_RESUME_PROVIDER_CONFLICT' && error?.exitCode === 2,
  )
  assert.throws(
    () => parseRunArgs(['--resume', 'turn-1', '--model', 'local-model']),
    (error) => error?.code === 'CLI_RESUME_MODEL_CONFLICT' && error?.exitCode === 2,
  )
  assert.throws(
    () => parseRunArgs(['prompt', '--output', 'yaml']),
    (error) => error?.code === 'CLI_OUTPUT_INVALID' && error?.exitCode === 2,
  )
})

test('run timeout resolves CLI precedence and rejects unsafe timer values', () => {
  assert.equal(resolveRunTimeoutMs(null, {}), 0)
  assert.equal(resolveRunTimeoutMs(null, { GUGO_CLI_RUN_TIMEOUT_MS: '9000' }), 9000)
  assert.equal(resolveRunTimeoutMs('250', { GUGO_CLI_RUN_TIMEOUT_MS: '9000' }), 250)
  for (const value of ['0', '-1', '1.5', 'abc', '2147483648']) {
    assert.throws(
      () => resolveRunTimeoutMs(value, {}),
      (error) => error?.code === 'CLI_RUN_TIMEOUT_INVALID' && error?.exitCode === 2,
    )
  }
})

test('run parser rejects blank model selections and duplicate single-value options', () => {
  for (const option of ['model', 'provider']) {
    assert.throws(
      () => parseRunArgs(['prompt', `--${option}`, '   ']),
      (error) => error?.code === 'CLI_OPTION_VALUE_REQUIRED' && error?.exitCode === 2,
    )
  }

  const duplicateOptions = [
    ['model', 'model-a', 'model-b'],
    ['provider', 'provider-a', 'provider-b'],
    ['mode', 'normal', 'plan'],
    ['cwd', '.', '..'],
    ['session-id', 'session-a', 'session-b'],
    ['resume', 'turn-a', 'turn-b'],
    ['timeout', '100', '200'],
    ['output', 'jsonl', 'text'],
  ]
  for (const [option, first, second] of duplicateOptions) {
    assert.throws(
      () => parseRunArgs([`--${option}`, first, `--${option}=${second}`]),
      (error) => error?.code === 'CLI_OPTION_DUPLICATE' && error?.exitCode === 2,
    )
  }
})

test('run reads a piped prompt and keeps stdout JSONL-only', async () => {
  const stdin = Readable.from(['prompt ', 'from pipe\n'])
  const stdoutChunks = []
  const stderrChunks = []
  const stdout = new Writable({ write(chunk, _encoding, done) { stdoutChunks.push(String(chunk)); done() } })
  const stderr = new Writable({ write(chunk, _encoding, done) { stderrChunks.push(String(chunk)); done() } })
  const controller = new AbortController()
  let request
  const exitCode = await cmdRun(['--mode', 'plan'], {
    stdin,
    stdout,
    stderr,
    signal: controller.signal,
    runTurn: async (options) => {
      request = options
      options.onEvent({ type: 'turn.completed', sequence: 1, payload: { text: 'done' } })
      return { exitCode: 0 }
    },
  })
  assert.equal(exitCode, 0)
  assert.equal(request.prompt, 'prompt from pipe')
  assert.equal(request.mode, 'plan')
  assert.equal(request.interactive, false)
  assert.equal(request.signal, controller.signal)
  assert.equal(stderrChunks.join(''), '')
  assert.deepEqual(JSON.parse(stdoutChunks.join('').trim()), {
    type: 'turn.completed', sequence: 1, payload: { text: 'done' },
  })
})

test('run combines a positional instruction with piped context without dropping either', async () => {
  let request
  const stdout = new Writable({ write(_chunk, _encoding, done) { done() } })
  const stderr = new Writable({ write(_chunk, _encoding, done) { done() } })
  const exitCode = await cmdRun(['review this diff', '--mode=plan'], {
    stdin: Readable.from(['diff --git a/file b/file\n+changed\n']),
    stdout,
    stderr,
    runTurn: async (options) => {
      request = options
      return { status: 'completed', exitCode: 0 }
    },
  })

  assert.equal(exitCode, 0)
  assert.equal(request.prompt, 'review this diff\n\ndiff --git a/file b/file\n+changed')
})

test('run rejects piped content with --resume instead of silently discarding it', async () => {
  const stdoutChunks = []
  const stderrChunks = []
  let invoked = false
  const exitCode = await cmdRun(['--resume', 'turn-1'], {
    stdin: Readable.from(['unexpected new prompt']),
    stdout: new Writable({
      write(chunk, _encoding, done) { stdoutChunks.push(String(chunk)); done() },
    }),
    stderr: new Writable({
      write(chunk, _encoding, done) { stderrChunks.push(String(chunk)); done() },
    }),
    runTurn: async () => {
      invoked = true
      return { status: 'completed', exitCode: 0 }
    },
  })

  assert.equal(exitCode, 2)
  assert.equal(invoked, false)
  assert.equal(JSON.parse(stdoutChunks.join('')).error.code, 'CLI_RESUME_PROMPT_CONFLICT')
  assert.match(stderrChunks.join(''), /CLI_RESUME_PROMPT_CONFLICT/)
})

test('run applies the stdin size limit even when a positional prompt is present', async () => {
  const stdoutChunks = []
  let invoked = false
  const exitCode = await cmdRun(['review'], {
    stdin: Readable.from(['x'.repeat((1024 * 1024) + 1)]),
    stdout: new Writable({
      write(chunk, _encoding, done) { stdoutChunks.push(String(chunk)); done() },
    }),
    stderr: new Writable({ write(_chunk, _encoding, done) { done() } }),
    runTurn: async () => {
      invoked = true
      return { status: 'completed', exitCode: 0 }
    },
  })

  assert.equal(exitCode, 2)
  assert.equal(invoked, false)
  assert.equal(JSON.parse(stdoutChunks.join('')).error.code, 'CLI_STDIN_TOO_LARGE')
})

test('run timeout cancels through the shared signal and exits 124 after cleanup', async () => {
  const stdoutChunks = []
  const stderrChunks = []
  let receivedExitCode = null
  let cleanedUp = false
  const exitCode = await cmdRun(['slow turn', '--timeout=10'], {
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
    stdout: new Writable({
      write(chunk, _encoding, done) { stdoutChunks.push(String(chunk)); done() },
    }),
    stderr: new Writable({
      write(chunk, _encoding, done) { stderrChunks.push(String(chunk)); done() },
    }),
    runTurn: async (options) => {
      assert.equal('timeoutMs' in options, false)
      await new Promise((resolve) => {
        options.signal.addEventListener('abort', () => {
          receivedExitCode = options.signal.reason?.exitCode
          options.onEvent({ type: 'turn.cancelled', payload: { reason: 'deadline' } })
          setImmediate(() => {
            cleanedUp = true
            resolve()
          })
        }, { once: true })
      })
      return { status: 'cancelled', exitCode: 1 }
    },
  })

  assert.equal(exitCode, 124)
  assert.equal(receivedExitCode, 124)
  assert.equal(cleanedUp, true)
  const events = parseJsonLines(stdoutChunks.join(''))
  assert.equal(events.at(-1).type, 'cli.error')
  assert.equal(events.at(-1).error.code, 'CLI_RUN_TIMEOUT')
  assert.match(stderrChunks.join(''), /CLI_RUN_TIMEOUT/)
})

test('run text output commits only the final successful body and ignores remote HTTP credentials', async () => {
  const stdoutChunks = []
  const stderrChunks = []
  const stdout = new Writable({ write(chunk, _encoding, done) { stdoutChunks.push(String(chunk)); done() } })
  const stderr = new Writable({ write(chunk, _encoding, done) { stderrChunks.push(String(chunk)); done() } })
  let request
  const exitCode = await cmdRun(['inspect safely', '--output=text'], {
    stdin: Readable.from([]),
    stdout,
    stderr,
    env: { GUGO_SERVER_URL: 'https://remote.example.test/base' },
    runTurn: async (options) => {
      request = options
      options.onEvent({ type: 'turn.started', payload: { content: 'must stay hidden' } })
      options.onEvent({ type: 'turn.interrupted', payload: { message: 'old replay state' } })
      options.onToken('must-not-be-persisted')
      options.onEvent({ type: 'turn.completed', payload: { text: 'final\nbody' } })
      return { status: 'completed', exitCode: 0 }
    },
  })

  assert.equal(exitCode, 0)
  assert.equal(request.token, '')
  assert.equal('outputFormat' in request, false)
  assert.equal(stdoutChunks.join(''), 'final\nbody\n')
  assert.equal(stderrChunks.join(''), '')
})

test('run text errors leave stdout empty while JSONL remains the default', async () => {
  const invoke = async (args) => {
    const stdoutChunks = []
    const stderrChunks = []
    const stdout = new Writable({ write(chunk, _encoding, done) { stdoutChunks.push(String(chunk)); done() } })
    const stderr = new Writable({ write(chunk, _encoding, done) { stderrChunks.push(String(chunk)); done() } })
    const exitCode = await cmdRun(args, {
      stdin: Readable.from([]),
      stdout,
      stderr,
      runTurn: async () => {
        throw Object.assign(new Error('model unavailable'), { code: 'MODEL_UNAVAILABLE' })
      },
    })
    return { exitCode, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') }
  }

  const text = await invoke(['hello', '--output', 'text'])
  assert.equal(text.exitCode, 1)
  assert.equal(text.stdout, '')
  assert.match(text.stderr, /MODEL_UNAVAILABLE/)

  const jsonl = await invoke(['hello'])
  assert.equal(jsonl.exitCode, 1)
  assert.equal(JSON.parse(jsonl.stdout).error.code, 'MODEL_UNAVAILABLE')
})

test('run --cwd cannot relocate runtime capability bindings into the workspace', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'gugo-cli-runtime-root-'))
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'gugo-cli-workspace-root-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-workspace-home-'))
  const hostileConfig = JSON.stringify({
    env: {},
    capabilityBindings: { loop: 'workspace.missing-loop' },
  })
  const env = {
    APP_DATA_DIR: join(runtimeRoot, 'runtime-data'),
    APP_DB_PATH: join(runtimeRoot, 'runtime-data', 'app.db'),
    AUTH_MODE: 'local',
    GUGO_LOAD_DOTENV: '0',
    HOME: homeDir,
    USERPROFILE: homeDir,
  }
  try {
    mkdirSync(join(workspaceRoot, '.gugo'), { recursive: true })
    writeFileSync(join(workspaceRoot, '.gugo', 'runtime.json'), hostileConfig, 'utf8')

    const workspaceAttempt = await runCliProcess([
      'run', 'verify workspace isolation', '--cwd', workspaceRoot,
    ], { cwd: runtimeRoot, env, timeoutMs: 60_000 })
    assert.notEqual(workspaceAttempt.status, 0)
    assert.doesNotMatch(workspaceAttempt.stdout, /RUNTIME_CAPABILITY_BINDING_MISSING/)
    assert.doesNotMatch(workspaceAttempt.stderr, /workspace\.missing-loop/)

    mkdirSync(join(runtimeRoot, '.gugo'), { recursive: true })
    writeFileSync(join(runtimeRoot, '.gugo', 'runtime.json'), hostileConfig, 'utf8')
    const runtimeAttempt = await runCliProcess([
      'run', 'verify runtime binding', '--cwd', workspaceRoot,
    ], { cwd: runtimeRoot, env, timeoutMs: 60_000 })
    assert.equal(runtimeAttempt.status, 1)
    const runtimeError = parseJsonLines(runtimeAttempt.stdout)
      .find((event) => event.type === 'cli.error')
    assert.equal(runtimeError?.error?.code, 'RUNTIME_CAPABILITY_BINDING_MISSING')
    assert.match(runtimeError?.error?.message || '', /workspace\.missing-loop/)
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('real CLI never executes a persistence module selected by project dotenv', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'gugo-cli-dotenv-untrusted-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-dotenv-home-'))
  const dataDir = join(runtimeRoot, 'runtime-data')
  const markerPath = join(runtimeRoot, 'persistence-module-executed')
  try {
    mkdirSync(join(runtimeRoot, '.gugo'), { recursive: true })
    writeFileSync(
      join(runtimeRoot, 'untrusted-persistence.mjs'),
      `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(markerPath)}, 'executed')\nexport default {}\n`,
      'utf8',
    )
    writeFileSync(
      join(runtimeRoot, '.env'),
      'GUGO_TURN_PERSISTENCE_MODULE=untrusted-persistence.mjs\n',
      'utf8',
    )
    writeFileSync(join(runtimeRoot, '.gugo', 'runtime.json'), JSON.stringify({
      env: {},
      capabilityBindings: { loop: 'runtime.missing-loop' },
    }), 'utf8')

    const result = await runCliProcess(['run', 'verify dotenv isolation'], {
      cwd: runtimeRoot,
      env: {
        APP_DATA_DIR: dataDir,
        APP_DB_PATH: join(dataDir, 'app.db'),
        AUTH_MODE: 'local',
        GUGO_LOAD_DOTENV: '1',
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      timeoutMs: 60_000,
    })

    assert.equal(result.status, 1)
    const cliError = parseJsonLines(result.stdout).find((event) => event.type === 'cli.error')
    assert.equal(cliError?.error?.code, 'RUNTIME_CAPABILITY_BINDING_MISSING')
    assert.equal(existsSync(markerPath), false)
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('bundled SQLite persistence authorizes the CLI resume lookup', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'gugo-cli-builtin-persistence-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-builtin-persistence-home-'))
  const dataDir = join(runtimeRoot, 'runtime-data')
  try {
    const result = await runCliProcess(['run', '--resume', 'missing-turn'], {
      cwd: runtimeRoot,
      env: {
        APP_DATA_DIR: dataDir,
        APP_DB_PATH: join(dataDir, 'app.db'),
        AUTH_MODE: 'local',
        GUGO_LOAD_DOTENV: '0',
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      timeoutMs: 60_000,
    })

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const cliError = parseJsonLines(result.stdout).find((event) => event.type === 'cli.error')
    assert.equal(cliError?.error?.code, 'TURN_NOT_FOUND')
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('trusted module re-exporting the built-in adapter keeps its own resume lookup capability', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'gugo-cli-custom-persistence-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-custom-persistence-home-'))
  const dataDir = join(runtimeRoot, 'runtime-data')
  const modulePath = join(runtimeRoot, 'custom-persistence.mjs')
  const sqliteAdapterUrl = new URL(
    '../../server/adapters/sqliteTurnPersistenceAdapter.js',
    import.meta.url,
  ).href
  try {
    writeFileSync(
      modulePath,
      `export { SQLITE_TURN_PERSISTENCE_ADAPTER as turnPersistenceAdapter } from ${JSON.stringify(sqliteAdapterUrl)}\n`,
      'utf8',
    )

    const result = await runCliProcess(['run', '--resume', 'missing-turn'], {
      cwd: runtimeRoot,
      env: {
        APP_DATA_DIR: dataDir,
        APP_DB_PATH: join(dataDir, 'app.db'),
        AUTH_MODE: 'local',
        GUGO_LOAD_DOTENV: '0',
        GUGO_TURN_PERSISTENCE_MODULE: modulePath,
        GUGO_TURN_PERSISTENCE_TRUST_ROOT: runtimeRoot,
        HOME: homeDir,
        USERPROFILE: homeDir,
      },
      timeoutMs: 60_000,
    })

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const cliError = parseJsonLines(result.stdout).find((event) => event.type === 'cli.error')
    assert.equal(cliError?.error?.code, 'TURN_NOT_FOUND')
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('real CLI subprocess pipes stdin through TurnEngine and emits JSONL', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gugo-cli-e2e-data-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-e2e-home-'))
  const requestBodies = []
  const modelServer = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requestBodies.push(JSON.parse(body))
      sendModelCompletion(res, 'real pipe completed')
    })
  })
  const modelPort = await listen(modelServer)

  try {
    const result = await runCliProcess(['run', '--mode', 'plan'], {
      input: 'real prompt from stdin\n',
      env: cliE2eEnv({ dataDir, modelPort, homeDir }),
    })
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const events = parseJsonLines(result.stdout)
    assert.ok(events.some((event) => event.type === 'turn.started'))
    const completed = events.find((event) => event.type === 'turn.completed')
    assert.equal(completed?.payload?.text, 'real pipe completed')
    assert.equal(events.some((event) => event.type === 'cli.error'), false)
    assert.ok(requestBodies.length >= 1)
    assert.ok(requestBodies.some((body) => /real prompt from stdin/.test(JSON.stringify(body.messages))))
  } finally {
    await closeServer(modelServer)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('real CLI persists the selected Provider UUID in turn.started', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gugo-cli-provider-e2e-data-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-provider-e2e-home-'))
  const modelName = 'gpt-cli-provider-e2e'
  const modelServer = createServer((req, res) => {
    req.resume()
    req.on('end', () => sendModelCompletion(res, 'persisted Provider completed'))
  })
  const modelPort = await listen(modelServer)
  const env = {
    ...cliE2eEnv({ dataDir, modelPort, homeDir }),
    GUGO_LOAD_DOTENV: '0',
    MODEL_BASE_URL: '',
    MODEL_NAME: '',
    MODEL_API_KEY: '',
    MODEL_PROVIDERS: '',
  }

  try {
    const providerId = seedCliProvider({
      env,
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      modelName,
    })
    const result = await runCliProcess([
      'run',
      'use the persisted Provider UUID',
      '--mode',
      'plan',
      '--provider',
      providerId,
      '--model',
      modelName,
    ], { env })
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const events = parseJsonLines(result.stdout)
    const started = events.find((event) => event.type === 'turn.started')
    assert.equal(started?.payload?.modelProviderId, providerId)
    assert.equal(started?.payload?.modelName, modelName)
    assert.equal(
      events.find((event) => event.type === 'turn.completed')?.payload?.text,
      'persisted Provider completed',
    )
  } finally {
    await closeServer(modelServer)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('real CLI subprocess preserves outcome-unknown safety after a durable in-flight checkpoint', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gugo-cli-resume-data-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'gugo-cli-resume-home-'))
  let modelRequests = 0
  let allowCompletion = false
  let notifyModelRequestStarted = null
  const modelServer = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      modelRequests += 1
      notifyModelRequestStarted?.()
      if (!allowCompletion) return
      sendModelCompletion(res, 'resumed from checkpoint')
    })
  })
  const modelPort = await listen(modelServer)
  const env = cliE2eEnv({ dataDir, modelPort, homeDir })
  let firstChild = null

  try {
    firstChild = spawn(process.execPath, [
      CLI,
      'run',
      '--mode',
      'plan',
      'create durable interruption',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    firstChild.stdin.end()
    firstChild.stdout.setEncoding('utf8')
    firstChild.stderr.setEncoding('utf8')
    let firstStdout = ''
    let firstStderr = ''
    let stdoutBuffer = ''
    const firstExit = new Promise((resolve, reject) => {
      firstChild.once('error', reject)
      firstChild.once('close', (status, signal) => resolve({ status, signal }))
    })
    const checkpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`checkpoint event timed out\nstdout:\n${firstStdout}\nstderr:\n${firstStderr}`))
      }, 15_000)
      firstChild.stderr.on('data', (chunk) => { firstStderr += chunk })
      firstChild.stdout.on('data', (chunk) => {
        firstStdout += chunk
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split(/\r?\n/u)
        stdoutBuffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event.type === 'turn.checkpoint') {
            clearTimeout(timeout)
            resolve(event)
            return
          }
        }
      })
      firstChild.once('close', (status, signal) => {
        clearTimeout(timeout)
        reject(new Error(`CLI exited before checkpoint (${status ?? signal})\n${firstStdout}\n${firstStderr}`))
      })
    })

    // A turn can write checkpoints before it crosses the Provider side-effect
    // boundary. Killing on the first generic checkpoint makes this test race
    // between a legitimately replayable not-sent request and an in-flight one.
    // Wait until the Provider has received the request; the runtime guarantees
    // that its in-flight checkpoint is durable before this can happen.
    await new Promise((resolve, reject) => {
      if (modelRequests >= 1) {
        resolve()
        return
      }
      const timeout = setTimeout(() => {
        notifyModelRequestStarted = null
        reject(new Error(`model request timed out after checkpoint\nstdout:\n${firstStdout}\nstderr:\n${firstStderr}`))
      }, 15_000)
      notifyModelRequestStarted = () => {
        clearTimeout(timeout)
        notifyModelRequestStarted = null
        resolve()
      }
    })

    assert.equal(firstChild.kill('SIGKILL'), true)
    const killed = await firstExit
    assert.notEqual(killed.status, 0)
    assert.equal(parseJsonLines(firstStdout).some((event) => event.type.startsWith('turn.') && ['turn.completed', 'turn.failed', 'turn.blocked', 'turn.cancelled'].includes(event.type)), false)
    allowCompletion = true

    const resumedRun = await runCliProcess([
      'run', '--resume', checkpoint.turnId, '--session-id', checkpoint.sessionId,
    ], { env })
    assert.equal(resumedRun.status, 1, `stdout:\n${resumedRun.stdout}\nstderr:\n${resumedRun.stderr}`)
    const resumedEvents = parseJsonLines(resumedRun.stdout)
    assert.ok(resumedEvents.some((event) => (
      event.turnId === checkpoint.turnId
      && event.sessionId === checkpoint.sessionId
      && event.type === 'model.phase'
      && event.sequence > checkpoint.sequence
    )))
    const blocked = resumedEvents.find((event) => event.type === 'turn.blocked')
    assert.equal(blocked?.payload?.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN')
    assert.equal(blocked?.payload?.requiresUserVerification, true)
    assert.equal(blocked?.payload?.recoveryKind, 'model_request_outcome_unknown')
    assert.equal(resumedEvents.some((event) => event.type === 'turn.completed'), false)
    assert.equal(modelRequests, 1, 'recovery must not issue a second provider request')
  } finally {
    if (firstChild && firstChild.exitCode === null) firstChild.kill('SIGKILL')
    await closeServer(modelServer)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(homeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('run reports runtime/model failures as stable JSONL and diagnostics', async () => {
  const stdoutChunks = []
  const stderrChunks = []
  const stdout = new Writable({ write(chunk, _encoding, done) { stdoutChunks.push(String(chunk)); done() } })
  const stderr = new Writable({ write(chunk, _encoding, done) { stderrChunks.push(String(chunk)); done() } })
  const error = Object.assign(new Error('no configured model'), {
    code: 'MODEL_CONFIG_MISSING',
    action: 'configure_model',
  })
  const exitCode = await cmdRun(['hello'], {
    stdin: Readable.from([]), stdout, stderr,
    runTurn: async () => { throw error },
  })
  assert.equal(exitCode, 1)
  assert.deepEqual(JSON.parse(stdoutChunks.join('').trim()), {
    type: 'cli.error',
    error: {
      code: 'MODEL_CONFIG_MISSING',
      message: 'no configured model',
      action: 'configure_model',
      nextAction: 'configure_model',
    },
  })
  assert.match(stderrChunks.join(''), /MODEL_CONFIG_MISSING/)
})

function fakeRuntime({ initialEvents = [], onStart, onRecover } = {}) {
  const events = [...initialEvents]
  let listener = () => {}
  let finish
  const completed = new Promise((resolve) => { finish = resolve })
  const emit = (type, payload = {}) => {
    const event = { id: `event-${events.length}`, sessionId: 'session-1', turnId: 'turn-1', sequence: events.length, type, payload, createdAt: events.length + 1 }
    events.push(event)
    listener(event)
    if (['turn.completed', 'turn.failed', 'turn.blocked', 'turn.cancelled', 'turn.paused', 'turn.interrupted'].includes(type)) finish()
    return event
  }
  return {
    events,
    emit,
    dependencies: {
      configureWorkspace: (value) => value,
      bootstrapAuth: async () => ({ authenticated: true, mode: 'local', user: { id: 'user-1' } }),
      idFactory: (() => { const ids = ['turn-1', 'session-1']; return () => ids.shift() })(),
      subscribeEvents: (_scope, callback) => { listener = callback; return () => { listener = () => {} } },
      listEvents: ({ after }) => events.filter((event) => event.sequence > after),
      engine: {
        startTurn: async (scope) => onStart?.(scope, emit),
        recoverTurn: async (scope) => onRecover?.(scope, emit),
        waitForTurn: async () => completed,
      },
    },
  }
}

test('headless runtime forwards each validated mode as a per-turn permission override', async () => {
  for (const mode of ['normal', 'acceptEdits', 'plan', 'bypass']) {
    let startedScope = null
    const fake = fakeRuntime({
      onStart: (scope, emit) => {
        startedScope = scope
        emit('turn.started', { approvalMode: scope.approvalMode })
        emit('turn.completed', { text: 'done' })
      },
    })
    const result = await runHeadlessTurn({ prompt: 'run safely', mode }, fake.dependencies)
    assert.equal(result.status, 'completed')
    assert.equal(startedScope.approvalMode, mode)
    assert.equal(startedScope.intentMode, mode === 'plan' ? 'answer' : 'auto')
  }
})

test('headless runtime binds a new turn to the explicitly selected model Provider', async () => {
  let startedScope = null
  const fake = fakeRuntime({
    onStart: (scope, emit) => {
      startedScope = scope
      emit('turn.started')
      emit('turn.completed', { text: 'done' })
    },
  })

  const result = await runHeadlessTurn({
    prompt: 'use the selected Provider',
    model: 'shared-model',
    modelProviderId: 'provider-1',
  }, fake.dependencies)

  assert.equal(result.status, 'completed')
  assert.equal(startedScope.modelName, 'shared-model')
  assert.equal(startedScope.modelProviderId, 'provider-1')
})

test('headless runtime fails closed for invalid or resume-time permission overrides', async () => {
  const fresh = fakeRuntime()
  await assert.rejects(
    runHeadlessTurn({ prompt: 'do not run', mode: 'unsafe' }, fresh.dependencies),
    (error) => error?.code === 'CLI_MODE_INVALID' && error?.exitCode === 2,
  )

  let recoveryCalls = 0
  const resumed = fakeRuntime({
    onRecover: () => { recoveryCalls += 1 },
  })
  await assert.rejects(
    runHeadlessTurn({ resumeTurnId: 'turn-1', mode: 'bypass' }, resumed.dependencies),
    (error) => error?.code === 'CLI_RESUME_MODE_CONFLICT' && error?.exitCode === 2,
  )
  assert.equal(recoveryCalls, 0)

  await assert.rejects(
    runHeadlessTurn({
      resumeTurnId: 'turn-1',
      modelProviderId: 'provider-1',
    }, resumed.dependencies),
    (error) => error?.code === 'CLI_RESUME_PROVIDER_CONFLICT' && error?.exitCode === 2,
  )
  assert.equal(recoveryCalls, 0)

  await assert.rejects(
    runHeadlessTurn({
      resumeTurnId: 'turn-1',
      model: 'local-model',
    }, resumed.dependencies),
    (error) => error?.code === 'CLI_RESUME_MODEL_CONFLICT' && error?.exitCode === 2,
  )
  assert.equal(recoveryCalls, 0)
})

test('headless runtime rejects blank model and Provider selections before starting a turn', async () => {
  for (const options of [
    { model: '   ' },
    { modelProviderId: '\t' },
  ]) {
    let startCalls = 0
    const fake = fakeRuntime({
      onStart: () => { startCalls += 1 },
    })
    await assert.rejects(
      runHeadlessTurn({ prompt: 'do not start', ...options }, fake.dependencies),
      (error) => error?.code === 'CLI_OPTION_VALUE_REQUIRED' && error?.exitCode === 2,
    )
    assert.equal(startCalls, 0)
  }
})

test('headless runtime denies dangerous approval without a TTY', async () => {
  let decision
  const fake = fakeRuntime({
    onStart: (_scope, emit) => {
      emit('turn.started')
      emit('approval.required', { approvalId: 'approval-1', toolName: 'bash_exec', args: { command: 'rm file' } })
    },
  })
  fake.dependencies.decideApproval = (value) => {
    decision = value.decision
    fake.emit('approval.resolved', { approvalId: value.id, proceed: false, edited: false, args: null, reason: 'denied' })
    fake.emit('turn.completed', { text: 'dangerous operation denied' })
  }
  fake.dependencies.releaseApproval = () => {}
  const result = await runHeadlessTurn({
    prompt: 'dangerous task', interactive: false,
    onApproval: async () => ({ decision: 'approve' }),
  }, fake.dependencies)
  assert.equal(decision, 'deny')
  assert.equal(result.exitCode, 0)
})

test('headless runtime resolves session and recovers an interrupted turn', async () => {
  const initialEvents = [
    { id: 'event-0', sessionId: 'session-1', turnId: 'turn-1', sequence: 0, type: 'turn.started', payload: {}, createdAt: 1 },
    { id: 'event-1', sessionId: 'session-1', turnId: 'turn-1', sequence: 1, type: 'turn.interrupted', payload: {}, createdAt: 2 },
  ]
  let recovered
  const fake = fakeRuntime({
    initialEvents,
    onRecover: (scope, emit) => {
      recovered = scope
      emit('turn.resumed')
      emit('turn.completed', { text: 'resumed' })
    },
  })
  fake.dependencies.persistenceAdapter = {
    id: 'test.cli-resume',
    eventLog: {
      resolveTurnSession: async ({ userId, turnId }) => {
        assert.equal(userId, 'user-1')
        assert.equal(turnId, 'turn-1')
        return Object.freeze({ status: 'found', sessionId: 'session-1' })
      },
    },
  }
  const output = []
  const result = await runHeadlessTurn({
    resumeTurnId: 'turn-1',
    onEvent: (event) => output.push(event.type),
  }, fake.dependencies)
  assert.equal(recovered.sessionId, 'session-1')
  assert.equal(recovered.turnId, 'turn-1')
  assert.equal(result.status, 'completed')
  assert.deepEqual(output, ['turn.started', 'turn.interrupted', 'turn.resumed', 'turn.completed'])
})
