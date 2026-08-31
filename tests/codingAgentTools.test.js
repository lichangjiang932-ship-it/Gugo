import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-coding-tools-'))
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHELL_ENABLED: process.env.WORKSPACE_SHELL_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}
process.env.APP_DB_PATH = path.join(root, 'coding-tools.db')
process.env.WORKSPACE_ROOT = root
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHELL_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'

const {
  _internals,
  dockerExecTool,
  fileDownloadTool,
  patchFileTool,
  runCommandTool,
  runTestTool,
} = await import('../server/adapters/codingAgentTools.js')
const { closeDb, createUser, setUserToolPermission } = await import('../server/db.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { getBuiltinSpec } = await import('../server/services/toolRegistry.js')
const { runToolsLoop } = await import('../server/services/toolLoopRuntime.js')

let permissionUserSequence = 0
function createPermissionUser(label) {
  permissionUserSequence += 1
  const userId = `${label}-${process.pid}-${permissionUserSequence}`
  createUser({ id: userId, email: `${userId}@example.com` })
  return userId
}

test.after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test('run_test executes a real Python script and returns structured pass state', async () => {
  fs.writeFileSync(
    path.join(root, 'agent_test.py'),
    'value = sum([2, 3])\nassert value == 5\nprint("PYTHON_EXECUTION_OK")\n',
    'utf8',
  )

  const result = await runTestTool({
    command: 'python agent_test.py',
    framework: 'custom',
    cwd: root,
    timeout_ms: 30_000,
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.passed, true)
  assert.equal(result.verificationVerdict, 'passed')
  assert.equal(result.failureKind, null)
  assert.equal(result.systemFailure, false)
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /PYTHON_EXECUTION_OK/)
})

test('run_command standard alias executes real Python and returns stdout/stderr/exit code', async () => {
  fs.writeFileSync(path.join(root, 'command_alias.py'), 'print("RUN_COMMAND_PYTHON_OK")\n', 'utf8')
  const result = await runCommandTool({
    command: 'python command_alias.py',
    cwd: root,
    timeout_ms: 30_000,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /RUN_COMMAND_PYTHON_OK/)
  assert.equal(typeof result.stderr, 'string')
})

test('run_command infers one authorized read-write cwd for quoted PowerShell paths', {
  skip: process.platform !== 'win32',
}, async () => {
  const previousSharedTrust = process.env.WORKSPACE_SHARED_TRUSTED
  const externalBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-run-command-external-'))
  const authorizedRoot = path.join(externalBase, 'authorized target (1)')
  const inputPath = path.join(authorizedRoot, 'input.txt')
  const userId = createPermissionUser('run-command-inferred-cwd')
  fs.mkdirSync(authorizedRoot, { recursive: true })
  fs.writeFileSync(inputPath, 'POWERSHELL_AUTHORIZED_PATH_OK', 'utf8')
  grantLocalPath({ userId, rootPath: authorizedRoot, accessMode: 'read_write' })
  setUserToolPermission({ userId, toolName: 'run_command', enabled: true })
  process.env.WORKSPACE_SHARED_TRUSTED = '0'

  try {
    const escapedPath = inputPath.replaceAll("'", "''")
    const result = await runCommandTool({
      command: `powershell -NoProfile -Command "Get-Content -LiteralPath '${escapedPath}'"`,
      userId,
      timeout_ms: 30_000,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.exitCode, 0)
    assert.equal(result.cwd, fs.realpathSync(authorizedRoot))
    assert.match(result.stdout, /POWERSHELL_AUTHORIZED_PATH_OK/u)
  } finally {
    process.env.WORKSPACE_SHARED_TRUSTED = previousSharedTrust
    fs.rmSync(externalBase, { recursive: true, force: true })
  }
})

test('run_command and run_test do not inherit the hidden bash_exec permission', async () => {
  fs.writeFileSync(path.join(root, 'permission_alias.py'), 'print("STANDARD_ALIAS_PERMISSION_OK")\n', 'utf8')
  const userId = createPermissionUser('command-alias-permission')
  setUserToolPermission({ userId, toolName: 'bash_exec', enabled: false })
  setUserToolPermission({ userId, toolName: 'run_command', enabled: true })
  setUserToolPermission({ userId, toolName: 'run_test', enabled: true })

  const command = await runCommandTool({
    command: 'python permission_alias.py',
    cwd: root,
    userId,
  })
  assert.equal(command.ok, true, JSON.stringify(command))
  assert.match(command.stdout, /STANDARD_ALIAS_PERMISSION_OK/u)

  const checked = await runTestTool({
    command: 'python permission_alias.py',
    framework: 'custom',
    cwd: root,
    userId,
  })
  assert.equal(checked.ok, true, JSON.stringify(checked))
  assert.equal(checked.passed, true)

  setUserToolPermission({ userId, toolName: 'bash_exec', enabled: true })
  setUserToolPermission({ userId, toolName: 'run_command', enabled: false })
  setUserToolPermission({ userId, toolName: 'run_test', enabled: false })
  await assert.rejects(
    () => runCommandTool({ command: 'echo must-not-run', cwd: root, userId }),
    (error) => error?.code === 'TOOL_DISABLED' && /run_command/u.test(error.message),
  )
  await assert.rejects(
    () => runTestTool({ command: 'echo must-not-run', framework: 'custom', cwd: root, userId }),
    (error) => error?.code === 'TOOL_DISABLED' && /run_test/u.test(error.message),
  )
})

test('patch_file replaces an exact line range and preserves CRLF newlines', async () => {
  const target = path.join(root, 'line-patch.txt')
  const original = 'first\r\nold second\r\nthird\r\n'
  fs.writeFileSync(target, original, 'utf8')
  const expected = createHash('sha256').update(original).digest('hex')

  const result = await patchFileTool({
    path: target,
    start_line: 2,
    end_line: 2,
    replacement: 'new second\ninserted',
    expected_sha256: expected,
  })

  assert.equal(result.ok, true)
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    'first\r\nnew second\r\ninserted\r\nthird\r\n',
  )
  assert.notEqual(result.beforeSha256, result.afterSha256)
})

test('patch_file dry-run reports hashes without changing the file', async () => {
  const target = path.join(root, 'line-patch-dry.txt')
  fs.writeFileSync(target, 'alpha\nbeta\n', 'utf8')
  const result = await patchFileTool({
    path: target,
    start_line: 2,
    end_line: 2,
    replacement: 'BETA',
    dry_run: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'alpha\nbeta\n')
})

test('patch_file line and patch-text modes do not inherit write_file or apply_patch permissions', async () => {
  const userId = createPermissionUser('patch-alias-permission')
  setUserToolPermission({ userId, toolName: 'patch_file', enabled: true })
  setUserToolPermission({ userId, toolName: 'write_file', enabled: false })
  setUserToolPermission({ userId, toolName: 'apply_patch', enabled: false })

  const lineTarget = path.join(root, 'patch-line-permission.txt')
  fs.writeFileSync(lineTarget, 'before\n', 'utf8')
  const lineResult = await patchFileTool({
    path: lineTarget,
    start_line: 1,
    end_line: 1,
    replacement: 'after',
    userId,
  })
  assert.equal(lineResult.ok, true)
  assert.equal(fs.readFileSync(lineTarget, 'utf8'), 'after\n')

  const patchTarget = path.join(root, 'patch-text-permission.txt')
  fs.writeFileSync(patchTarget, 'old\n', 'utf8')
  const patchResult = await patchFileTool({
    patch: `*** Begin Patch
*** Update File: patch-text-permission.txt
@@
-old
+new
*** End Patch`,
    userId,
  })
  assert.equal(patchResult.ok, true)
  assert.equal(fs.readFileSync(patchTarget, 'utf8'), 'new\n')

  setUserToolPermission({ userId, toolName: 'patch_file', enabled: false })
  setUserToolPermission({ userId, toolName: 'write_file', enabled: true })
  setUserToolPermission({ userId, toolName: 'apply_patch', enabled: true })
  await assert.rejects(
    () => patchFileTool({
      path: lineTarget,
      start_line: 1,
      end_line: 1,
      replacement: 'must-not-be-written',
      userId,
    }),
    (error) => error?.code === 'TOOL_DISABLED' && /patch_file/u.test(error.message),
  )
})

test('run_test preserves failing stdout/stderr and reports passed=false', async () => {
  fs.writeFileSync(path.join(root, 'agent_fail.py'), 'print("BEFORE_FAILURE")\nraise SystemExit(7)\n', 'utf8')

  const result = await runTestTool({
    command: 'python agent_fail.py',
    framework: 'custom',
    cwd: root,
  })

  assert.equal(result.ok, false)
  assert.equal(result.passed, false)
  assert.equal(result.verificationVerdict, 'failed')
  assert.equal(result.failureKind, 'project')
  assert.equal(result.systemFailure, false)
  assert.equal(result.exitCode, 7)
  assert.match(result.stdout, /BEFORE_FAILURE/)
})

test('run_test parses common Node and pytest summaries', () => {
  assert.deepEqual(
    _internals.parseTestSummary('# tests 4\n# pass 3\n# fail 1\n', ''),
    { total: 4, passed: 3, failed: 1 },
  )
  assert.deepEqual(
    _internals.parseTestSummary('12 passed, 2 failed, 1 skipped', ''),
    { passed: 12, failed: 2, skipped: 1, total: 15 },
  )
})

test('file_download streams binary bytes, verifies SHA-256, and writes atomically', async () => {
  const body = Buffer.from([0, 255, 17, 32, 128, 64])
  const digest = createHash('sha256').update(body).digest('hex')
  let validations = 0
  const result = await fileDownloadTool({
    url: 'https://downloads.example.test/data.bin',
    path: 'downloads/data.bin',
    sha256: digest,
  }, {
    validateUrl: async (rawUrl) => {
      validations += 1
      return new URL(rawUrl)
    },
    requestImpl: async () => {
      const response = Readable.from([body.subarray(0, 2), body.subarray(2)])
      response.statusCode = 200
      response.headers = {
        'content-length': String(body.length),
        'content-type': 'application/octet-stream',
      }
      return response
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.bytes, body.length)
  assert.equal(result.sha256, digest)
  assert.equal(validations, 1)
  assert.deepEqual(fs.readFileSync(path.join(root, 'downloads/data.bin')), body)
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'downloads')).filter((name) => name.endsWith('.part')),
    [],
  )
})

test('file_download checksum failure leaves no destination or partial file', async () => {
  const destination = path.join(root, 'downloads', 'bad.bin')
  await assert.rejects(
    () => fileDownloadTool({
      url: 'https://downloads.example.test/bad.bin',
      path: 'downloads/bad.bin',
      sha256: '0'.repeat(64),
    }, {
      validateUrl: async (rawUrl) => new URL(rawUrl),
      requestImpl: async () => {
        const response = Readable.from([Buffer.from('different')])
        response.statusCode = 200
        response.headers = {}
        return response
      },
    }),
    (error) => error?.code === 'DOWNLOAD_CHECKSUM_MISMATCH',
  )
  assert.equal(fs.existsSync(destination), false)
  assert.deepEqual(
    fs.readdirSync(path.dirname(destination)).filter((name) => name.endsWith('.part')),
    [],
  )
})

test('docker_exec command builder keeps user command as one shell argument', () => {
  const command = _internals.dockerCommand({
    container: 'dev-container_1',
    command: 'python -V && npm -v',
    workdir: '/workspace',
  })
  assert.match(command, /docker/)
  assert.match(command, /exec/)
  assert.match(command, /dev-container_1/)
  assert.match(command, /python -V && npm -v/)
})

test('docker_exec does not inherit the hidden bash_exec permission', async () => {
  const userId = createPermissionUser('docker-alias-permission')
  const fakeDocker = path.join(root, process.platform === 'win32' ? 'fake docker.cmd' : 'fake docker')
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeDocker, '@echo off\r\necho DOCKER_ALIAS_PERMISSION_OK\r\nexit /b 0\r\n', 'utf8')
  } else {
    fs.writeFileSync(fakeDocker, '#!/bin/sh\necho DOCKER_ALIAS_PERMISSION_OK\n', 'utf8')
    fs.chmodSync(fakeDocker, 0o755)
  }

  setUserToolPermission({ userId, toolName: 'bash_exec', enabled: false })
  setUserToolPermission({ userId, toolName: 'docker_exec', enabled: true })
  const result = await dockerExecTool({
    container: 'permission-test',
    command: ['echo', 'inside-container'],
    cwd: root,
    userId,
  }, {
    findDockerCliImpl: () => fakeDocker,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.stdout, /DOCKER_ALIAS_PERMISSION_OK/u)

  setUserToolPermission({ userId, toolName: 'bash_exec', enabled: true })
  setUserToolPermission({ userId, toolName: 'docker_exec', enabled: false })
  await assert.rejects(
    () => dockerExecTool({
      container: 'permission-test',
      command: ['echo', 'must-not-run'],
      cwd: root,
      userId,
    }, {
      findDockerCliImpl: () => fakeDocker,
    }),
    (error) => error?.code === 'TOOL_DISABLED' && /docker_exec/u.test(error.message),
  )
})

test('TurnEngine exposes run_command to the model, executes Python, and feeds the result back', async () => {
  const ownerId = createPermissionUser('coding-tool-loop-owner')
  fs.writeFileSync(
    path.join(root, 'loop_python.py'),
    [
      'from pathlib import Path',
      'Path("loop-output.txt").write_text("TURN_ENGINE_PYTHON_OK", encoding="utf-8")',
      'print("TURN_ENGINE_PYTHON_OK")',
      '',
    ].join('\n'),
    'utf8',
  )
  const visible = []
  let observed = null
  let verified = null
  const result = await runToolsLoop({
    job: {
      id: 'coding-tool-loop-job',
      userId: ownerId,
      sessionId: `coding-tool-loop-session-${process.pid}`,
      origin: 'chat',
      prompt: 'Run the Python script to create loop-output.txt, read it back, and report the verified result.',
    },
    step: { id: 'coding-tool-loop-step', kind: 'execute' },
    messages: [{ role: 'user', content: 'Run loop_python.py with Python, create loop-output.txt, and verify it.' }],
    toolSpecs: [getBuiltinSpec('run_command'), getBuiltinSpec('read_file')],
    maxIters: 3,
    enableToolHooks: false,
    requestToolApproval: async ({ args, toolCallId }) => ({
      proceed: true,
      args,
      approvalId: `coding-tool-loop-approval-${toolCallId}`,
    }),
    runModel: async ({ messages, tools }) => {
      visible.push(...tools.map((item) => item.function.name))
      const toolMessage = messages.find((message) => message.role === 'tool' && message.name === 'run_command')
      const verificationMessage = messages.find((message) => message.role === 'tool' && message.name === 'read_file')
      if (verificationMessage) {
        verified = JSON.parse(verificationMessage.content)
        return { content: 'Python output was created and verified.', toolCalls: [] }
      }
      if (toolMessage) {
        observed = JSON.parse(toolMessage.content)
        return {
          content: '',
          toolCalls: [{
            id: 'verify-python-output-through-turn-engine',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: path.join(root, 'loop-output.txt') }),
            },
          }],
        }
      }
      return {
        content: '',
        toolCalls: [{
          id: 'run-python-through-turn-engine',
          type: 'function',
          function: {
            name: 'run_command',
            arguments: JSON.stringify({
              command: 'python loop_python.py',
              cwd: root,
              expected_outputs: ['loop-output.txt'],
            }),
          },
        }],
      }
    },
  })

  assert.ok(visible.includes('run_command'))
  assert.equal(observed?.ok, true, JSON.stringify(observed))
  assert.match(observed?.stdout || '', /TURN_ENGINE_PYTHON_OK/)
  assert.equal(verified?.ok, true, JSON.stringify(verified))
  assert.equal(verified?.content, 'TURN_ENGINE_PYTHON_OK')
  assert.equal(result.text, 'Python output was created and verified.')
})
