import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { closeDb, createUser, setUserToolPermission } from '../server/db.js'
import { setApprovalMode } from '../server/services/approvalSettingsStore.js'
import { editFileTool } from '../server/adapters/fsFileTools.js'

let workspace
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-ast-'))
  process.env.APP_DB_PATH = path.join(workspace, 'edit-ast.db')
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
})

after(() => {
  closeDb()
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* noop */ }
})

function makeUser() {
  const userId = `edit-ast-${process.pid}-${Math.random().toString(36).slice(2)}`
  createUser({ id: userId, email: `${userId}@example.com` })
  setApprovalMode({ userId, mode: 'normal' })
  setUserToolPermission({ userId, toolName: 'edit_file', enabled: true })
  return userId
}

test('edit_file replaces the code occurrence, not the one in a comment', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  const userId = makeUser()
  const source = '// rename target later\nconst value = target\n'
  fs.writeFileSync(path.join(workspace, 'target.js'), source)

  const result = await editFileTool({
    path: 'target.js',
    old_string: 'target',
    new_string: 'renamed',
    userId,
  })

  assert.equal(result.ok, true)
  assert.equal(result.replacedCount, 1)
  const after = fs.readFileSync(path.join(workspace, 'target.js'), 'utf8')
  assert.match(after, /\/\/ rename target later/, 'the comment is untouched')
  assert.match(after, /const value = renamed/, 'the code occurrence was replaced')
  assert.doesNotMatch(after, /const value = target/)
})

test('edit_file still refuses a genuinely ambiguous multi-match', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  const userId = makeUser()
  fs.writeFileSync(path.join(workspace, 'ambiguous.js'), 'run(target)\nalso(target)\n')

  await assert.rejects(
    () => editFileTool({ path: 'ambiguous.js', old_string: 'target', new_string: 'x', userId }),
    /出现多次/,
  )
})

test('non-JavaScript multi-match keeps the exact-match error', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  const userId = makeUser()
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'target\ntarget\n')

  await assert.rejects(
    () => editFileTool({ path: 'notes.txt', old_string: 'target', new_string: 'x', userId }),
    /出现多次/,
  )
})
