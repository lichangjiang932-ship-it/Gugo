import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-model-proxy-preparation-'))
const envKeys = [
  'AGENT_INJECT_ENABLED',
  'APP_DATA_DIR',
  'APP_DB_PATH',
  'GUGO_LOAD_DOTENV',
  'HOOKS_SHELL_ALLOWED_COMMANDS',
  'HOOKS_SHELL_ENABLED',
  'MODEL_API_KEY',
  'MODEL_BASE_URL',
  'MODEL_NAME',
  'MODEL_PROVIDERS',
]
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
Object.assign(process.env, {
  AGENT_INJECT_ENABLED: '0',
  APP_DATA_DIR: tempDir,
  APP_DB_PATH: path.join(tempDir, 'app.db'),
  GUGO_LOAD_DOTENV: '0',
  HOOKS_SHELL_ALLOWED_COMMANDS: process.execPath,
  HOOKS_SHELL_ENABLED: '1',
  MODEL_API_KEY: '',
  MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
  MODEL_NAME: 'preparation-test-model',
  MODEL_PROVIDERS: '',
})

const { prepareModelProxyRequest } = await import('../server/adapters/modelProxyRequestPreparation.js')
const { handleModelProxyRequest } = await import('../server/adapters/modelProxy.js')
const { upsertHook } = await import('../server/services/hooksService.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const sourceUrl = new URL('../server/adapters/modelProxyRequestPreparation.js', import.meta.url)
const nativeFetch = globalThis.fetch

function createResponse() {
  return {
    statusCode: null,
    body: '',
    headers: new Map(),
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    },
    end(body = '') {
      this.body = String(body)
    },
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), String(value))
    },
  }
}

function shellJsonHook(value) {
  return [process.execPath, '-e', `process.stdout.write(JSON.stringify(${JSON.stringify(value)}))`]
}

test.after(() => {
  globalThis.fetch = nativeFetch
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnv[key]
  }
})

test('request preparation returns a frozen DTO and preserves explicit output-budget boosting', async () => {
  const candidate = {
    providerId: 'local',
    modelName: 'preparation-test-model',
    baseUrl: 'http://127.0.0.1:11434/v1',
    maxTokens: 512,
  }
  const messages = [{ role: 'user', content: 'hello' }]
  const prepared = await prepareModelProxyRequest({
    req: { headers: {} },
    res: createResponse(),
    body: { maxTokensBoost: 2048 },
    testMode: true,
    runtimeEnv: {},
    selectedModel: candidate.modelName,
    requestConfig: candidate,
    requestProfile: { supportsVision: true },
    resolvedCandidates: [candidate],
    compactionArchivePort: null,
    hookRequestId: 'preparation-frozen-dto',
    messages,
    hasVisionContent: () => false,
  })

  assert.equal(Object.isFrozen(prepared), true)
  assert.equal(Object.isFrozen(prepared.requestCandidates), true)
  assert.equal(Object.isFrozen(prepared.injectedMemoryIds), true)
  assert.equal(Object.isFrozen(prepared.compilerFingerprints), true)
  assert.equal(prepared.messages, messages)
  assert.equal(prepared.requestCandidates[0].maxTokens, 2048)
  assert.deepEqual(prepared.autoMemorySourceMessages, [])
})

test('request preparation stays outside model transport, retry, and response parsing', async () => {
  const source = await readFile(sourceUrl, 'utf8')
  for (const forbidden of [
    "from './modelProxy.js'",
    "from './modelStreamingTransport.js'",
    "from './modelFailover.js'",
    "from '../utils/modelRetry.js'",
    "from './modelProviderResponse.js'",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})

test('a prompt Hook rejection releases the caller-owned archive lease exactly once', async () => {
  const auth = issueTestSession({ email: 'model-preparation-hook-reject@example.com' })
  upsertHook({
    userId: auth.userId,
    event: 'user_prompt_submit',
    toolPattern: 'chat',
    kind: 'shell',
    command: shellJsonHook({ allow: false, reason: 'prompt denied by contract' }),
    enabled: true,
    blocking: true,
    timeoutMs: 5000,
  })

  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    throw new Error('upstream must not be called')
  }
  let acquisitions = 0
  let releases = 0
  const acquireCompactionArchivePort = () => {
    acquisitions += 1
    return {
      port: {},
      release() {
        releases += 1
        return true
      },
    }
  }
  const requestBody = JSON.stringify({
    messages: [{ role: 'user', content: 'blocked prompt' }],
  })
  const req = {
    method: 'POST',
    url: '/api/model/chat',
    headers: { authorization: `Bearer ${auth.token}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(requestBody)
    },
  }
  const res = createResponse()

  await handleModelProxyRequest(req, res, { acquireCompactionArchivePort })

  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'prompt denied by contract' })
  assert.equal(acquisitions, 1)
  assert.equal(releases, 1)
  assert.equal(fetches, 0)
})
