import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import { cmdMemory } from '../../bin/cli/memoryCommand.js'
import { resolveLocalRuntimeIdentity } from '../../bin/cli/localIdentity.js'
import { closeDb } from '../../server/db.js'
import { reindexUserMemoryEmbeddings } from '../../server/services/memoryEmbeddingReindex.js'

function fixture(t) {
  closeDb()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-memory-command-'))
  const config = path.join(cwd, 'runtime.json')
  const configured = { MEMORY_EMBEDDINGS_ENABLED: '1', MEMORY_EMBEDDING_MODEL: 'fixture-vector',
    MEMORY_EMBEDDING_BASE_URL: 'https://never-request.example.invalid/v1', MEMORY_EMBEDDING_DIMENSIONS: '2' }
  fs.writeFileSync(config, JSON.stringify(configured))
  const env = { APP_DATA_DIR: path.join(cwd, 'data'), APP_DB_PATH: path.join(cwd, 'data', 'app.db'),
    ARTIFACT_DIR: path.join(cwd, 'artifacts'), APP_CONFIG_PATH: config, AUTH_MODE: 'local', GUGO_LOAD_DOTENV: '0' }
  const previous = Object.fromEntries(['APP_DATA_DIR', 'APP_DB_PATH', 'ARTIFACT_DIR'].map((key) => [key, process.env[key]]))
  t.after(() => {
    closeDb()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    assert.ok(path.resolve(cwd).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  let text = ''
  return { cwd, env, config, configured, output: () => text,
    stdout: new Writable({ write(chunk, _encoding, done) { text += String(chunk); done() } }) }
}

for (const mutateAfterIdentity of [false, true]) {
  test(`memory command uses the identity-bound runtime configuration with zero empty-index network requests (config change=${mutateAfterIdentity})`, async (t) => {
    const f = fixture(t)
    let binding
    let consumed
    let fetches = 0
    const result = await cmdMemory(['reindex'], {
      ...f,
      resolveIdentity: async (options) => {
        binding = await resolveLocalRuntimeIdentity(options)
        if (mutateAfterIdentity) fs.writeFileSync(f.config, JSON.stringify({ ...f.configured, MEMORY_EMBEDDINGS_ENABLED: '0' }))
        return binding
      },
      reindexMemory: async (input) => {
        consumed = input
        return reindexUserMemoryEmbeddings({ ...input, fetchImpl: async () => {
          fetches++
          throw new Error('No network is permitted in this empty-index test')
        } })
      },
    })
    assert.equal(result, 0)
    assert.ok(binding.userId)
    assert.equal(consumed.userId, binding.userId)
    assert.equal(consumed.env, binding.runtimeEnv, 'identity and indexing must share one configuration snapshot')
    assert.equal(Object.isFrozen(consumed.env), true)
    assert.equal(consumed.env.MEMORY_EMBEDDINGS_ENABLED, '1')
    assert.equal(f.env.MEMORY_EMBEDDINGS_ENABLED, undefined, 'the raw caller environment must not be mistaken for resolved configuration')
    assert.equal(fetches, 0)
    const done = JSON.parse(f.output())
    assert.equal(done.event, 'done')
    assert.equal(done.ok, true)
    assert.equal(done.indexed, 0)
    assert.equal(done.model, 'fixture-vector')
    assert.equal(done.coverage, 'complete')
  })
}

test('invalid memory flags invoke neither identity nor indexing ports', async () => {
  await assert.rejects(cmdMemory(['reindex', '--batch', '0'], {
    resolveIdentity: () => assert.fail('identity must not initialize'),
    reindexMemory: () => assert.fail('indexing must not run'),
  }), { code: 'CLI_MEMORY_BATCH_INVALID' })
})
