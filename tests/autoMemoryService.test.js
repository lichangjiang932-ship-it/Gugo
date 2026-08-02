import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-auto-memory-'))

const { getDb } = await import('../server/db.js')
const { listMemories, upsertMemory } = await import('../server/services/memoryStore.js')
const {
  extractAndStoreAutoMemories,
  shouldExtractAutoMemory,
} = await import('../server/services/autoMemoryService.js')

const USER_ID = 'auto-memory-user'
const now = Date.now()
getDb().prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
  .run(USER_ID, 'auto-memory@example.com', now, now)

test('auto memory extracts durable facts, rejects low confidence and sensitive values', async () => {
  const result = await extractAndStoreAutoMemories({
    userId: USER_ID,
    sessionId: 'session-1',
    agentId: null,
    messages: [{ id: 'message-1', role: 'user', content: '我的 money 项目固定在 D:\\destok\\money，并且以后都用中文回复。' }],
    assistantText: '明白。',
    callModel: async () => JSON.stringify({
      memories: [
        { type: 'project', title: 'money 项目路径', body: 'money 项目固定在 D:\\destok\\money。', confidence: 0.96 },
        { type: 'user', title: '回复语言', body: '用户偏好使用中文回复。', confidence: 0.92 },
        { type: 'reference', title: '临时猜测', body: '这可能只是一次性的。', confidence: 0.4 },
        { type: 'user', title: 'API key', body: 'api_key=sk-abcdefghijklmnop', confidence: 0.99 },
      ],
    }),
  })
  assert.equal(result.attempted, true)
  assert.equal(result.stored.length, 2)
  const memories = listMemories({ userId: USER_ID })
  assert.deepEqual(memories.map((memory) => memory.title).sort(), ['money 项目路径', '回复语言'])
  assert.ok(memories.every((memory) => memory.frontmatter.source === 'auto_chat'))
  assert.ok(memories.every((memory) => memory.sourceSessionId === 'session-1'))
})

test('auto memory updates only prior automatic entries and preserves manual memories', async () => {
  upsertMemory({ userId: USER_ID, type: 'user', title: '手工偏好', body: '不要自动覆盖。' })
  const first = await extractAndStoreAutoMemories({
    userId: USER_ID,
    messages: [{ role: 'user', content: '以后代码示例统一使用 TypeScript。' }],
    assistantText: '收到。',
    callModel: async () => ({
      content: JSON.stringify({ memories: [
        { type: 'user', title: '代码语言', body: '代码示例统一使用 TypeScript。', confidence: 0.95 },
        { type: 'user', title: '手工偏好', body: '试图覆盖手工内容。', confidence: 0.99 },
      ] }),
    }),
  })
  assert.equal(first.stored.length, 1)
  const second = await extractAndStoreAutoMemories({
    userId: USER_ID,
    messages: [{ role: 'user', content: '代码示例改成 TypeScript strict 模式。' }],
    assistantText: '已更新。',
    callModel: async () => JSON.stringify({ memories: [
      { type: 'user', title: '代码语言', body: '代码示例统一使用 TypeScript strict 模式。', confidence: 0.97 },
    ] }),
  })
  assert.equal(second.stored.length, 1)
  assert.equal(listMemories({ userId: USER_ID }).filter((memory) => memory.title === '代码语言').length, 1)
  assert.equal(listMemories({ userId: USER_ID }).find((memory) => memory.title === '手工偏好').body, '不要自动覆盖。')
})

test('simple greetings and secret-bearing turns never invoke extraction', async () => {
  assert.equal(shouldExtractAutoMemory([{ role: 'user', content: '你好' }], '你好'), false)
  assert.equal(shouldExtractAutoMemory([{ role: 'user', content: 'api_key=sk-abcdefghijklmnop' }], '收到'), false)
  let calls = 0
  const result = await extractAndStoreAutoMemories({
    userId: USER_ID,
    messages: [{ role: 'user', content: '你好' }],
    assistantText: '你好',
    callModel: async () => { calls += 1; return '{}' },
  })
  assert.equal(result.attempted, false)
  assert.equal(calls, 0)
})
