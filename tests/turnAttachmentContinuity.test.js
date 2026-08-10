import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-attachment-continuity-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser } = await import('../server/db.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { listTurnEvents } = await import('../server/services/turnEventStore.js')

const userId = 'attachment-continuity-user'
const sessionId = 'attachment-continuity-session'
const attachmentId = 'attachment-continuity-image'

createUser({ id: userId, email: 'attachment-continuity@example.com' })
upsertSession({ id: sessionId, userId, title: 'Attachment continuity' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('TurnEngine rematerializes prior attachments on follow-up while checkpoints stay lightweight', async () => {
  const providerRequests = []
  const preparedRequests = []
  const attachment = {
    id: attachmentId,
    name: 'diagram.png',
    mimeType: 'image/png',
    size: 5,
    sha256: 'image-hash',
    uri: `attachment://${attachmentId}`,
    downloadUrl: `/api/attachments/${attachmentId}/content`,
  }
  const engine = new TurnEngine({
    executionLeases: {
      claim: () => true,
      hold: () => () => {},
      hasActiveSession: () => false,
    },
    validateAttachments: ({ attachmentIds }) => (
      attachmentIds.includes(attachmentId) ? [attachment] : []
    ),
    bindAttachments: () => {},
    prepareAttachments: async (request) => {
      preparedRequests.push(request)
      return {
        attachments: [attachment],
        content: [
          { type: 'text', text: request.text },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
        ],
      }
    },
    preparePromptContext: async () => ({
      messages: [], effectiveAgentId: null, skillIds: [], memoryIds: [],
    }),
    resolveToolSpecs: async ({ baseSpecs }) => baseSpecs,
    getContextWindow: () => 32_000,
    runModel: async (request) => {
      providerRequests.push(request.messages)
      return { content: 'done', toolCalls: [] }
    },
    runLoop: async (options) => {
      await options.runModel({ messages: options.messages, tools: [], signal: options.signal })
      await options.saveCheckpoint({
        messages: options.messages,
        toolCalls: [],
        artifactIds: [],
        iterations: 1,
      })
      return { text: 'done', artifactIds: [], iterations: 1 }
    },
    scheduleMemoryExtraction: () => {},
  })

  await engine.startTurn({
    userId,
    sessionId,
    turnId: 'attachment-first-turn',
    content: '/document inspect the image',
    attachments: [{ id: attachmentId }],
  })
  await engine.waitForTurn({ userId, sessionId, turnId: 'attachment-first-turn' })

  await engine.startTurn({
    userId,
    sessionId,
    turnId: 'attachment-follow-up-turn',
    content: 'What is shown in the same image?',
  })
  await engine.waitForTurn({ userId, sessionId, turnId: 'attachment-follow-up-turn' })

  assert.equal(providerRequests.length, 2)
  assert.match(JSON.stringify(providerRequests[0]), /data:image\/png;base64,aW1hZ2U=/)
  assert.match(JSON.stringify(providerRequests[1]), /data:image\/png;base64,aW1hZ2U=/)
  assert.equal(preparedRequests.length, 2)
  assert.equal(preparedRequests[0].text, 'inspect the image')
  assert.equal(preparedRequests[1].text, 'inspect the image')

  for (const turnId of ['attachment-first-turn', 'attachment-follow-up-turn']) {
    const checkpoint = listTurnEvents({
      requestedUser: userId,
      userId,
      sessionId,
      turnId,
      limit: 100,
    }).find((event) => event.type === 'turn.checkpoint')
    assert.ok(checkpoint)
    assert.doesNotMatch(JSON.stringify(checkpoint.payload.state), /base64,/)
  }
})
