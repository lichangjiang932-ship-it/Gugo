import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MANAGED_ATTACHMENT_PUBLIC_FIELDS } from '../server/core/managedAttachmentDtos.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-storage-adapter-'))
const previousDataDir = process.env.APP_DATA_DIR
process.env.APP_DATA_DIR = tempDir

const { createSqliteFileManagedAttachmentStorageAdapter } = await import(
  '../server/adapters/sqliteFileManagedAttachmentStorageAdapter.js'
)
const { createManagedAttachmentStoragePort } = await import(
  '../server/core/managedAttachmentStoragePort.js'
)
const { closeDb, createUser } = await import('../server/db.js')
const { getManagedAttachment } = await import('../server/services/managedAttachmentStore.js')

test.after(() => {
  closeDb()
  if (previousDataDir == null) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = previousDataDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function binarySource(value) {
  return (async function* stream() {
    yield value
  })()
}

test('sqlite-file storage adapter opens bytes without exposing its host path', async () => {
  const user = createUser({
    id: 'managed-storage-adapter-user',
    email: 'managed-storage-adapter@example.com',
  })
  const bytes = Buffer.from('adapter content')
  const storage = createManagedAttachmentStoragePort(
    createSqliteFileManagedAttachmentStorageAdapter({
      getEnv: () => ({ APP_DATA_DIR: tempDir }),
    }),
  )
  const created = await storage.create({
    userId: user.id,
    name: 'adapter.txt',
    mimeType: 'text/plain',
    sessionId: null,
    messageId: null,
    source: binarySource(bytes),
    contentLength: bytes.length,
  })

  assert.deepEqual(Object.keys(created), MANAGED_ATTACHMENT_PUBLIC_FIELDS)
  assert.doesNotMatch(JSON.stringify(created), /fullPath|storagePath|storage_path|gugo-storage-adapter/u)
  const opened = await storage.openContent({
    userId: user.id,
    id: created.id,
    range: null,
    expected: { size: created.size, sha256: created.sha256 },
  })
  assert.deepEqual(Object.keys(opened.attachment), MANAGED_ATTACHMENT_PUBLIC_FIELDS)
  assert.equal(opened.stream.path == null || opened.stream.path === '', true)
  assert.doesNotMatch(
    `${JSON.stringify(opened.attachment)}\n${String(opened.stream.path)}`,
    /fullPath|storagePath|storage_path|gugo-storage-adapter/u,
  )

  const chunks = []
  for await (const chunk of opened.stream) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), bytes)

  const stored = getManagedAttachment({
    userId: user.id,
    id: created.id,
    env: { APP_DATA_DIR: tempDir },
  })
  const tampered = Buffer.from('tampered bytes!')
  assert.equal(tampered.length, bytes.length)
  fs.writeFileSync(stored.fullPath, tampered)

  await assert.rejects(
    () => storage.openContent({
      userId: user.id,
      id: created.id,
      range: null,
      expected: { size: created.size, sha256: created.sha256 },
    }),
    (error) => (
      error?.code === 'ATTACHMENT_CONTENT_CHANGED'
      && error?.statusCode === 410
    ),
  )
})
