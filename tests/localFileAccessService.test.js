import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-local-file-access-'))
const grantedDir = path.join(tempDir, 'granted')
const outsideDir = path.join(tempDir, 'outside')
fs.mkdirSync(grantedDir)
fs.mkdirSync(outsideDir)
fs.writeFileSync(path.join(grantedDir, 'note.txt'), 'hello local files', 'utf8')
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside', 'utf8')
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
delete process.env.WORKSPACE_FS_ENABLED

const { closeDb, createUser } = await import('../server/db.js')
const {
  getLocalFileAccessStatus,
  grantLocalPath,
  revokeLocalPath,
  setAllFilesAccess,
} = await import('../server/services/localFileAccessService.js')
const { editFileTool, listDirectoryTool, readFileTool, writeFileTool } = await import('../server/adapters/fsShellTools.js')

createUser({ id: 'local-user-a', email: 'local-a@example.com' })
createUser({ id: 'local-user-b', email: 'local-b@example.com' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('local file grants are user-scoped and default to no access', async () => {
  assert.deepEqual(getLocalFileAccessStatus({ userId: 'local-user-a' }).grants, [])
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'note.txt') }),
    /未获得读取授权/
  )

  grantLocalPath({ userId: 'local-user-a', rootPath: grantedDir, accessMode: 'read_only' })
  const read = await readFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'note.txt') })
  assert.equal(read.content, 'hello local files')
  assert.equal(read.scope, 'grant')

  const listing = await listDirectoryTool({ userId: 'local-user-a', path: grantedDir })
  assert.equal(listing.entries.some((entry) => entry.name === 'note.txt'), true)
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-b', path: path.join(grantedDir, 'note.txt') }),
    /未获得读取授权/
  )
})

test('read-only grants block writes and can be upgraded to read-write', async () => {
  await assert.rejects(
    () => writeFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'new.txt'), content: 'new' }),
    /未获得写入授权/
  )
  grantLocalPath({ userId: 'local-user-a', rootPath: grantedDir, accessMode: 'read_write' })
  await writeFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'new.txt'), content: 'new' })
  await editFileTool({
    userId: 'local-user-a',
    path: path.join(grantedDir, 'new.txt'),
    old_string: 'new',
    new_string: 'updated',
  })
  assert.equal(fs.readFileSync(path.join(grantedDir, 'new.txt'), 'utf8'), 'updated')
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-a', path: path.join(outsideDir, 'secret.txt') }),
    /未获得读取授权/
  )
})

test('revocation is immediate and all-files mode requires explicit confirmation', async () => {
  const grant = getLocalFileAccessStatus({ userId: 'local-user-a' }).grants[0]
  assert.equal(revokeLocalPath({ userId: 'local-user-b', id: grant.id }), false)
  assert.equal(revokeLocalPath({ userId: 'local-user-a', id: grant.id }), true)
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-a', path: path.join(grantedDir, 'note.txt') }),
    /未获得读取授权/
  )

  assert.throws(
    () => setAllFilesAccess({ userId: 'local-user-a', enabled: true }),
    /明确确认/
  )
  setAllFilesAccess({ userId: 'local-user-a', enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' })
  const read = await readFileTool({ userId: 'local-user-a', path: path.join(outsideDir, 'secret.txt') })
  assert.equal(read.scope, 'all_files')
  setAllFilesAccess({ userId: 'local-user-a', enabled: false })
  await assert.rejects(
    () => readFileTool({ userId: 'local-user-a', path: path.join(outsideDir, 'secret.txt') }),
    /未获得读取授权/
  )
})
