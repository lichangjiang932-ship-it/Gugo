import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { getDb, closeDb, createUser } from '../../server/db.js'
import { upsertSession, upsertMessage } from '../../server/services/sessionStore.js'
import { prepareHeadlessAttachments } from '../../server/adapters/headlessAttachmentPreparation.js'
import { bindManagedAttachmentsToMessage, getManagedAttachment } from '../../server/services/managedAttachmentStore.js'

after(() => closeDb())
let sequence = 0
function fixture() {
  const key = `cli-attachments-${++sequence}`
  const cwd = path.join(process.env.APP_DATA_DIR, key)
  mkdirSync(cwd)
  createUser({ id: key, email: `${key}@example.invalid` })
  upsertSession({ id: key, userId: key, title: key })
  writeFileSync(path.join(cwd, 'content.txt'), 'literal fixture payload')
  return { userId: key, sessionId: key, cwd, env: process.env }
}

test('headless uploads exact file bytes and discards only its unbound staging receipts', async () => {
  const input = fixture()
  const prepared = await prepareHeadlessAttachments({ ...input, requests: [{ path: 'content.txt', kind: 'auto' }] })
  assert.equal(prepared.attachments.length, 1)
  const [id] = prepared.attachments
  const stored = getManagedAttachment({ userId: input.userId, id })
  assert.equal(stored.name, 'content.txt')
  assert.equal(stored.size, Buffer.byteLength('literal fixture payload'))
  assert.equal(stored.sessionId, input.sessionId)
  assert.equal(stored.messageId, null)
  await prepared.discard()
  assert.equal(getManagedAttachment({ userId: input.userId, id }), null)
})

test('cleanup after a successful/unknown Turn start preserves bound receipts and another owner', async () => {
  const input = fixture()
  const prepared = await prepareHeadlessAttachments({ ...input, requests: [{ path: 'content.txt', kind: 'auto' }] })
  upsertMessage({ id: 'bound-cli-message', userId: input.userId, sessionId: input.sessionId, role: 'user', content: 'read it' })
  bindManagedAttachmentsToMessage({ userId: input.userId, sessionId: input.sessionId, messageId: 'bound-cli-message', attachmentIds: prepared.attachments })
  await prepared.discard()
  assert.equal(getManagedAttachment({ userId: input.userId, id: prepared.attachments[0] }).messageId, 'bound-cli-message')
  assert.equal(getManagedAttachment({ userId: 'other', id: prepared.attachments[0] }), null)
})

test('bad signature, unsupported capability, missing file and cancellation never keep half-attached inputs', async () => {
  const input = fixture()
  writeFileSync(path.join(input.cwd, 'fake.png'), 'not an image')
  writeFileSync(path.join(input.cwd, 'real.pdf'), '%PDF-1.4\nfixture')
  const rows = () => getDb().prepare('SELECT id FROM managed_attachments WHERE user_id = ?').all(input.userId)
  await assert.rejects(prepareHeadlessAttachments({ ...input, requests: [
    { path: 'content.txt', kind: 'auto' }, { path: 'fake.png', kind: 'image' },
  ] }), { code: 'CLI_ATTACHMENT_SIGNATURE_INVALID' })
  assert.deepEqual(rows(), [])
  await assert.rejects(prepareHeadlessAttachments({ ...input, requests: [{ path: 'real.pdf', kind: 'auto' }] },
    { profile: () => ({ supportsPdf: false }) }), { code: 'CLI_ATTACHMENT_MODEL_UNSUPPORTED' })
  assert.deepEqual(rows(), [])
  await assert.rejects(prepareHeadlessAttachments({ ...input, requests: [{ path: 'missing', kind: 'auto' }] }),
    { code: 'CLI_ATTACHMENT_NOT_FOUND' })
  const controller = new AbortController()
  const aborted = new Error('cancelled before any read')
  controller.abort(aborted)
  await assert.rejects(prepareHeadlessAttachments({ ...input, signal: controller.signal, requests: [{ path: 'content.txt' }] }), (error) => error === aborted)
  assert.deepEqual(rows(), [])
})
