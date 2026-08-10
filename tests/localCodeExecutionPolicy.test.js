import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-local-code-policy-'))
const workspace = path.join(root, 'shared-workspace')
const writableDirectory = path.join(root, 'writable-grant')
const readonlyDirectory = path.join(root, 'readonly-grant')
const allFilesDirectory = path.join(root, 'all-files-only')
for (const directory of [workspace, writableDirectory, readonlyDirectory, allFilesDirectory]) {
  fs.mkdirSync(directory, { recursive: true })
}

process.env.APP_DB_PATH = path.join(root, 'app.db')
process.env.WORKSPACE_ROOT = workspace
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'
process.env.AUTH_MODE = 'local'
process.env.SERVER_HOST = '127.0.0.1'
delete process.env.WORKSPACE_SHELL_ENABLED
delete process.env.LOCAL_CODE_EXECUTION_ENABLED

const { closeDb, createUser } = await import('../server/db.js')
const { bashExecTool } = await import('../server/adapters/fsShellTools.js')
const {
  grantLocalPath,
  isLocalCodeExecutionEnabled,
  setAllFilesAccess,
} = await import('../server/services/localFileAccessService.js')
const { getWorkspaceTrustStatus } = await import('../server/services/workspaceTrustService.js')
const { getToolMetadata } = await import('../server/services/toolRegistry.js')
const { classifyToolRisk } = await import('../server/utils/approvalPolicy.js')

for (const [id, email] of [
  ['local-code-write', 'local-code-write@example.com'],
  ['local-code-readonly', 'local-code-readonly@example.com'],
  ['local-code-all-files', 'local-code-all-files@example.com'],
]) {
  createUser({ id, email })
}

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

test('local code execution defaults only to local auth on a loopback bind and honors explicit overrides', () => {
  assert.equal(isLocalCodeExecutionEnabled({ AUTH_MODE: 'local', SERVER_HOST: '127.0.0.1' }), true)
  assert.equal(isLocalCodeExecutionEnabled({ AUTH_MODE: 'local', SERVER_HOST: 'localhost' }), true)
  assert.equal(isLocalCodeExecutionEnabled({ AUTH_MODE: 'local', SERVER_HOST: '::1' }), true)

  assert.equal(isLocalCodeExecutionEnabled({ AUTH_MODE: 'multi_user', SERVER_HOST: '127.0.0.1' }), false)
  assert.equal(isLocalCodeExecutionEnabled({ AUTH_MODE: 'local', SERVER_HOST: '0.0.0.0' }), false)
  assert.equal(isLocalCodeExecutionEnabled({ AUTH_MODE: 'local', SERVER_HOST: '192.168.1.25' }), false)

  assert.equal(isLocalCodeExecutionEnabled({
    AUTH_MODE: 'multi_user',
    SERVER_HOST: '0.0.0.0',
    LOCAL_CODE_EXECUTION_ENABLED: '1',
  }), true)
  assert.equal(isLocalCodeExecutionEnabled({
    AUTH_MODE: 'local',
    SERVER_HOST: '127.0.0.1',
    LOCAL_CODE_EXECUTION_ENABLED: '0',
  }), false)
})

test('a local read-write directory grant runs shell without workspace trust or the shared shell switch', async () => {
  grantLocalPath({
    userId: 'local-code-write',
    rootPath: writableDirectory,
    accessMode: 'read_write',
  })
  assert.equal(
    getWorkspaceTrustStatus({ userId: 'local-code-write', rootPath: writableDirectory }).trusted,
    false,
    'local directory execution must not depend on the separate workspace-config trust table',
  )
  assert.equal(process.env.WORKSPACE_SHELL_ENABLED, undefined)

  const outputPath = path.join(writableDirectory, 'shell-created.txt')
  const result = await bashExecTool({
    userId: 'local-code-write',
    cwd: writableDirectory,
    command: 'echo created-by-authorized-shell > shell-created.txt',
    expected_outputs: [outputPath],
  })

  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.changedPaths, [fs.realpathSync(outputPath)])
  assert.match(fs.readFileSync(outputPath, 'utf8'), /created-by-authorized-shell/)
})

test('a read-only directory grant cannot become shell execution authority', async () => {
  grantLocalPath({
    userId: 'local-code-readonly',
    rootPath: readonlyDirectory,
    accessMode: 'read_only',
  })

  await assert.rejects(
    () => bashExecTool({
      userId: 'local-code-readonly',
      cwd: readonlyDirectory,
      command: 'echo must-not-run',
      expected_outputs: [],
    }),
    (error) => {
      assert.equal(error.code, 'PATH_NOT_AUTHORIZED')
      assert.equal(error.requiredAccessMode, 'read_write')
      return true
    },
  )
})

test('all-files access does not implicitly authorize shell execution in an arbitrary directory', async () => {
  setAllFilesAccess({
    userId: 'local-code-all-files',
    enabled: true,
    confirmation: 'ALLOW_ALL_LOCAL_FILES',
  })
  const outputPath = path.join(allFilesDirectory, 'must-not-exist.txt')

  await assert.rejects(
    () => bashExecTool({
      userId: 'local-code-all-files',
      cwd: allFilesDirectory,
      command: 'echo must-not-run > must-not-exist.txt',
      expected_outputs: [outputPath],
    }),
    (error) => {
      assert.equal(error.statusCode, 403)
      assert.match(error.message, /(?:directory|grant|目录|授权)/i)
      return true
    },
  )
  assert.equal(fs.existsSync(outputPath), false)
})

test('declaring an in-grant output cannot hide a command path outside the authorized directory', async () => {
  const declaredOutput = path.join(writableDirectory, 'declared-output.txt')
  const forbiddenOutput = path.join(allFilesDirectory, 'forbidden-output.txt')

  await assert.rejects(
    () => bashExecTool({
      userId: 'local-code-write',
      cwd: writableDirectory,
      command: `echo must-not-escape > ${forbiddenOutput}`,
      expected_outputs: [declaredOutput],
    }),
    (error) => {
      assert.equal(error.code, 'SHELL_PATH_NOT_AUTHORIZED')
      assert.equal(error.statusCode, 403)
      assert.equal(path.resolve(error.path), path.resolve(forbiddenOutput))
      return true
    },
  )
  assert.equal(fs.existsSync(declaredOutput), false)
  assert.equal(fs.existsSync(forbiddenOutput), false)
})

test('a shell write remains exec risk and requires a per-call approval', () => {
  const args = {
    command: 'echo changed > output.txt',
    expected_outputs: ['output.txt'],
  }
  const metadata = getToolMetadata('bash_exec', { args })
  assert.equal(metadata.riskClass, 'exec')
  assert.equal(metadata.isReadOnly, false)

  const verdict = classifyToolRisk('bash_exec', args, { origin: 'chat', mode: 'all' })
  assert.equal(verdict.needsApproval, true)
  assert.equal(verdict.risk, 'high')
  assert.equal(verdict.reason, '执行 shell 命令')
})
