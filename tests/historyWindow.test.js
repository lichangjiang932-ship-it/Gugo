import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HISTORY_HIGH_WATERMARK,
  HISTORY_LOW_WATERMARK,
  trimHistoryWithHysteresis,
} from '../src/lib/historyWindow.js'

const mk = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i + 1}` }))
const ser = (arr) => arr.map((m) => JSON.stringify(m)).join('\n')
const commonPrefixLen = (a, b) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return i
}

test('低于高水位时原样返回,不裁剪', () => {
  for (const n of [0, 1, 10, HISTORY_HIGH_WATERMARK]) {
    assert.equal(trimHistoryWithHysteresis(mk(n)).length, n, `${n} 条不该被裁`)
  }
})

test('超过高水位裁到低水位', () => {
  assert.equal(trimHistoryWithHysteresis(mk(HISTORY_HIGH_WATERMARK + 1)).length, HISTORY_LOW_WATERMARK)
  assert.equal(trimHistoryWithHysteresis(mk(100)).length, HISTORY_LOW_WATERMARK)
})

test('保留的是最近的消息,不是最老的', () => {
  const out = trimHistoryWithHysteresis(mk(50))
  assert.equal(out[out.length - 1].content, 'm50')
  assert.equal(out.length, HISTORY_LOW_WATERMARK)
})

test('★ 核心:裁剪后连续多轮窗口内容完全不变(前缀可被上游缓存)', () => {
  // 从 31 条(刚裁过)开始,接下来到 30 条之前都不该再裁
  const snapshots = []
  for (let n = HISTORY_LOW_WATERMARK + 1; n <= HISTORY_HIGH_WATERMARK; n += 1) {
    snapshots.push(ser(trimHistoryWithHysteresis(mk(n)).slice(0, HISTORY_LOW_WATERMARK)))
  }
  // 这一段区间里,前 LOW 条始终是同一批消息 → 前缀稳定
  const distinct = new Set(snapshots)
  assert.ok(
    distinct.size < snapshots.length,
    `滞回窗口应让多轮共享同一前缀,实际每轮都不同(${distinct.size}/${snapshots.length})`,
  )
})

test('★ 回归:滞回窗口的前缀复用显著优于固定 slice(-20)', () => {
  const measure = (trim) => {
    let prev = null
    const ratios = []
    for (let n = 20; n <= 45; n += 1) {
      const cur = ser(trim(mk(n)))
      if (prev) ratios.push(commonPrefixLen(prev, cur) / cur.length)
      prev = cur
    }
    return ratios.reduce((s, x) => s + x, 0) / ratios.length
  }
  const before = measure((a) => a.slice(-20))
  const after = measure((a) => trimHistoryWithHysteresis(a))
  assert.ok(after > before * 5, `滞回窗口前缀复用应远高于固定窗口: ${after} vs ${before}`)
})

test('畸形入参不抛', () => {
  for (const bad of [null, undefined, 'x', 123, {}]) {
    assert.doesNotThrow(() => trimHistoryWithHysteresis(bad))
    assert.deepEqual(trimHistoryWithHysteresis(bad), [])
  }
})

test('水位参数非法时退化为安全值,不会返回空窗口', () => {
  const msgs = mk(100)
  assert.ok(trimHistoryWithHysteresis(msgs, { high: 0, low: 0 }).length > 0)
  // low >= high 时退化成 high/2
  assert.equal(trimHistoryWithHysteresis(msgs, { high: 10, low: 50 }).length, 5)
})
