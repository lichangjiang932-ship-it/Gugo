import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-rewind-tool-'))
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
  APP_DATA_DIR: process.env.APP_DATA_DIR,
}

process.env.APP_DB_PATH = path.join(workspace, 'rewind.db')
process.env.APP_DATA_DIR = path.join(workspace, 'data')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'

const { closeDb, getDb } = await import('../server/db.js')
const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')

const userId = 'rewind-user'
const now = Date.now()
getDb().prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
  .run(userId, 'rewind@example.com', now, now)
setApprovalMode({ userId, mode: 'bypass' })

const targetFile = path.join(workspace, 'notes.txt')

after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* Windows may briefly retain native handles */ }
})

test('rewind_files restores a write_file mutation within the same turn', async () => {
  fs.writeFileSync(targetFile, 'original', 'utf8')
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const rewind = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'rewind_files')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')

  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'rewind-turn',
      userId,
      origin: 'chat',
      sessionId: 'rewind-session',
      prompt: 'Rewrite notes.txt then revert the change.',
    },
    step: { id: 'rewind-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Rewrite notes.txt then revert the change.' }],
    intentMode: 'execute',
    toolSpecs: [writeFile, rewind, readFile],
    maxIters: 8,
    enableToolHooks: false,
    approvalMode: 'bypass',
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'write-1',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes.txt', content: 'changed' }) },
          }],
        }
      }
      if (modelCalls === 2) {
        assert.equal(fs.readFileSync(targetFile, 'utf8'), 'changed')
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'rewind-1',
            type: 'function',
            function: { name: 'rewind_files', arguments: JSON.stringify({ tool_call_id: 'write-1' }) },
          }],
        }
      }
      if (modelCalls === 3) {
        const rewindResult = messages.find((message) => message.role === 'tool' && message.name === 'rewind_files')
        assert.ok(rewindResult, 'rewind_files tool result must reach the model')
        assert.equal(JSON.parse(rewindResult.content).ok, true)
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'read-1',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) },
          }],
        }
      }
      return { content: 'Reverted.', toolCalls: [], finishReason: 'stop' }
    },
  })

  assert.equal(result.text, 'Reverted.')
  assert.equal(fs.readFileSync(targetFile, 'utf8'), 'original')
})
