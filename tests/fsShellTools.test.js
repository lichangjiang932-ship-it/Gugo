import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readFileTool,
  writeFileTool,
  editFileTool,
  bashExecTool,
  resolveInWorkspace,
} from '../server/adapters/fsShellTools.js'

// 每个测试自带 workspace 临时目录 + env 闸门管理.
let workspace
const savedEnv = {
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHELL_ENABLED: process.env.WORKSPACE_SHELL_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsshell-'))
  process.env.WORKSPACE_ROOT = workspace
})

after(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  // 每个 test 默认关闭闸门;需要时 test 内显式打开
  delete process.env.WORKSPACE_FS_ENABLED
  delete process.env.WORKSPACE_SHELL_ENABLED
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
})

test('fs 默认禁用:WORKSPACE_FS_ENABLED 未设时,所有 fs 操作返回 403', async () => {
  await assert.rejects(() => readFileTool({ path: 'anything.txt' }), /WORKSPACE_FS_ENABLED/)
  await assert.rejects(() => writeFileTool({ path: 'a.txt', content: 'hi' }), /WORKSPACE_FS_ENABLED/)
  await assert.rejects(() => editFileTool({ path: 'a.txt', old_string: 'x', new_string: 'y' }), /WORKSPACE_FS_ENABLED/)
})

test('shell 默认禁用:WORKSPACE_SHELL_ENABLED 未设时,bash_exec 返回 403', async () => {
  await assert.rejects(() => bashExecTool({ command: 'echo hi' }), /WORKSPACE_SHELL_ENABLED/)
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

test('write_file:启用后能创建新文件,父目录自动 mkdir', async () => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  const result = await writeFileTool({ path: 'sub/dir/new.txt', content: 'hello' })
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(path.join(workspace, 'sub/dir/new.txt'), 'utf8'), 'hello')
  assert.equal(result.bytes, 5)
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
  const result = await bashExecTool({ command: process.platform === 'win32' ? 'echo hi' : 'echo hi' })
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /hi/)
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
