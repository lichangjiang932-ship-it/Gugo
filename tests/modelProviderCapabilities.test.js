import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-provider-caps-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')

const { closeDb, createUser, DB_SCHEMA_VERSION } = await import('../server/db.js')
const { buildUserModelEnv, upsertModelProvider, listModelProviders } =
  await import('../server/services/modelProviderStore.js')
const { profileForConfig, loadModelConfig, resolveModelFailoverConfigs } =
  await import('../server/adapters/modelProxy.js')

test.after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

let userSeq = 0
function newUser(email) {
  userSeq += 1
  const id = `u-caps-${userSeq}`
  createUser({ id, email })
  return id
}

test('schema 已推到 v28', () => {
  assert.ok(DB_SCHEMA_VERSION >= 28)
})

test('v28 能力字段能存能取,留空的保持 null(= 自动推断)', () => {
  const userId = newUser('caps-roundtrip@example.com')
  const saved = upsertModelProvider({
    userId,
    provider: {
      key: 'local-ollama',
      label: 'Local Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['qwen2.5:7b'],
      defaultModel: 'qwen2.5:7b',
      contextWindow: 32768,
      supportsTools: true,
      firstTokenTimeoutMs: 900_000,
      keepAlive: '2h',
      // supportsVision / supportsStreaming / idleTimeoutMs / failoverEnabled 不传
    },
  })
  assert.equal(saved.contextWindow, 32768)
  assert.equal(saved.supportsTools, true)
  assert.equal(saved.firstTokenTimeoutMs, 900_000)
  assert.equal(saved.keepAlive, '2h')
  // 没传的必须是 null,不能被当成 false —— null 才会走自动推断
  assert.equal(saved.supportsVision, null)
  assert.equal(saved.supportsStreaming, null)
  assert.equal(saved.idleTimeoutMs, null)
  assert.equal(saved.failoverEnabled, null)
})

test('只改一个字段时,其它能力配置不被抹掉', () => {
  const userId = newUser('caps-partial@example.com')
  const created = upsertModelProvider({
    userId,
    provider: {
      key: 'p1',
      label: 'P1',
      baseUrl: 'http://127.0.0.1:1234/v1',
      models: ['m1'],
      defaultModel: 'm1',
      contextWindow: 8192,
      supportsTools: false,
    },
  })
  // 只改 label,完全不提交能力字段
  const updated = upsertModelProvider({
    userId,
    provider: { id: created.id, key: 'p1', label: 'P1 改名', baseUrl: 'http://127.0.0.1:1234/v1', models: ['m1'], defaultModel: 'm1' },
  })
  assert.equal(updated.label, 'P1 改名')
  assert.equal(updated.contextWindow, 8192, '未提交的字段不该被清空')
  assert.equal(updated.supportsTools, false)
})

test('能力配置一路传到 endpointProfile —— 这是整条链路的意义所在', () => {
  const userId = newUser('caps-profile@example.com')
  upsertModelProvider({
    userId,
    provider: {
      key: 'tuned',
      label: 'Tuned',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['qwen2.5:7b'],
      defaultModel: 'qwen2.5:7b',
      isDefault: true,
      contextWindow: 32768,
      supportsTools: false,
      idleTimeoutMs: 45_000,
      keepAlive: '1h',
    },
  })
  const env = buildUserModelEnv({ userId, env: { MODEL_STRICT_SELECTION: '0' } })
  const config = loadModelConfig(env)
  const profile = profileForConfig(config, env)

  assert.equal(profile.contextWindow, 32768, 'provider 配的窗口要压过默认值')
  assert.equal(profile.supportsTools, false, '关掉工具支持后就不该再下发 tools')
  assert.equal(profile.timeouts.idleMs, 45_000)
  assert.equal(profile.keepAlive, '1h')
  assert.equal(profile.isLocal, true)
  assert.equal(profile.failoverEligible, false, '本地端点默认不允许 failover')
})

test('本地 provider 为默认时不会把云端 provider 当备选', () => {
  const userId = newUser('caps-failover@example.com')
  upsertModelProvider({
    userId,
    provider: {
      key: 'local', label: 'Local', baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['qwen2.5:7b'], defaultModel: 'qwen2.5:7b', isDefault: true,
    },
  })
  upsertModelProvider({
    userId,
    provider: {
      key: 'cloud', label: 'Cloud', baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-chat'], defaultModel: 'deepseek-chat', apiKey: 'sk-x',
    },
  })
  const env = buildUserModelEnv({ userId, env: {} })
  const configs = resolveModelFailoverConfigs({ modelName: 'qwen2.5:7b', env })
  assert.equal(configs.length, 1)
  assert.ok(configs[0].baseUrl.includes('127.0.0.1'))
})

test('显式打开 failover 后本地也能切云端', () => {
  const userId = newUser('caps-failover-on@example.com')
  upsertModelProvider({
    userId,
    provider: {
      key: 'local', label: 'Local', baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['qwen2.5:7b'], defaultModel: 'qwen2.5:7b', isDefault: true,
      failoverEnabled: true,
    },
  })
  upsertModelProvider({
    userId,
    provider: {
      key: 'cloud', label: 'Cloud', baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-chat'], defaultModel: 'deepseek-chat', apiKey: 'sk-x',
    },
  })
  const env = buildUserModelEnv({ userId, env: { MODEL_STRICT_SELECTION: '0' } })
  const configs = resolveModelFailoverConfigs({ modelName: 'qwen2.5:7b', env })
  assert.ok(configs.length >= 2, '显式打开后应保留备选')
})

test('老 provider(所有能力字段为 NULL)行为和升级前一致', () => {
  const userId = newUser('caps-legacy@example.com')
  upsertModelProvider({
    userId,
    provider: {
      key: 'legacy', label: 'Legacy', baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-chat'], defaultModel: 'deepseek-chat', apiKey: 'sk-x', isDefault: true,
    },
  })
  const [provider] = listModelProviders({ userId })
  assert.equal(provider.contextWindow, null)
  assert.equal(provider.supportsTools, null)

  const env = buildUserModelEnv({ userId, env: {} })
  const profile = profileForConfig(loadModelConfig(env), env)
  // 云端默认:允许 failover、支持工具、128k 窗口
  assert.equal(profile.failoverEligible, true)
  assert.equal(profile.supportsTools, true)
  assert.equal(profile.contextWindow, 128_000)
  assert.equal(profile.timeouts.requestMs, 60_000, '云端超时保持改造前的值')
})
