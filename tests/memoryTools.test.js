import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 长期记忆写入工具。
 *
 * 背景:记忆注入(selectActiveMemoriesForInjection)一直是通的,但**没人写** ——
 * 只有 Memory 管理页能手动加。于是模型在同一个上下文里也像没有记忆:
 * 用户说了「项目在 D:\destok\money」,下一轮它照样不知道。
 */

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-memtools-'))

const { getDb } = await import('../server/db.js')
const { dispatchMemoryTool, MEMORY_TOOL_SPECS } = await import('../server/utils/memoryTools.js')
const { listMemories, selectActiveMemoriesForInjection } = await import('../server/services/memoryStore.js')

const USER = 'mem-tool-user'
const now = Date.now()
getDb().prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
  .run(USER, 'memtools@example.com', now, now)

const write = (title, body, type = 'project') =>
  dispatchMemoryTool('remember', { type, title, body }, { userId: USER })

test('工具规格结构合法', () => {
  assert.equal(MEMORY_TOOL_SPECS.length, 1)
  const spec = MEMORY_TOOL_SPECS[0]
  assert.equal(spec.type, 'function')
  assert.equal(spec.function.name, 'remember')
  assert.deepEqual(spec.function.parameters.required, ['type', 'title', 'body'])
})

test('★ 写入的记忆下一轮会被注入回来', () => {
  const out = write('money 项目路径', String.raw`D:\destok\money,Python + FastAPI`)
  assert.equal(out.ok, true)

  const picked = selectActiveMemoriesForInjection({ userId: USER, tokenCap: 800 })
  const found = picked.memories.find((m) => m.title === 'money 项目路径')
  assert.ok(found, '写进去的记忆必须能被注入路径取到 —— 否则等于没记')
  assert.match(found.body, /destok/)
})

test('★ 同标题覆盖而不是堆重复条目', () => {
  write('技术栈', 'Python')
  const second = write('技术栈', 'Python + FastAPI + SQLite')
  assert.equal(second.updated, true, '第二次应是更新')

  const all = listMemories({ userId: USER }).filter((m) => m.title === '技术栈')
  assert.equal(all.length, 1, '同标题不该产生两条')
  assert.match(all[0].body, /FastAPI/, '应保留最新内容')
})

test('中文标题不会因为 slug 归一而互相覆盖', () => {
  // slug 会把中文全剥掉 → 这些标题都会变成同一个 'memory'。
  // 用 slug 查重会让它们互相覆盖,必须按标题精确比对。
  write('用户偏好', 'A')
  write('项目背景', 'B')
  write('参考资料', 'C')
  const titles = listMemories({ userId: USER }).map((m) => m.title)
  for (const t of ['用户偏好', '项目背景', '参考资料']) {
    assert.equal(titles.filter((x) => x === t).length, 1, `${t} 应独立存在`)
  }
})

test('未登录不能写记忆', () => {
  const out = dispatchMemoryTool('remember', { type: 'project', title: 'x', body: 'y' }, { userId: null })
  assert.equal(out.ok, false)
  assert.match(out.error, /未登录/)
})

test('参数校验:type / title / body', () => {
  assert.equal(write('t', 'b', 'bogus').ok, false, '非法 type 应拒绝')
  assert.equal(write('', 'b').ok, false, '空 title 应拒绝')
  assert.equal(write('t', '').ok, false, '空 body 应拒绝')
  // 但都不能抛
  for (const args of [{}, null, { type: 'project' }]) {
    assert.doesNotThrow(() => dispatchMemoryTool('remember', args, { userId: USER }))
  }
})

test('超长内容被截断而不是报错', () => {
  const out = write('长记忆', 'x'.repeat(99999))
  assert.equal(out.ok, true)
  const found = listMemories({ userId: USER }).find((m) => m.title === '长记忆')
  assert.ok(found.body.length <= 4000, '应截断到上限内')
})

test('未知工具名抛错', () => {
  assert.throws(() => dispatchMemoryTool('forget', {}, { userId: USER }), /unknown memory tool/)
})

test('记忆按用户隔离', () => {
  const other = 'mem-other-user'
  getDb().prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
    .run(other, 'memother@example.com', now, now)
  dispatchMemoryTool('remember', { type: 'user', title: '别人的记忆', body: 'secret' }, { userId: other })

  const mine = listMemories({ userId: USER }).map((m) => m.title)
  assert.ok(!mine.includes('别人的记忆'), '不能看到别的用户的记忆')
})
