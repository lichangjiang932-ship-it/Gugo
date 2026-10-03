import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

// End-to-end verification of the CLI model/workspace selection contract:
//   - --model/--provider must be exactly what the turn requests;
//   - an ambiguous same-name model must not silently pick a Provider;
//   - --cwd must decide the tool workspace and the applicable project
//     instructions;
//   - a local Provider failure must not fail over to an unauthorized cloud
//     Provider.
// Each case runs the real CLI in a throwaway APP_DATA_DIR with a local fake
// model server, so no real credentials or user data are touched.

const CLI = join(process.cwd(), 'bin', 'yma-cli.js')

function runCliProcess(args, { input = '', env = {}, timeoutMs = 60_000, cwd = process.cwd() } = {}) {
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
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (status, signal) => {
      clearTimeout(timeout)
      resolve({ status, signal, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

function parseJsonLines(output) {
  return String(output || '').split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line))
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

function baseEnv({ dataDir, homeDir }) {
  return {
    APP_DATA_DIR: dataDir,
    APP_DB_PATH: join(dataDir, 'app.db'),
    AUTH_MODE: 'local',
    HOME: homeDir,
    USERPROFILE: homeDir,
    GUGO_LOAD_DOTENV: '0',
    TURN_EXECUTION_LEASE_MS: '1000',
    MODEL_BASE_URL: '',
    MODEL_NAME: '',
    MODEL_API_KEY: '',
    MODEL_PROVIDERS: '',
    WORKSPACE_SHARED_TRUSTED: '1',
    WORKSPACE_FS_ENABLED: '1',
    WORKSPACE_SHELL_ENABLED: '0',
  }
}

function modelServer({ onRequest = () => {}, content = 'selection completed' } = {}) {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let parsed
      try { parsed = JSON.parse(body) } catch { parsed = undefined }
      requests.push({ url: req.url, body: parsed })
      onRequest(parsed)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-selection',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }))
    })
  })
  return { server, requests }
}

/** Seed persisted providers in the isolated database and return their ids. */
function seedProviders(env, providers) {
  const moduleUrl = (relative) => pathToFileURL(join(process.cwd(), relative)).href
  const script = `
    const { bootstrapAuth } = await import(${JSON.stringify(moduleUrl('server/adapters/authAccount.js'))})
    const { upsertModelProvider, recordModelProviderReadiness } = await import(${JSON.stringify(moduleUrl('server/services/modelProviderStore.js'))})
    const { closeDb } = await import(${JSON.stringify(moduleUrl('server/db.js'))})
    const specs = JSON.parse(process.env.GUGO_TEST_PROVIDERS)
    try {
      const auth = bootstrapAuth({ env: process.env })
      const ids = []
      for (const spec of specs) {
        const provider = upsertModelProvider({ userId: auth.user.id, provider: {
          key: spec.key, label: spec.label, baseUrl: spec.baseUrl, apiKey: '',
          models: spec.models, defaultModel: spec.defaultModel, enabled: true, isDefault: spec.isDefault === true,
        } })
        recordModelProviderReadiness({ userId: auth.user.id, id: provider.id,
          modelName: spec.defaultModel, expectedConfigRevision: provider.configRevision,
          readiness: { chat: true, tools: true, agent: true, mode: 'agent' } })
        ids.push(provider.id)
      }
      process.stdout.write(JSON.stringify(ids))
    } finally { closeDb() }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env, GUGO_TEST_PROVIDERS: JSON.stringify(providers) },
  })
  assert.equal(result.status, 0, `provider seed failed:\n${result.stdout}\n${result.stderr}`)
  return JSON.parse(result.stdout.trim())
}

function withIsolation(name, run) {
  return async () => {
    const dataDir = mkdtempSync(join(tmpdir(), `gugo-${name}-data-`))
    const homeDir = mkdtempSync(join(tmpdir(), `gugo-${name}-home-`))
    const workspace = mkdtempSync(join(tmpdir(), `gugo-${name}-ws-`))
    try {
      await run({ dataDir, homeDir, workspace, env: baseEnv({ dataDir, homeDir }) })
    } finally {
      for (const dir of [dataDir, homeDir, workspace]) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
      }
    }
  }
}

test('a same-name model across Providers fails closed without --provider', withIsolation('ambiguous', async ({ env, workspace }) => {
  const first = modelServer()
  const second = modelServer()
  const firstPort = await listen(first.server)
  const secondPort = await listen(second.server)
  try {
    seedProviders(env, [
      { key: 'provider-a', label: 'Provider A', baseUrl: `http://127.0.0.1:${firstPort}/v1`, models: ['shared-model'], defaultModel: 'shared-model', isDefault: true },
      { key: 'provider-b', label: 'Provider B', baseUrl: `http://127.0.0.1:${secondPort}/v1`, models: ['shared-model'], defaultModel: 'shared-model' },
    ])
    const result = await runCliProcess(['run', 'say hello', '--model', 'shared-model', '--mode', 'plan', '--cwd', workspace], { env })
    assert.notEqual(result.status, 0)
    const events = parseJsonLines(result.stdout)
    const codes = events.flatMap((event) => [
      event?.error?.code,
      event?.payload?.code,
    ]).filter(Boolean)
    assert.ok(
      codes.includes('MODEL_PROVIDER_AMBIGUOUS') || /MODEL_PROVIDER_AMBIGUOUS/u.test(result.stderr + result.stdout),
      `expected MODEL_PROVIDER_AMBIGUOUS, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
    assert.equal(first.requests.length, 0, 'an ambiguous model must not be sent to either Provider')
    assert.equal(second.requests.length, 0)
  } finally {
    await closeServer(first.server)
    await closeServer(second.server)
  }
}))

test('--provider disambiguates the same-name model and receives the request', withIsolation('disambiguate', async ({ env, workspace }) => {
  const chosen = modelServer({ content: 'chosen provider answered' })
  const other = modelServer({ content: 'wrong provider answered' })
  const chosenPort = await listen(chosen.server)
  const otherPort = await listen(other.server)
  try {
    const [chosenId] = seedProviders(env, [
      { key: 'provider-chosen', label: 'Chosen', baseUrl: `http://127.0.0.1:${chosenPort}/v1`, models: ['shared-model'], defaultModel: 'shared-model' },
      { key: 'provider-other', label: 'Other', baseUrl: `http://127.0.0.1:${otherPort}/v1`, models: ['shared-model'], defaultModel: 'shared-model', isDefault: true },
    ])
    const result = await runCliProcess([
      'run', 'say hello', '--model', 'shared-model', '--provider', chosenId, '--mode', 'plan', '--cwd', workspace, '--progress',
    ], { env })
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    const events = parseJsonLines(result.stdout)
    const started = events.find((event) => event.type === 'turn.started')
    assert.equal(started?.payload?.modelProviderId, chosenId)
    assert.equal(started?.payload?.modelName, 'shared-model')
    assert.equal(events.find((event) => event.type === 'turn.completed')?.payload?.text, 'chosen provider answered')
    // --progress writes facts to stderr and leaves stdout as pure JSONL.
    assert.match(result.stderr, /\[gugo\] turn started/u)
    assert.doesNotMatch(result.stdout, /\[gugo\]/u)
    assert.equal(chosen.requests.length, 1)
    assert.equal(other.requests.length, 0, 'the default Provider must not answer an explicit --provider turn')
    assert.equal(chosen.requests[0].body.model, 'shared-model')
  } finally {
    await closeServer(chosen.server)
    await closeServer(other.server)
  }
}))

test('--cwd selects the tool workspace and its project instructions', withIsolation('cwd', async ({ env, workspace }) => {
  const marker = 'CLI_CWD_INSTRUCTION_MARKER_9f3a'
  writeFileSync(join(workspace, 'AGENTS.md'), `# Workspace\n\n${marker}\n`)
  const model = modelServer({ content: 'workspace answered' })
  const port = await listen(model.server)
  try {
    seedProviders(env, [
      { key: 'cwd-provider', label: 'CWD Provider', baseUrl: `http://127.0.0.1:${port}/v1`, models: ['cwd-model'], defaultModel: 'cwd-model', isDefault: true },
    ])
    const result = await runCliProcess([
      'run', 'say hello', '--model', 'cwd-model', '--mode', 'plan', '--cwd', workspace,
    ], { env })
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.equal(model.requests.length, 1)
    const serialized = JSON.stringify(model.requests[0].body.messages)
    assert.match(serialized, new RegExp(marker, 'u'), 'project instructions must come from --cwd')
    const started = parseJsonLines(result.stdout).find((event) => event.type === 'turn.started')
    assert.ok(started, 'turn.started must be emitted')
  } finally {
    await closeServer(model.server)
  }
}))

test('a failing local Provider never fails over to an unauthorized cloud Provider', withIsolation('no-failover', async ({ env, workspace }) => {
  const cloud = modelServer({ content: 'cloud provider answered' })
  const cloudPort = await listen(cloud.server)
  const failingLocal = createServer((req, res) => { req.resume(); res.destroy() })
  const localPort = await listen(failingLocal)
  try {
    const [localId] = seedProviders(env, [
      { key: 'local-provider', label: 'Local', baseUrl: `http://127.0.0.1:${localPort}/v1`, models: ['local-model'], defaultModel: 'local-model', isDefault: true },
      { key: 'cloud-provider', label: 'Cloud', baseUrl: `http://127.0.0.1:${cloudPort}/v1`, models: ['cloud-model'], defaultModel: 'cloud-model' },
    ])
    const result = await runCliProcess([
      'run', 'say hello', '--provider', localId, '--model', 'local-model', '--mode', 'plan', '--cwd', workspace,
    ], { env })
    assert.notEqual(result.status, 0, 'a broken local Provider must fail the turn')
    assert.equal(cloud.requests.length, 0, 'the cloud Provider must never receive an unauthorized failover request')
  } finally {
    await closeServer(cloud.server)
    await closeServer(failingLocal)
  }
}))
