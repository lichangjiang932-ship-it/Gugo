import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-attachment-continuity-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser } = await import('../server/db.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const {
  estimateContextTokens,
  getAutoCompactionThreshold,
} = await import('../server/services/contextCompactionRuntime.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { listTurnEvents } = await import('../server/services/turnEventStore.js')
const { getTurnCheckpoint } = await import('../server/services/turnCheckpointStore.js')

const userId = 'attachment-continuity-user'
const sessionId = 'attachment-continuity-session'
const attachmentId = 'attachment-continuity-image'

createUser({ id: userId, email: 'attachment-continuity@example.com' })
upsertSession({ id: sessionId, userId, title: 'Attachment continuity' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('TurnEngine sends attachment bytes once per relevant turn while checkpoints stay lightweight', async () => {
  const providerRequests = []
  const preparedRequests = []
  const attachment = {
    id: attachmentId,
    name: 'diagram.png',
    mimeType: 'image/png',
    size: 5,
    sha256: 'a'.repeat(64),
    status: 'ready',
    sessionId,
    messageId: null,
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

  await engine.startTurn({
    userId,
    sessionId,
    turnId: 'attachment-unrelated-turn',
    content: 'Now explain why concise prompts help.',
  })
  await engine.waitForTurn({ userId, sessionId, turnId: 'attachment-unrelated-turn' })

  assert.equal(providerRequests.length, 6)
  assert.match(JSON.stringify(providerRequests[0]), /data:image\/png;base64,aW1hZ2U=/)
  assert.doesNotMatch(JSON.stringify(providerRequests[1]), /base64,/)
  assert.match(JSON.stringify(providerRequests[1]), /attachment:\/\/attachment-continuity-image/)
  assert.match(JSON.stringify(providerRequests[2]), /data:image\/png;base64,aW1hZ2U=/)
  assert.doesNotMatch(JSON.stringify(providerRequests[3]), /base64,/)
  assert.doesNotMatch(JSON.stringify(providerRequests[4]), /base64,/)
  assert.doesNotMatch(JSON.stringify(providerRequests[5]), /base64,/)
  assert.equal(preparedRequests.length, 2)
  assert.equal(preparedRequests[0].text, 'inspect the image')
  assert.equal(preparedRequests[1].text, 'inspect the image')
  assert.ok(preparedRequests.every((request) => request.maxAttachmentTokens > 0))

  for (const turnId of ['attachment-first-turn', 'attachment-follow-up-turn', 'attachment-unrelated-turn']) {
    const checkpoint = listTurnEvents({
      requestedUser: userId,
      userId,
      sessionId,
      turnId,
      limit: 100,
    }).find((event) => event.type === 'turn.checkpoint')
    assert.ok(checkpoint)
    assert.equal(checkpoint.payload.storage, 'turn_checkpoints')
    assert.doesNotMatch(JSON.stringify(checkpoint.payload), /base64,/)
    const stored = getTurnCheckpoint({ userId, sessionId, turnId })
    assert.ok(stored)
    assert.doesNotMatch(JSON.stringify(stored.state), /base64,/)
  }
})

test('TurnEngine re-prices a large extracted text attachment after materialization', async () => {
  const contextWindow = 4_096
  const textSessionId = 'attachment-large-text-session'
  const textAttachmentId = 'attachment-large-text'
  const attachment = {
    id: textAttachmentId,
    name: 'large-notes.txt',
    mimeType: 'text/plain',
    size: 200_000,
    sha256: 'b'.repeat(64),
    status: 'ready',
    sessionId: textSessionId,
    messageId: null,
    uri: `attachment://${textAttachmentId}`,
    downloadUrl: `/api/attachments/${textAttachmentId}/content`,
  }
  const providerRequests = []
  const preparationBudgets = []
  upsertSession({ id: textSessionId, userId, title: 'Large text attachment budget' })
  const engine = new TurnEngine({
    executionLeases: {
      claim: () => true,
      hold: () => () => {},
      hasActiveSession: () => false,
    },
    validateAttachments: ({ attachmentIds }) => (
      attachmentIds.includes(textAttachmentId) ? [attachment] : []
    ),
    bindAttachments: () => {},
    prepareAttachments: async (request) => {
      preparationBudgets.push(request.maxAttachmentTokens)
      return {
        attachments: [attachment],
        content: [
          { type: 'text', text: request.text },
          { type: 'text', text: `TEXT_BUDGET_HEAD\n${'x'.repeat(200_000)}\nTEXT_BUDGET_TAIL` },
        ],
      }
    },
    preparePromptContext: async () => ({
      messages: [], effectiveAgentId: null, skillIds: [], memoryIds: [],
    }),
    resolveToolSpecs: async ({ baseSpecs }) => baseSpecs,
    getContextWindow: () => contextWindow,
    runModel: async (request) => {
      providerRequests.push(request.messages)
      return { content: 'done', toolCalls: [] }
    },
    runLoop: async (options) => {
      await options.runModel({ messages: options.messages, tools: [], signal: options.signal })
      return { text: 'done', artifactIds: [], iterations: 1 }
    },
    scheduleMemoryExtraction: () => {},
  })

  await engine.startTurn({
    userId,
    sessionId: textSessionId,
    turnId: 'attachment-large-text-turn',
    content: 'inspect the text attachment',
    attachments: [{ id: textAttachmentId }],
  })
  await engine.waitForTurn({ userId, sessionId: textSessionId, turnId: 'attachment-large-text-turn' })

  assert.equal(providerRequests.length, 1)
  assert.equal(preparationBudgets.length, 1)
  assert.ok(preparationBudgets[0] > 0)
  const payload = JSON.stringify(providerRequests[0])
  assert.doesNotMatch(payload, /TEXT_BUDGET_TAIL/)
  assert.match(payload, /attachment:\/\/attachment-large-text/)
  assert.ok(
    estimateContextTokens(providerRequests[0], []) < getAutoCompactionThreshold(contextWindow),
  )
})

test('TurnEngine removes an oversized image data URL from the final provider surface', async () => {
  const contextWindow = 4_096
  const imageSessionId = 'attachment-large-image-session'
  const imageAttachmentId = 'attachment-large-image'
  const attachment = {
    id: imageAttachmentId,
    name: 'large-diagram.png',
    mimeType: 'image/png',
    size: 200_000,
    sha256: 'c'.repeat(64),
    status: 'ready',
    sessionId: imageSessionId,
    messageId: null,
    uri: `attachment://${imageAttachmentId}`,
    downloadUrl: `/api/attachments/${imageAttachmentId}/content`,
  }
  const oversizedDataUrl = `data:image/png;base64,${Buffer.alloc(200_000, 7).toString('base64')}`
  const providerRequests = []
  upsertSession({ id: imageSessionId, userId, title: 'Large image attachment budget' })
  const engine = new TurnEngine({
    executionLeases: {
      claim: () => true,
      hold: () => () => {},
      hasActiveSession: () => false,
    },
    validateAttachments: ({ attachmentIds }) => (
      attachmentIds.includes(imageAttachmentId) ? [attachment] : []
    ),
    bindAttachments: () => {},
    prepareAttachments: async (request) => ({
      attachments: [attachment],
      content: [
        { type: 'text', text: request.text },
        { type: 'image_url', image_url: { url: oversizedDataUrl } },
      ],
    }),
    preparePromptContext: async () => ({
      messages: [], effectiveAgentId: null, skillIds: [], memoryIds: [],
    }),
    resolveToolSpecs: async ({ baseSpecs }) => baseSpecs,
    getContextWindow: () => contextWindow,
    runModel: async (request) => {
      providerRequests.push(request.messages)
      return { content: 'done', toolCalls: [] }
    },
    runLoop: async (options) => {
      await options.runModel({ messages: options.messages, tools: [], signal: options.signal })
      return { text: 'done', artifactIds: [], iterations: 1 }
    },
    scheduleMemoryExtraction: () => {},
  })

  await engine.startTurn({
    userId,
    sessionId: imageSessionId,
    turnId: 'attachment-large-image-turn',
    content: 'inspect the image attachment',
    attachments: [{ id: imageAttachmentId }],
  })
  await engine.waitForTurn({ userId, sessionId: imageSessionId, turnId: 'attachment-large-image-turn' })

  assert.equal(providerRequests.length, 1)
  const payload = JSON.stringify(providerRequests[0])
  assert.doesNotMatch(payload, /base64,/)
  assert.match(payload, /attachment:\/\/attachment-large-image/)
  assert.ok(
    estimateContextTokens(providerRequests[0], []) < getAutoCompactionThreshold(contextWindow),
  )
})
