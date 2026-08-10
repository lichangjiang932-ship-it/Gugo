import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-managed-attachments-'))
process.env.APP_DATA_DIR = tempDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb, getDb } = await import('../server/db.js')
const { readFileTool } = await import('../server/adapters/fsShellTools.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { listMessages, upsertSession } = await import('../server/services/sessionStore.js')
const { uploadChatAttachment } = await import('../src/lib/attachmentClient.js')
const { getClipboardFiles } = await import('../src/lib/chatAttachmentFiles.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({ AUTH_MODE: 'multi_user' }) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const alice = issueTestSession({ email: 'managed-attachment-alice@example.com' })
const bob = issueTestSession({ email: 'managed-attachment-bob@example.com' })
const sessionId = 'managed-attachment-session'
upsertSession({ id: sessionId, userId: alice.userId, title: 'Managed attachments' })

const pdfBytes = Buffer.from([
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog >> endobj',
  '2 0 obj << /Length 58 >> stream',
  'BT /F1 12 Tf 72 720 Td (Managed PDF hello from Gugo) Tj ET',
  'endstream endobj',
  'trailer << /Root 1 0 R >>',
  '%%EOF',
].join('\n'))

const { default: JSZip } = await import('jszip')
const docxZip = new JSZip()
docxZip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
docxZip.file('word/document.xml', [
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
  '<w:body><w:p><w:r><w:t>Managed Office document from Gugo</w:t></w:r></w:p></w:body>',
  '</w:document>',
].join(''))
const docxBytes = await docxZip.generateAsync({ type: 'nodebuffer' })

let uploaded = null

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function authorization(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra }
}

test('raw binary upload persists identical bytes and returns stable metadata', async () => {
  const response = await fetch(
    `${origin}/api/attachments?filename=${encodeURIComponent('sample.pdf')}&sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: 'POST',
      headers: authorization(alice.token, { 'Content-Type': 'application/pdf' }),
      body: pdfBytes,
    },
  )
  assert.equal(response.status, 201)
  uploaded = (await response.json()).attachment
  assert.equal(uploaded.name, 'sample.pdf')
  assert.equal(uploaded.mimeType, 'application/pdf')
  assert.equal(uploaded.size, pdfBytes.length)
  assert.equal(uploaded.sha256, crypto.createHash('sha256').update(pdfBytes).digest('hex'))
  assert.equal(uploaded.uri, `attachment://${uploaded.id}`)
  assert.equal(uploaded.status, 'ready')

  const contentResponse = await fetch(`${origin}${uploaded.downloadUrl}`, {
    headers: authorization(alice.token),
  })
  assert.equal(contentResponse.status, 200)
  assert.equal(contentResponse.headers.get('content-type'), 'application/pdf')
  assert.deepEqual(Buffer.from(await contentResponse.arrayBuffer()), pdfBytes)
})

test('clipboard File travels through the browser client, HTTP storage, and attachment URI as real bytes', async () => {
  const originalText = 'Clipboard real bytes\n剪贴板附件可由模型读取\nline 3'
  const originalBytes = Buffer.from(originalText, 'utf8')
  const clipboardFile = new File([originalBytes], 'clipboard-bytes.txt', {
    type: 'text/plain',
  })
  const [file] = getClipboardFiles({
    items: [{ kind: 'file', type: clipboardFile.type, getAsFile: () => clipboardFile }],
  })

  const attachment = await uploadChatAttachment(file, {
    sessionId,
    fetchImpl: (url, options) => fetch(`${origin}${url}`, {
      ...options,
      headers: authorization(alice.token, options.headers),
    }),
  })

  assert.equal(attachment.size, originalBytes.length)
  assert.equal(attachment.sha256, crypto.createHash('sha256').update(originalBytes).digest('hex'))
  const stored = getDb().prepare(
    'SELECT storage_path FROM managed_attachments WHERE id = ? AND user_id = ?',
  ).get(attachment.id, alice.userId)
  assert.ok(stored)
  assert.deepEqual(
    fs.readFileSync(path.join(tempDir, 'attachments', ...stored.storage_path.split('/'))),
    originalBytes,
  )

  const toolResult = await readFileTool({ userId: alice.userId, path: `attachment://${attachment.id}` })
  assert.equal(toolResult.ok, true)
  assert.equal(toolResult.scope, 'attachment')
  assert.equal(toolResult.content, originalText)
})

test('metadata, bytes, and file tools are isolated by user', async () => {
  assert.ok(uploaded)
  const metadata = await fetch(`${origin}/api/attachments/${uploaded.id}`, {
    headers: authorization(bob.token),
  })
  assert.equal(metadata.status, 404)
  const content = await fetch(`${origin}/api/attachments/${uploaded.id}/content`, {
    headers: authorization(bob.token),
  })
  assert.equal(content.status, 404)
  await assert.rejects(
    () => readFileTool({ userId: bob.userId, path: uploaded.uri }),
    (error) => error?.code === 'ATTACHMENT_NOT_FOUND',
  )
})

test('PDF attachment is readable through the managed URI without a directory grant', async () => {
  assert.ok(uploaded)
  const result = await readFileTool({ userId: alice.userId, path: uploaded.uri })
  assert.equal(result.ok, true)
  assert.equal(result.scope, 'attachment')
  assert.equal(result.mimeType, 'application/pdf')
  assert.match(result.content, /Managed PDF hello from Gugo/)
})

test('TurnEngine binds attachment to the user message and injects recoverable model content', async () => {
  assert.ok(uploaded)
  const turnId = 'managed-attachment-turn'
  let loopRequest = null
  let providerRequest = null
  const engine = new TurnEngine({
    preparePromptContext: async () => ({ messages: [], effectiveAgentId: null, skillIds: [], memoryIds: [] }),
    resolveToolSpecs: async ({ baseSpecs }) => baseSpecs,
    runLoop: async (request) => {
      loopRequest = request
      await request.runModel({ messages: request.messages })
      return { text: '附件已读取', artifactIds: [], iterations: 1 }
    },
    runModel: async (request) => {
      providerRequest = request
      return { content: '附件已读取', toolCalls: [] }
    },
    scheduleMemoryExtraction: () => {},
  })
  await engine.startTurn({
    userId: alice.userId,
    sessionId,
    turnId,
    content: '',
    attachments: [{ id: uploaded.id }],
  })
  await engine.waitForTurn({ userId: alice.userId, sessionId, turnId })

  const userMessage = listMessages({ userId: alice.userId, sessionId, limit: 100 })
    .find((message) => message.id === `${turnId}:user`)
  assert.equal(userMessage.modelContext.attachments[0].id, uploaded.id)
  const row = getDb().prepare(
    'SELECT session_id, message_id FROM managed_attachments WHERE id = ?',
  ).get(uploaded.id)
  assert.equal(row.session_id, sessionId)
  assert.equal(row.message_id, `${turnId}:user`)
  assert.equal(loopRequest.job.hasManagedAttachments, true)
  assert.equal(loopRequest.job.managedAttachments[0].uri, uploaded.uri)
  const lightweightMessage = loopRequest.messages.find((message) => message.managedAttachments?.length)
  assert.ok(lightweightMessage)
  assert.equal(Array.isArray(lightweightMessage.content), false)
  assert.doesNotMatch(JSON.stringify(loopRequest.messages), /base64,/)
  const userWireMessage = providerRequest.messages.find((message) => Array.isArray(message.content))
  assert.ok(userWireMessage)
  assert.equal(userWireMessage.content.some((part) => part.type === 'yma_pdf'), true)
  assert.match(userWireMessage.content.find((part) => part.type === 'yma_pdf').fallback_text, /GUGO_MANAGED_ATTACHMENT/)
})

test('TurnEngine rejects an attachment owned by another user', async () => {
  assert.ok(uploaded)
  upsertSession({ id: 'managed-attachment-bob-session', userId: bob.userId, title: 'Bob' })
  const engine = new TurnEngine({ runLoop: async () => ({ text: 'must not run' }) })
  await assert.rejects(
    engine.startTurn({
      userId: bob.userId,
      sessionId: 'managed-attachment-bob-session',
      turnId: 'managed-attachment-bob-turn',
      content: '读取附件',
      attachments: [{ id: uploaded.id }],
    }),
    (error) => error?.code === 'ATTACHMENT_NOT_FOUND' && error?.status === 404,
  )
})

test('Office attachment is extracted and injected into a turn without local path authorization', async () => {
  const upload = await fetch(
    `${origin}/api/attachments?filename=${encodeURIComponent('notes.docx')}&sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: 'POST',
      headers: authorization(alice.token, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      body: docxBytes,
    },
  )
  assert.equal(upload.status, 201)
  const attachment = (await upload.json()).attachment
  const read = await readFileTool({ userId: alice.userId, path: attachment.uri })
  assert.match(read.content, /Managed Office document from Gugo/)

  let loopRequest = null
  let providerRequest = null
  const turnId = 'managed-office-turn'
  const engine = new TurnEngine({
    preparePromptContext: async () => ({ messages: [], effectiveAgentId: null, skillIds: [], memoryIds: [] }),
    resolveToolSpecs: async ({ baseSpecs }) => baseSpecs,
    runLoop: async (request) => {
      loopRequest = request
      await request.runModel({ messages: request.messages })
      return { text: 'Office 附件已读取', artifactIds: [], iterations: 1 }
    },
    runModel: async (request) => {
      providerRequest = request
      return { content: 'Office 附件已读取', toolCalls: [] }
    },
    scheduleMemoryExtraction: () => {},
  })
  await engine.startTurn({
    userId: alice.userId,
    sessionId,
    turnId,
    content: '概括这个文档',
    attachments: [{ id: attachment.id }],
  })
  await engine.waitForTurn({ userId: alice.userId, sessionId, turnId })
  assert.equal(loopRequest.messages.some((message) => Array.isArray(message.content)), false)
  assert.equal(loopRequest.messages.some((message) => message.managedAttachments?.[0]?.id === attachment.id), true)
  const structured = providerRequest.messages.find((message) => (
    Array.isArray(message.content) && message.content.some((part) => (
      part?.type === 'text' && String(part.text || '').includes(attachment.id)
    ))
  ))
  assert.ok(structured)
  const injectedText = structured.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  assert.match(injectedText, /GUGO_MANAGED_ATTACHMENT/)
  assert.match(injectedText, /Managed Office document from Gugo/)
})
