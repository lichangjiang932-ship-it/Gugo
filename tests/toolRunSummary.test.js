import test from 'node:test'
import assert from 'node:assert/strict'

import { buildToolRunSummary } from '../src/lib/chatFlowGuards.js'

/**
 * 这一组守的是那个真实事故:
 * 用户跑了几十步工具、等了几分钟,最后拿到一句
 * 「工具执行已完成。模型未返回详细文字总结，请重试生成说明。」
 * —— 正确的废话,没说改了什么、哪里没做完、下一步怎么办。
 */

test('模型不给正文时,按执行记录合成真实说明 —— 不能只说「请重试」', () => {
  const summary = buildToolRunSummary({
    toolCalls: [
      { name: 'read_file', arguments: '{"path":"a.js"}', ok: true },
      { name: 'read_file', arguments: '{"path":"b.js"}', ok: true },
      { name: 'apply_patch', arguments: '{"path":"src/app.js"}', ok: true },
    ],
    finishReason: 'stop',
  })
  // 必须说清楚做了什么
  assert.match(summary, /读取文件/)
  assert.match(summary, /修改文件/)
  // 必须点名改过的文件 —— 「改了哪些文件」是最需要交代的事
  assert.match(summary, /src\/app\.js/)
  // 必须给下一步
  assert.match(summary, /接下来/)
  // 不准再出现那句废话
  assert.doesNotMatch(summary, /请重试生成说明/)
})

test('finish_reason=length 时要说清楚是「输出预算用完了」而不是模型不肯说', () => {
  const summary = buildToolRunSummary({
    toolCalls: [{ name: 'read_file', arguments: '{}', ok: true }],
    finishReason: 'length',
  })
  // 这是截图那次事故的真实原因:推理模型思考 93778 字,而 max_tokens=4096
  assert.match(summary, /预算|max_tokens/i)
  assert.match(summary, /Max Tokens|思考/)
})

test('失败的步骤要单独列出来,并说明可能导致任务不完整', () => {
  const summary = buildToolRunSummary({
    toolCalls: [
      { name: 'read_file', arguments: '{}', ok: true },
      { name: 'bash_exec', arguments: '{}', ok: false, error: JSON.stringify({ error: '命令超时' }) },
    ],
    finishReason: 'stop',
  })
  assert.match(summary, /失败的步骤/)
  assert.match(summary, /命令超时/)
  assert.match(summary, /不完整/)
})

test('同名工具归类计数,不是流水账', () => {
  const summary = buildToolRunSummary({
    toolCalls: Array.from({ length: 40 }, (_, i) => ({
      name: 'read_file', arguments: JSON.stringify({ path: `f${i}.js` }), ok: true,
    })),
    finishReason: 'stop',
  })
  // 读了 40 个文件应该显示 "× 40",而不是列 40 行
  assert.match(summary, /读取文件 × 40/)
  assert.ok(summary.split('\n').length < 25, '不该逐条列出 40 个文件')
})

test('产出文件要点名', () => {
  const summary = buildToolRunSummary({
    toolCalls: [{ name: 'create_docx', arguments: '{}', ok: true }],
    artifact: { type: 'docx', title: '周报' },
    finishReason: 'stop',
  })
  assert.match(summary, /产出文件/)
  assert.match(summary, /周报/)
})

test('必须声明「没有经过模型确认」—— 不能让用户以为这是模型的结论', () => {
  const summary = buildToolRunSummary({
    toolCalls: [{ name: 'apply_patch', arguments: '{"path":"x.js"}', ok: true }],
    finishReason: 'stop',
  })
  assert.match(summary, /没有经过模型确认|自动汇总/)
})

test('空调用列表也不崩,且仍然给出下一步', () => {
  const summary = buildToolRunSummary({})
  assert.ok(summary.length > 0)
  assert.match(summary, /接下来/)
})

test('畸形 arguments / error 不抛异常', () => {
  const summary = buildToolRunSummary({
    toolCalls: [
      { name: 'apply_patch', arguments: '不是JSON', ok: true },
      { name: 'bash_exec', arguments: null, ok: false, error: '裸字符串错误' },
      { name: '', arguments: undefined, ok: true },
    ],
    finishReason: 'stop',
  })
  assert.ok(summary.length > 0)
  assert.match(summary, /裸字符串错误/)
})
