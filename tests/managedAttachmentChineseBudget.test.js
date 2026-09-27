import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-attachment-budget-'))
process.env.APP_DATA_DIR = tempDir

const { createManagedAttachment } = await import('../server/services/managedAttachmentStore.js')
const { prepareManagedAttachmentsForModel } = await import('../server/services/managedAttachmentContent.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { textTokens } = await import('../shared/textTokenEstimate.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const sessionId = 'chinese-budget-session'
// A real user row: sessions and attachments are owned, and the foreign keys say so.
const { userId } = issueTestSession({ email: 'chinese-budget@example.com' })
upsertSession({ id: sessionId, userId, title: '中文附件预算' })

// 4000 Han characters: about 2400 tokens by the shared rule, and 4000 by the
// one-token-per-character rule this path used to spend its budget with.
const document = '表一的信息需要填入表二中。'.repeat(200)

const attachment = await createManagedAttachment({
  userId,
  sessionId,
  name: '表一.txt',
  mimeType: 'text/plain',
  source: (async function* write() { yield Buffer.from(document, 'utf8') })(),
})

test('a Chinese attachment is budgeted in the same units the threshold is measured in', async () => {
  const budget = 1000
  const prepared = await prepareManagedAttachmentsForModel({
    userId,
    sessionId,
    attachmentIds: [attachment.id],
    text: '把表一的信息填入表二',
    maxAttachmentTokens: budget,
  })

  const inlined = prepared.content.map((part) => String(part.text || '')).join('\n')
  assert.match(inlined, /表一/, 'the document body reached the model')
  // Spent and measured with one rule: a batch that overran the budget here would
  // push the turn past the window the budget came from.
  assert.ok(textTokens(inlined) <= budget, `${textTokens(inlined)} > ${budget}`)
  // And Chinese is charged at a tokenizer's real rate: a 1000-token budget has to
  // carry more than 1000 characters. Under the old rule this was impossible, which
  // is what left a Chinese document truncated while the window had room to spare.
  assert.ok(inlined.length > budget, `inlined only ${inlined.length} characters for ${budget} tokens`)
})

test('nothing is inlined when the budget is spent', async () => {
  const prepared = await prepareManagedAttachmentsForModel({
    userId,
    sessionId,
    attachmentIds: [attachment.id],
    text: '把表一的信息填入表二',
    maxAttachmentTokens: 0,
  })
  const inlined = prepared.content.map((part) => String(part.text || '')).join('\n')
  assert.doesNotMatch(inlined, /表一的信息需要填入表二/)
})

test.after(() => closeDb())
