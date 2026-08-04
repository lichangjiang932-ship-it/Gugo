import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-artifacts-'))
process.env.APP_DATA_DIR = tempDir
process.env.ARTIFACT_DIR = path.join(tempDir, 'artifacts')

const { closeDb, createUser } = await import('../server/db.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { getTurnArtifactByFilename, listTurnArtifacts } = await import('../server/services/turnArtifactStore.js')

createUser({ id: 'artifact-user', email: 'turn-artifact@example.com' })
upsertSession({ id: 'artifact-session', userId: 'artifact-user', title: 'Artifacts' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('chat TurnEngine persists generated files without a jobs-table foreign key', async () => {
  let calls = 0
  const engine = new TurnEngine({
    runModel: async () => {
      calls += 1
      return calls === 1
        ? {
            content: '',
            toolCalls: [{
              id: 'doc-call',
              function: { name: 'create_docx', arguments: JSON.stringify({ title: 'Turn Doc', paragraphs: [{ text: 'hello' }] }) },
            }],
          }
        : { content: '文档已生成。', toolCalls: [] }
    },
  })
  await engine.startTurn({
    userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'artifact-turn', content: '生成 Word 文档',
  })
  await engine.waitForTurn({ userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'artifact-turn' })
  const artifacts = listTurnArtifacts({ userId: 'artifact-user', sessionId: 'artifact-session', turnId: 'artifact-turn' })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].type, 'docx')
  assert.equal(getTurnArtifactByFilename(artifacts[0].filename).userId, 'artifact-user')
  assert.deepEqual(listTurnArtifacts({ userId: 'other-user', sessionId: 'artifact-session', turnId: 'artifact-turn' }), [])
})
