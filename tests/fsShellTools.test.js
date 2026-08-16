import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'

import {
  readFileTool,
  writeFileTool,
  editFileTool,
  bashExecTool,
  resolveInWorkspace,
} from '../server/adapters/fsShellTools.js'
import { closeDb, createUser, setUserToolPermission } from '../server/db.js'
import { grantLocalPath } from '../server/services/localFileAccessService.js'
import { setApprovalMode } from '../server/services/approvalSettingsStore.js'
import { setWorkspaceTrust } from '../server/services/workspaceTrustService.js'

function createNormalUser(user) {
  createUser(user)
  setApprovalMode({ userId: user.id, mode: 'normal' })
}

// 每个测试自带 workspace 临时目录 + env 闸门管理.
let workspace
let authorizedWorkspace
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHELL_ENABLED: process.env.WORKSPACE_SHELL_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsshell-'))
  authorizedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsshell-authorized-'))
  process.env.APP_DB_PATH = path.join(workspace, 'fsshell-test.db')
  process.env.WORKSPACE_ROOT = workspace
})

after(() => {
  closeDb()
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* noop */ }
  try { fs.rmSync(authorizedWorkspace, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  // 每个 test 默认关闭闸门;需要时 test 内显式打开
  delete process.env.WORKSPACE_FS_ENABLED
  delete process.env.WORKSPACE_SHELL_ENABLED
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
})

test('fs 默认禁用:WORKSPACE_FS_ENABLED 未设时,工作区路径被拒', async () => {
  // 未开启全局开关时，工作区来源一律拒绝（显式授权的本地路径除外，
  // 见 localFileAccessService 测试）。
  // 无 userId 的相对路径先被「需绝对路径」拦截。
  await assert.rejects(() => readFileTool({ path: 'anything.txt' }), /绝对路径/)
  await assert.rejects(() => writeFileTool({ path: 'a.txt', content: 'hi' }), /绝对路径/)
  await assert.rejects(() => editFileTool({ path: 'a.txt', old_string: 'x', new_string: 'y' }), /绝对路径/)
  // 绝对路径无 userId 也走授权判定 → 未授权/不存在即拒绝，不因开关而放行
  const inside = path.join(workspace, 'inside.txt')
  await assert.rejects(() => readFileTool({ path: inside }), /未获得读取授权|越出 workspace|绝对路径|路径不存在/)
})

test('shell 默认禁用:WORKSPACE_SHELL_ENABLED 未设时,bash_exec 返回 403', async () => {
  await assert.rejects(() => bashExecTool({ command: 'echo hi' }), /WORKSPACE_SHELL_ENABLED/)
})

test('bash_exec permission override is internal-only and checks exactly the selected alias', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  const userId = `shell-permission-${process.pid}-${Date.now()}`
  createNormalUser({ id: userId, email: `${userId}@example.com` })
  setUserToolPermission({ userId, toolName: 'bash_exec', enabled: false })
  setUserToolPermission({ userId, toolName: 'run_command', enabled: true })

  await assert.rejects(
    () => bashExecTool({
      command: 'echo must-not-run',
      userId,
      permissionToolName: 'run_command',
    }),
    (error) => error?.code === 'TOOL_DISABLED' && /bash_exec/u.test(error.message),
  )

  const result = await bashExecTool(
    { command: 'echo RUN_COMMAND_PERMISSION_OK', userId },
    { permissionToolName: 'run_command' },
  )
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.stdout, /RUN_COMMAND_PERMISSION_OK/u)

  setUserToolPermission({ userId, toolName: 'bash_exec', enabled: true })
  setUserToolPermission({ userId, toolName: 'run_command', enabled: false })
  await assert.rejects(
    () => bashExecTool(
      { command: 'echo must-not-run', userId },
      { permissionToolName: 'run_command' },
    ),
    (error) => error?.code === 'TOOL_DISABLED' && /run_command/u.test(error.message),
  )
})

test('write_file permission override lets patch_file use the writer without inheriting write_file', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  const userId = `write-permission-${process.pid}-${Date.now()}`
  createNormalUser({ id: userId, email: `${userId}@example.com` })
  setUserToolPermission({ userId, toolName: 'write_file', enabled: false })
  setUserToolPermission({ userId, toolName: 'patch_file', enabled: true })

  await assert.rejects(
    () => writeFileTool({
      path: 'permission-injection.txt',
      content: 'must not be written',
      userId,
      permissionToolName: 'patch_file',
    }),
    (error) => error?.code === 'TOOL_DISABLED' && /write_file/u.test(error.message),
  )

  const result = await writeFileTool(
    { path: 'permission-patch.txt', content: 'patched through canonical alias', userId },
    { permissionToolName: 'patch_file' },
  )
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(path.join(workspace, 'permission-patch.txt'), 'utf8'), 'patched through canonical alias')

  setUserToolPermission({ userId, toolName: 'write_file', enabled: true })
  setUserToolPermission({ userId, toolName: 'patch_file', enabled: false })
  await assert.rejects(
    () => writeFileTool(
      { path: 'permission-denied.txt', content: 'must not be written', userId },
      { permissionToolName: 'patch_file' },
    ),
    (error) => error?.code === 'TOOL_DISABLED' && /patch_file/u.test(error.message),
  )
})

test('resolveInWorkspace 拦截 .. 越界:相对路径逃出 workspace 被拒', () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  // 这种典型 path traversal 必须被拦
  assert.throws(() => resolveInWorkspace('../../../etc/passwd'), /越出|不存在/)
})

test('resolveInWorkspace 拦截绝对路径越界:指向 workspace 外的绝对路径被拒', () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc'
  assert.throws(() => resolveInWorkspace(outside), /越出/)
})

test('read_file:启用后能读 workspace 内的文件,返回 path 是相对路径', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  fs.writeFileSync(path.join(workspace, 'sample.txt'), 'line1\nline2\nline3\n', 'utf8')
  const result = await readFileTool({ path: 'sample.txt' })
  assert.equal(result.ok, true)
  assert.equal(result.content.startsWith('line1'), true)
  assert.equal(result.path, 'sample.txt')
  assert.equal(result.totalLines, 4) // 含尾部空行
})

test('read_file:offset/limit 切片正确', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  fs.writeFileSync(path.join(workspace, 'multi.txt'), 'a\nb\nc\nd\ne', 'utf8')
  const result = await readFileTool({ path: 'multi.txt', offset: 1, limit: 2 })
  assert.equal(result.ok, true)
  assert.equal(result.content, 'b\nc')
  assert.equal(result.returnedLines, 2)
})

test('read_file:本地 PDF 返回提取文本而不是 UTF-8 二进制内容', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Page >> endobj',
    'BT',
    '(Quarterly revenue grew 42 percent.) Tj',
    'ET',
    '%%EOF',
  ].join('\n')
  fs.writeFileSync(path.join(workspace, 'report.pdf'), Buffer.from(pdf, 'latin1'))

  const result = await readFileTool({ path: 'report.pdf' })

  assert.equal(result.ok, true)
  assert.equal(result.mimeType, 'application/pdf')
  assert.equal(result.extractionStatus, 'text')
  assert.equal(result.requiresVision, false)
  assert.match(result.content, /Quarterly revenue grew 42 percent\./)
  assert.doesNotMatch(result.content, /%PDF-1\.4/)
})

test('read_file:提取 FlateDecode PDF 正文且不会把文档元数据当正文', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  const stream = deflateSync(Buffer.from('BT (Compressed PDF body 2026) Tj ET', 'latin1'))
  const pdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\n/Producer (Metadata Only 123)\n%%EOF', 'latin1'),
  ])
  fs.writeFileSync(path.join(workspace, 'compressed.pdf'), pdf)

  const result = await readFileTool({ path: 'compressed.pdf' })

  assert.equal(result.extractionStatus, 'text')
  assert.match(result.content, /Compressed PDF body 2026/)
  assert.doesNotMatch(result.content, /Metadata Only 123/)
})

test('read_file:扫描或无正文 PDF 返回 no_text 且要求视觉处理', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  fs.writeFileSync(
    path.join(workspace, 'scan.pdf'),
    Buffer.from('%PDF-1.4\n/Producer (Acme PDF Generator 123)\n%%EOF', 'latin1'),
  )

  const result = await readFileTool({ path: 'scan.pdf' })

  assert.equal(result.ok, true)
  assert.equal(result.extractionStatus, 'no_text')
  assert.equal(result.requiresVision, true)
  assert.doesNotMatch(result.content, /Acme PDF Generator 123/)
})

test('read_file:通过 PDF 文件签名识别无扩展名的授权文件', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  fs.writeFileSync(
    path.join(workspace, 'report.bin'),
    Buffer.from('%PDF-1.4\nBT (Magic PDF body) Tj ET\n%%EOF', 'latin1'),
  )

  const result = await readFileTool({ path: 'report.bin' })

  assert.equal(result.mimeType, 'application/pdf')
  assert.equal(result.extractionStatus, 'text')
  assert.match(result.content, /Magic PDF body/)
})

test('write_file:启用后能创建新文件,父目录自动 mkdir', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  const result = await writeFileTool({ path: 'sub/dir/new.txt', content: 'hello' })
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(path.join(workspace, 'sub/dir/new.txt'), 'utf8'), 'hello')
  assert.equal(result.bytes, 5)
  assert.deepEqual(result.changes, [{ path: 'sub/dir/new.txt', additions: 1, deletions: 0 }])
})

test('write_file line stats exclude unchanged prefix and suffix lines', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  fs.writeFileSync(path.join(workspace, 'rewrite.txt'), 'keep\nold\ntail\n', 'utf8')

  const result = await writeFileTool({ path: 'rewrite.txt', content: 'keep\nnew\ntail\n' })

  assert.deepEqual(result.changes, [{ path: 'rewrite.txt', additions: 1, deletions: 1 }])
})

test('edit_file:唯一 old_string 替换成功', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  fs.writeFileSync(path.join(workspace, 'edit.txt'), 'foo bar baz', 'utf8')
  const result = await editFileTool({ path: 'edit.txt', old_string: 'bar', new_string: 'BAR' })
  assert.equal(result.ok, true)
  assert.equal(result.replacedCount, 1)
  assert.equal(fs.readFileSync(path.join(workspace, 'edit.txt'), 'utf8'), 'foo BAR baz')
})

test('edit_file:old_string 多次出现且未传 replace_all,拒绝', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  fs.writeFileSync(path.join(workspace, 'dup.txt'), 'x x x', 'utf8')
  await assert.rejects(
    () => editFileTool({ path: 'dup.txt', old_string: 'x', new_string: 'Y' }),
    /多次|replace_all/
  )
})

test('edit_file:replace_all 替换全部', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  fs.writeFileSync(path.join(workspace, 'all.txt'), 'a b a b a', 'utf8')
  const result = await editFileTool({ path: 'all.txt', old_string: 'a', new_string: 'A', replace_all: true })
  assert.equal(result.ok, true)
  assert.equal(result.replacedCount, 3)
  assert.equal(fs.readFileSync(path.join(workspace, 'all.txt'), 'utf8'), 'A b A b A')
  assert.deepEqual(result.changes, [{ path: 'all.txt', additions: 1, deletions: 1 }])
})

test('edit_file:old_string 不存在,拒绝', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  fs.writeFileSync(path.join(workspace, 'miss.txt'), 'hello', 'utf8')
  await assert.rejects(
    () => editFileTool({ path: 'miss.txt', old_string: 'world', new_string: 'X' }),
    /未找到/
  )
})

test('bash_exec:启用后能跑简单命令', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  const result = await bashExecTool({ command: 'echo hi', expected_outputs: [] })
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /hi/)
  assert.equal('verifiedOutputs' in result, false, '空 expected_outputs 不改变只读命令返回结构')
  assert.equal('changedPaths' in result, false)
})

test('bash_exec:expected_outputs 验证新建二进制文件并返回真实 changedPaths', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  fs.writeFileSync(path.join(workspace, 'fresh-source.bin'), Buffer.from([0, 255, 1, 2]))
  const result = await bashExecTool({
    command: process.platform === 'win32'
      ? 'copy /y fresh-source.bin fresh.bin > nul'
      : 'cp fresh-source.bin fresh.bin',
    expected_outputs: ['fresh.bin'],
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.changedPaths, ['fresh.bin'])
  assert.deepEqual(result.unverifiedOutputs, [])
  assert.equal(result.verifiedOutputs[0].status, 'created')
  assert.equal(result.verifiedOutputs[0].type, 'file')
  assert.equal(result.verifiedOutputs[0].size, 4)
  assert.deepEqual([...fs.readFileSync(path.join(workspace, 'fresh.bin'))], [0, 255, 1, 2])
})

test('bash_exec:同尺寸二进制内容变化通过内容指纹验证', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  fs.writeFileSync(path.join(workspace, 'same-size.bin'), Buffer.from([1, 2, 3, 4]))
  fs.writeFileSync(path.join(workspace, 'replacement.bin'), Buffer.from([4, 3, 2, 1]))
  const result = await bashExecTool({
    command: process.platform === 'win32'
      ? 'copy /y replacement.bin same-size.bin > nul'
      : 'cp replacement.bin same-size.bin',
    expected_outputs: ['same-size.bin'],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.changedPaths, ['same-size.bin'])
  assert.equal(result.verifiedOutputs[0].status, 'modified')
  assert.equal(result.verifiedOutputs[0].contentChanged, true)
  assert.equal(result.verifiedOutputs[0].sizeChanged, false)
})

test('bash_exec:目录 expected_output 递归识别新增二进制内容', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  fs.mkdirSync(path.join(workspace, 'generated-dir'))
  fs.writeFileSync(path.join(workspace, 'nested-source.bin'), Buffer.from([9, 8, 7]))
  const result = await bashExecTool({
    command: process.platform === 'win32'
      ? 'copy /y nested-source.bin generated-dir\\nested.bin > nul'
      : 'cp nested-source.bin generated-dir/nested.bin',
    expected_outputs: ['generated-dir'],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.changedPaths, ['generated-dir'])
  assert.equal(result.verifiedOutputs[0].type, 'directory')
  assert.equal(result.verifiedOutputs[0].contentChanged, true)
})

test('bash_exec:预存但未变化的 expected_output 不会被误报成功', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  fs.writeFileSync(path.join(workspace, 'stale.txt'), 'already here', 'utf8')
  const result = await bashExecTool({ command: 'echo verification-probe', expected_outputs: ['stale.txt'] })

  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 0)
  assert.equal(result.code, 'EXPECTED_OUTPUT_VERIFICATION_FAILED')
  assert.equal(result.verificationFailed, true)
  assert.match(result.stdout, /verification-probe/)
  assert.deepEqual(result.verifiedOutputs, [])
  assert.equal(result.unverifiedOutputs[0].status, 'unchanged')
  assert.deepEqual(result.changedPaths, [])
})

test('bash_exec:非零退出仍保留进程输出与已发生的 expected_output 变化', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  const command = process.platform === 'win32'
    ? 'echo partial>partial.txt & echo deliberate-failure 1>&2 & exit /b 7'
    : 'printf partial > partial.txt; printf deliberate-failure >&2; exit 7'
  const result = await bashExecTool({ command, expected_outputs: ['partial.txt'] })

  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 7)
  assert.match(result.stderr, /deliberate-failure/)
  assert.deepEqual(result.changedPaths, ['partial.txt'])
  assert.equal(result.verifiedOutputs[0].status, 'created')
})

test('bash_exec:相对 expected_output 按 effective cwd 解析且不能越出授权边界', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  fs.mkdirSync(path.join(workspace, 'effective-cwd'))
  await assert.rejects(
    () => bashExecTool({
      cwd: 'effective-cwd',
      command: 'echo should-not-run > sentinel.txt',
      expected_outputs: ['../../escaped.txt'],
    }),
    /越出 workspace|未获得写入授权/,
  )
  assert.equal(fs.existsSync(path.join(workspace, 'effective-cwd', 'sentinel.txt')), false)
})

test('bash_exec:用户授权目录内的相对 expected_output 使用实际 cwd 验证', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  const userId = 'fs-shell-output-user'
  createNormalUser({ id: userId, email: 'fs-shell-output@example.com' })
  grantLocalPath({ userId, rootPath: authorizedWorkspace, accessMode: 'read_write' })
  setWorkspaceTrust({
    userId,
    rootPath: authorizedWorkspace,
    trusted: true,
    confirmation: 'TRUST_WORKSPACE_CONFIG',
  })
  fs.writeFileSync(path.join(authorizedWorkspace, 'authorized-source.bin'), Buffer.from([6, 5, 4]))
  const result = await bashExecTool({
    userId,
    cwd: authorizedWorkspace,
    command: process.platform === 'win32'
      ? 'copy /y authorized-source.bin authorized.bin > nul'
      : 'cp authorized-source.bin authorized.bin',
    expected_outputs: ['authorized.bin'],
  })

  const expectedPath = path.join(fs.realpathSync(authorizedWorkspace), 'authorized.bin')
  assert.equal(result.ok, true)
  assert.equal(result.cwd, fs.realpathSync(authorizedWorkspace))
  assert.deepEqual(result.changedPaths, [expectedPath])
  assert.equal(result.verifiedOutputs[0].scope, 'grant')
})

test('bash_exec: Windows preserves quoted absolute paths when cwd contains parentheses', {
  skip: process.platform !== 'win32',
}, async () => {
  const userId = 'fs-shell-parentheses-user'
  const specialWorkspace = path.join(authorizedWorkspace, 'directory (1)')
  const outputPath = path.join(specialWorkspace, 'parentheses-output.txt')
  fs.mkdirSync(specialWorkspace, { recursive: true })
  createNormalUser({ id: userId, email: 'fs-shell-parentheses@example.com' })
  grantLocalPath({ userId, rootPath: specialWorkspace, accessMode: 'read_write' })

  const result = await bashExecTool({
    userId,
    cwd: specialWorkspace,
    command: `echo parentheses-ok > "${outputPath}"`,
    expected_outputs: [outputPath],
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.exitCode, 0)
  assert.equal(fs.readFileSync(outputPath, 'utf8').trim(), 'parentheses-ok')
  assert.deepEqual(result.changedPaths, [outputPath])
})

test('bash_exec: omitted cwd does not choose between multiple read-write directory grants', async () => {
  process.env.WORKSPACE_SHARED_TRUSTED = '0'
  const userId = `fs-shell-multiple-grants-${process.pid}-${Date.now()}`
  const firstRoot = path.join(authorizedWorkspace, `${userId}-first`)
  const secondRoot = path.join(authorizedWorkspace, `${userId}-second`)
  const firstFile = path.join(firstRoot, 'first.txt')
  const secondFile = path.join(secondRoot, 'second.txt')
  fs.mkdirSync(firstRoot, { recursive: true })
  fs.mkdirSync(secondRoot, { recursive: true })
  fs.writeFileSync(firstFile, 'first', 'utf8')
  fs.writeFileSync(secondFile, 'second', 'utf8')
  createNormalUser({ id: userId, email: `${userId}@example.com` })
  grantLocalPath({ userId, rootPath: firstRoot, accessMode: 'read_write' })
  grantLocalPath({ userId, rootPath: secondRoot, accessMode: 'read_write' })

  await assert.rejects(
    () => bashExecTool({
      userId,
      command: `echo "${firstFile}" "${secondFile}"`,
    }),
    (error) => error?.code === 'PATH_NOT_AUTHORIZED',
  )
})

test('bash_exec: omitted cwd never promotes read-only or exact-file grants to shell roots', async () => {
  process.env.WORKSPACE_SHARED_TRUSTED = '0'
  const readOnlyUser = `fs-shell-read-only-${process.pid}-${Date.now()}`
  const fileGrantUser = `fs-shell-file-grant-${process.pid}-${Date.now()}`
  const readOnlyRoot = path.join(authorizedWorkspace, `${readOnlyUser}-root`)
  const readOnlyFile = path.join(readOnlyRoot, 'input.txt')
  const exactFile = path.join(authorizedWorkspace, `${fileGrantUser}-input.txt`)
  fs.mkdirSync(readOnlyRoot, { recursive: true })
  fs.writeFileSync(readOnlyFile, 'read-only', 'utf8')
  fs.writeFileSync(exactFile, 'file-grant', 'utf8')
  createNormalUser({ id: readOnlyUser, email: `${readOnlyUser}@example.com` })
  createNormalUser({ id: fileGrantUser, email: `${fileGrantUser}@example.com` })
  grantLocalPath({ userId: readOnlyUser, rootPath: readOnlyRoot, accessMode: 'read_only' })
  grantLocalPath({ userId: fileGrantUser, rootPath: exactFile, accessMode: 'read_write' })

  for (const [userId, target] of [[readOnlyUser, readOnlyFile], [fileGrantUser, exactFile]]) {
    await assert.rejects(
      () => bashExecTool({ userId, command: `echo "${target}"` }),
      (error) => error?.code === 'PATH_NOT_AUTHORIZED',
    )
  }
})

test('bash_exec: Windows rejects an unquoted parenthesized absolute path with an actionable error', {
  skip: process.platform !== 'win32',
}, async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  const specialWorkspace = path.join(workspace, 'unquoted-directory(1)')
  const inputPath = path.join(specialWorkspace, 'input.txt')
  fs.mkdirSync(specialWorkspace, { recursive: true })
  fs.writeFileSync(inputPath, 'input', 'utf8')

  await assert.rejects(
    () => bashExecTool({
      cwd: specialWorkspace,
      command: `type ${inputPath}`,
      expected_outputs: [],
    }),
    (error) => {
      assert.equal(error?.code, 'SHELL_PATH_QUOTING_REQUIRED')
      assert.equal(error?.statusCode, 400)
      assert.match(error?.hint || '', /双引号/)
      return true
    },
  )
})

test('bash_exec:超时返回 timedOut', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  const cmd = process.platform === 'win32'
    ? 'ping -n 4 127.0.0.1 > nul'  // ~3s 等待
    : 'sleep 3'
  const result = await bashExecTool({ command: cmd, timeout_ms: 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
})

test('bash_exec: AbortSignal 取消后清理进程并返回 cancelled', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  const controller = new AbortController()
  const cmd = process.platform === 'win32'
    ? 'ping -n 20 127.0.0.1'
    : 'sleep 10'
  const startedAt = Date.now()
  const pending = bashExecTool({ command: cmd, timeout_ms: 10_000, signal: controller.signal })
  setTimeout(() => controller.abort(), 100)

  const result = await pending
  const elapsed = Date.now() - startedAt
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, true)
  assert.equal(result.timedOut, undefined)
  assert.ok(elapsed < 4_000, `取消后应在 4s 内退出,实际 ${elapsed}ms`)
})

test('bash_exec:敏感 env 被屏蔽传给子进程', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  process.env.MODEL_API_KEY = 'sk-secret-test'
  const cmd = process.platform === 'win32' ? 'echo %MODEL_API_KEY%' : 'echo "$MODEL_API_KEY"'
  const result = await bashExecTool({ command: cmd })
  assert.equal(result.ok, true)
  // 子进程拿到的应该是空(我们传了空串覆盖),不是真实的 sk-secret-test
  assert.equal(result.stdout.includes('sk-secret-test'), false)
  delete process.env.MODEL_API_KEY
})

test('bash_exec: approved env_keys inject operational credentials and redact command output', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  const previous = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'gugo-controlled-token-value'
  try {
    const result = await bashExecTool({
      command: 'node -e "process.stdout.write(process.env.GH_TOKEN || \'missing\')"',
      env_keys: ['GH_TOKEN'],
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.sensitiveOutputRedacted, true)
    assert.match(result.stdout, /\[REDACTED\]/u)
    assert.doesNotMatch(JSON.stringify(result), /gugo-controlled-token-value/u)
  } finally {
    if (previous == null) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previous
  }
})

test('bash_exec: env_keys rejects missing variables and Gugo service credentials', async () => {
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  process.env.OPENAI_API_KEY = 'protected-service-value'
  try {
    await assert.rejects(
      () => bashExecTool({ command: 'node -v', env_keys: ['OPENAI_API_KEY'] }),
      (error) => error?.code === 'SHELL_ENV_KEY_PROTECTED',
    )
    await assert.rejects(
      () => bashExecTool({ command: 'node -v', env_keys: ['GUGO_ENV_THAT_DOES_NOT_EXIST'] }),
      (error) => error?.code === 'SHELL_ENV_KEY_NOT_FOUND',
    )
  } finally {
    delete process.env.OPENAI_API_KEY
  }
})
