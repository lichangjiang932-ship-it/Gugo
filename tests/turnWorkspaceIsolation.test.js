import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-workspace-'))
process.env.APP_DATA_DIR = path.join(tempDir, 'data')

const { closeDb, createUser } = await import('../server/db.js')
const {
  getDefaultOutputDirectory,
  getLocalFileAccessStatus,
  getProjectDirectory,
  grantLocalPath,
  resolveTurnProjectDirectory,
  setDefaultOutputDirectory,
  withTurnProjectDirectory,
} = await import('../server/services/localFileAccessService.js')
const { setWorkspaceTrust } = await import('../server/services/workspaceTrustService.js')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('selected Turn workspaces are validated and remain isolated across concurrent sessions', async () => {
  const userId = 'turn-workspace-user'
  createUser({ id: userId, email: 'turn-workspace@example.com' })
  const directory = (name) => {
    const target = path.join(tempDir, name)
    fs.mkdirSync(target, { recursive: true })
    return fs.realpathSync(target)
  }
  const projectA = directory('project-a')
  const projectB = directory('project-b')
  const denied = directory('denied')
  const defaultDirectory = directory('default')

  for (const rootPath of [projectA, projectB]) {
    grantLocalPath({ userId, rootPath, accessMode: 'read_write' })
    setWorkspaceTrust({
      userId,
      rootPath,
      trusted: true,
      confirmation: 'TRUST_WORKSPACE_CONFIG',
    })
  }
  setDefaultOutputDirectory({ userId, rootPath: defaultDirectory })

  assert.equal(resolveTurnProjectDirectory({ userId, workspacePath: projectA }).projectDirectory, projectA)
  assert.equal(resolveTurnProjectDirectory({ userId }).projectDirectory, defaultDirectory)
  assert.throws(
    () => resolveTurnProjectDirectory({ userId, workspacePath: denied }),
    (error) => error?.code === 'TURN_WORKSPACE_NOT_AUTHORIZED' && error?.statusCode === 403,
  )

  const [observedA, observedB] = await Promise.all([
    withTurnProjectDirectory({ userId, projectDirectory: projectA }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        project: getProjectDirectory({ userId }),
        output: getDefaultOutputDirectory({ userId }),
        status: getLocalFileAccessStatus({ userId }).projectDirectory,
      }
    }),
    withTurnProjectDirectory({ userId, projectDirectory: projectB }, async () => {
      await Promise.resolve()
      return {
        project: getProjectDirectory({ userId }),
        output: getDefaultOutputDirectory({ userId }),
        status: getLocalFileAccessStatus({ userId }).projectDirectory,
      }
    }),
  ])

  assert.deepEqual(observedA, { project: projectA, output: projectA, status: projectA })
  assert.deepEqual(observedB, { project: projectB, output: projectB, status: projectB })
})
