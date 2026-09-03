import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function source(file) {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

test('attachment HTTP routes depend only on the storage port, never filesystem or stores', () => {
  const contents = source('server/routes/attachmentRoutes.js')
  assert.match(contents, /from ['"]\.\.\/core\/managedAttachmentStoragePort\.js['"]/u)
  assert.doesNotMatch(contents, /from ['"]node:(?:fs|path)(?:\/promises)?['"]/u)
  assert.doesNotMatch(contents, /from ['"].*managedAttachmentStore(?:Support)?\.js['"]/u)
  assert.doesNotMatch(contents, /from ['"].*(?:^|\/)db\.js['"]/mu)
  assert.doesNotMatch(contents, /\b(?:fullPath|storage_path)\b/u)
})

test('managed attachment storage core port never selects an adapter, service, DB, or host path API', () => {
  const contents = source('server/core/managedAttachmentStoragePort.js')
  assert.doesNotMatch(contents, /from ['"].*\/adapters\//u)
  assert.doesNotMatch(contents, /from ['"].*\/services\//u)
  assert.doesNotMatch(contents, /from ['"].*(?:^|\/)db\.js['"]/mu)
  assert.doesNotMatch(contents, /from ['"]node:(?:fs|path)(?:\/promises)?['"]/u)
})

test('attachment binding remains inside the SQLite turn-start transaction', () => {
  const contents = source('server/services/sqliteTurnPersistenceTransactions.js')
  assert.match(
    contents,
    /import \{ bindManagedAttachmentsToMessage \} from ['"]\.\/managedAttachmentStore\.js['"]/u,
  )
  assert.match(contents, /bindAttachments\s*=\s*bindManagedAttachmentsToMessage/u)
  assert.match(contents, /attachmentBindingAuthorized\s*=\s*false/u)

  const transactionStart = contents.indexOf('db.transaction(() => {', contents.indexOf('commitTurnStart'))
  const transactionEnd = contents.indexOf('})()', transactionStart)
  const bindingCall = contents.indexOf('bindAttachments(binding)', transactionStart)
  const authorizationCheck = contents.indexOf('attachmentBindingAuthorized !== true', transactionStart)
  assert.ok(transactionStart >= 0, 'commitTurnStart must open one SQLite transaction')
  assert.ok(transactionEnd > transactionStart, 'commitTurnStart transaction must close')
  assert.ok(authorizationCheck > transactionStart && authorizationCheck < transactionEnd)
  assert.ok(bindingCall > authorizationCheck && bindingCall < transactionEnd)
})
