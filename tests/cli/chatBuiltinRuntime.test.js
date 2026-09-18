import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import { cmdChat } from '../../bin/yma-cli.js'
import { closeDb } from '../../server/db.js'

test('chat starts and exits through the real builtin runtime without an injected runTurn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-chat-builtin-'))
  const taskDir = path.join(root, 'untrusted-task')
  fs.mkdirSync(taskDir)
  fs.writeFileSync(path.join(taskDir, '.env'), 'GUGO_TURN_PERSISTENCE_MODULE_PATH=./must-not-load.mjs\nAPP_DATA_DIR=./wrong-data\n')
  const env = { ...process.env, APP_DATA_DIR: path.join(root, 'runtime'), APP_DB_PATH: path.join(root, 'runtime/app.db'),
    ARTIFACT_DIR: path.join(root, 'artifacts'), GUGO_LOAD_DOTENV: '0', AUTH_MODE: 'local',
    MODEL_BASE_URL: '', MODEL_NAME: '', MODEL_PROVIDERS: '', MODEL_API_KEY: '' }
  const chunks = []
  const out = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done() } })
  try {
    const code = await cmdChat({ mode: 'normal', cwd: taskDir }, {
      runtimeCwd: root, env, stdout: out, stderr: out, lines: ['/help', '/exit'],
    })
    assert.equal(code, 0)
    assert.match(chunks.join(''), /Commands:/)
    assert.equal(fs.existsSync(env.APP_DB_PATH), true)
    assert.equal(fs.existsSync(path.join(taskDir, 'wrong-data')), false)
  } finally {
    closeDb()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
