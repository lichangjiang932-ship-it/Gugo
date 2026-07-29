import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 回归:grep_code / find_symbol / list_imports 以前硬锁在 WORKSPACE_ROOT,
 * 完全无视用户在「本地文件」里授权的目录 —— 用户授权了 D:\x,
 * list_directory 和 read_file 能读,这三个却一律 403。
 * 模型于是放弃探索,回一句「我无法访问这个路径,请把代码贴给我」。
 * 这里守住:授权后必须能用,没授权仍然拒绝,且拒绝时要说清是哪个路径。
 */

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-cs-grants-'))
process.env.APP_DATA_DIR = tmpData

const { getDb } = await import('../server/db.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { grepCodeTool, findSymbolTool, listImportsTool, dispatchCodeSearchTool } =
  await import('../server/utils/codeSearch.js')

const now = Date.now()
const USER = 'cs-grant-user'
getDb()
  .prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
  .run(USER, 'cs-grants@example.com', now, now)

// 一个 WORKSPACE_ROOT 之外的项目目录
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-project-'))
fs.writeFileSync(
  path.join(project, 'main.py'),
  'import os\nfrom engine import Engine\n\ndef main():\n    return Engine()\n',
)
fs.writeFileSync(path.join(project, 'engine.py'), 'class Engine:\n    pass\n')

test('未授权时三个搜索工具都拒绝,且错误里带上具体路径', async () => {
  for (const [label, run] of [
    ['grep_code', () => grepCodeTool({ pattern: 'import', path: project, userId: USER })],
    ['find_symbol', () => findSymbolTool({ name: 'main', path: project, userId: USER })],
    ['list_imports', () => listImportsTool({ file: path.join(project, 'main.py'), userId: USER })],
  ]) {
    await assert.rejects(run, (err) => {
      assert.equal(err.statusCode, 403, `${label} 应返回 403`)
      // 必须说清是哪个路径 —— 否则模型没法告诉用户去授权什么
      assert.ok(err.message.includes(project), `${label} 的错误里应包含具体路径`)
      return true
    }, `${label} 未授权时应拒绝`)
  }
})

test('★ 授权后三个搜索工具都能在 workspace 之外工作', async () => {
  grantLocalPath({ userId: USER, rootPath: project, accessMode: 'read_only' })

  const grep = await grepCodeTool({ pattern: 'import', path: project, userId: USER })
  assert.ok(grep.matches.length > 0, 'grep_code 应能在已授权目录里搜到内容')

  const sym = await findSymbolTool({ name: 'main', path: project, userId: USER })
  assert.ok(sym.symbols.length > 0, 'find_symbol 应能找到符号')

  const imports = await listImportsTool({ file: path.join(project, 'main.py'), userId: USER })
  assert.ok(imports.imports.length > 0, 'list_imports 应能解析导入')
})

test('dispatchCodeSearchTool 把 userId 透传下去', async () => {
  const result = await dispatchCodeSearchTool('grep_code', { pattern: 'Engine', path: project }, { userId: USER })
  assert.ok(result.matches.length > 0, 'dispatch 层必须把 userId 带下去,否则等于没授权')
})

test('没有 userId 时仍然只能看 workspace(内部调用的老行为不变)', async () => {
  await assert.rejects(
    () => grepCodeTool({ pattern: 'import', path: project }),
    /越界|不存在|授权/,
    '不带 userId 时不应能读到 workspace 之外',
  )
})

test('已授权目录之外的路径仍然拒绝 —— 授权不是全盘放行', async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'not-granted-'))
  fs.writeFileSync(path.join(other, 'secret.txt'), 'x')
  await assert.rejects(
    () => grepCodeTool({ pattern: 'x', path: other, userId: USER }),
    (err) => {
      assert.equal(err.statusCode, 403)
      return true
    },
  )
})
