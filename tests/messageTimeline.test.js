import test from 'node:test'
import assert from 'node:assert/strict'

import { buildMessageTimeline } from '../src/lib/messageTimeline.js'

/**
 * 消息时间线:把 content(一整个字符串)和 toolCalls(另一个数组)还原成
 * 「按真实发生顺序」的片段序列。
 *
 * 以前渲染是「一整块工具调用 + 最后的正文」,用户读起来像先给结论后干活,
 * 顺序是反的。每个 toolCall 记了 textOffset(调用发生时正文写到哪),
 * 用它交错还原:说一段 → 干几件事 → 再说一段。
 */

const call = (id, textOffset, extra = {}) => ({ id, name: 'read_file', status: 'success', textOffset, ...extra })

test('没有工具调用时就是一段纯文本', () => {
  assert.deepEqual(buildMessageTimeline('你好', []), [{ kind: 'text', text: '你好' }])
})

test('空消息返回空序列', () => {
  assert.deepEqual(buildMessageTimeline('', []), [])
  assert.deepEqual(buildMessageTimeline('', null), [])
})

test('★ 核心:先说话再干活,顺序必须是 文本 → 工具', () => {
  const text = '让我先看看项目结构。'
  const segs = buildMessageTimeline(text, [call('c1', text.length)])
  assert.equal(segs.length, 2)
  assert.equal(segs[0].kind, 'text')
  assert.equal(segs[0].text, '让我先看看项目结构。')
  assert.equal(segs[1].kind, 'tools')
  assert.equal(segs[1].calls.length, 1)
})

test('★ 核心:说一段 → 干活 → 再说一段,三段交错', () => {
  const head = '先读文件。'
  const tail = '读完了,发现问题在路由。'
  const segs = buildMessageTimeline(head + tail, [call('c1', head.length)])
  assert.deepEqual(segs.map((s) => s.kind), ['text', 'tools', 'text'])
  assert.equal(segs[0].text, head)
  assert.equal(segs[2].text, tail)
})

test('同一时刻的多个调用合成一批,不拆成多个折叠条', () => {
  const head = '并行看几个文件。'
  const segs = buildMessageTimeline(head + '看完了。', [
    call('c1', head.length),
    call('c2', head.length),
    call('c3', head.length),
  ])
  assert.deepEqual(segs.map((s) => s.kind), ['text', 'tools', 'text'])
  assert.equal(segs[1].calls.length, 3, '同一批应合并渲染')
})

test('多轮交错:文本/工具/文本/工具/文本', () => {
  const a = '第一步。'
  const b = '第二步。'
  const c = '收工。'
  const segs = buildMessageTimeline(a + b + c, [
    call('c1', a.length),
    call('c2', (a + b).length),
  ])
  assert.deepEqual(segs.map((s) => s.kind), ['text', 'tools', 'text', 'tools', 'text'])
  assert.equal(segs[0].text, a)
  assert.equal(segs[2].text, b)
  assert.equal(segs[4].text, c)
})

test('工具在最前面(模型一句话没说就动手)', () => {
  const segs = buildMessageTimeline('干完了。', [call('c1', 0)])
  assert.deepEqual(segs.map((s) => s.kind), ['tools', 'text'])
})

test('★ 兼容:老数据没有 textOffset,退化成「工具在前」,不崩不乱序', () => {
  const segs = buildMessageTimeline('回复内容', [
    { id: 'old1', name: 'read_file', status: 'success' },
    { id: 'old2', name: 'grep_code', status: 'error' },
  ])
  assert.deepEqual(segs.map((s) => s.kind), ['tools', 'text'])
  assert.equal(segs[0].calls.length, 2, '老数据应归为同一批')
  assert.equal(segs[1].text, '回复内容')
})

test('畸形 textOffset 被夹到合法区间,不切出乱序或空片段', () => {
  const text = '短文本'
  for (const bad of [-5, NaN, Infinity, 999, '3', null, undefined]) {
    const segs = buildMessageTimeline(text, [call('c1', bad)])
    assert.ok(segs.length > 0, `offset=${bad} 不该返回空`)
    // 不能出现空文本片段
    for (const seg of segs) {
      if (seg.kind === 'text') assert.ok(seg.text.length > 0, `offset=${bad} 切出了空文本片段`)
    }
    // 文本总量必须守恒
    const joined = segs.filter((s) => s.kind === 'text').map((s) => s.text).join('')
    assert.equal(joined, text, `offset=${bad} 丢了文本`)
  }
})

test('文本内容守恒:任何情况下拼回来都等于原文', () => {
  const text = 'A'.repeat(10) + 'B'.repeat(10) + 'C'.repeat(10)
  const segs = buildMessageTimeline(text, [call('c1', 10), call('c2', 20), call('c3', 30)])
  const joined = segs.filter((s) => s.kind === 'text').map((s) => s.text).join('')
  assert.equal(joined, text)
})

test('乱序传入的 toolCalls 会按 offset 排好', () => {
  const text = 'AAABBBCCC'
  const segs = buildMessageTimeline(text, [call('c2', 6), call('c1', 3)])
  const toolSegs = segs.filter((s) => s.kind === 'tools')
  assert.equal(toolSegs[0].calls[0].id, 'c1', '先发生的应排在前面')
  assert.equal(toolSegs[1].calls[0].id, 'c2')
})

test('畸形入参不抛错', () => {
  for (const [content, calls] of [[null, null], [undefined, undefined], [123, 'x'], [{}, [null, undefined]]]) {
    assert.doesNotThrow(() => buildMessageTimeline(content, calls))
  }
})
