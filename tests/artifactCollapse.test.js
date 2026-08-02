import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldCollapseArtifactPreview } from '../src/lib/artifactPreview.js'

/**
 * 这一组守的是那个真实事故:
 *
 * 用户说「买卖页面：优化买入卖出股票，现在只有买入和提交模拟买入有高亮…」
 * 屏幕上只出现一张 PPT 卡片,标题是
 * 「看清楚了。问题出在-frontend-index.html-的模拟下单面板…」
 * —— 模型的**文字说明被塞进了 PPT 标题**,而正文一个字都没显示。
 *
 * 根因:shouldCollapseArtifactPreview 在「有产物但没正文」时返回 true,
 * 渲染层据此把整条消息折叠成一张卡,正文分支根本不执行。
 */

const PPTX = { type: 'pptx', label: 'POWERPOINT', filename: 'x.pptx' }

test('★ 工具产出产物但模型没写正文 —— 绝不能折叠,否则兜底说明也被吞掉', () => {
  // 这正是事故现场:create_pptx 产出了 source,但模型没给文字总结。
  // 折叠 = 用户看到一张孤零零的卡片,不知道代码改没改。
  assert.equal(
    shouldCollapseArtifactPreview(PPTX, { content: '', artifactSource: '# deck' }),
    false,
    '没正文时更该显示兜底执行摘要,而不是只剩一张卡',
  )
})

test('工具产出产物且有正文 —— 正文和卡片同时显示', () => {
  assert.equal(
    shouldCollapseArtifactPreview(PPTX, { content: '我改了 3 个文件', artifactSource: '# deck' }),
    false,
  )
})

test('正文恰好就是源码 —— 折叠是对的,没有任何说明会因此丢失', () => {
  // 模型把整篇源码当回复吐出来了。正文区渲染原始源码没有意义,
  // 而且这里本来就没有「说明」可以被吞掉,所以折叠成卡片是正确的。
  assert.equal(
    shouldCollapseArtifactPreview(PPTX, { content: '# deck', artifactSource: '# deck' }),
    true,
  )
})

test('嗅探出来的产物(正文自身就是源码)才折叠 —— 渲染原始 HTML 没意义', () => {
  assert.equal(
    shouldCollapseArtifactPreview(
      { type: 'html' },
      { content: '<!doctype html><html>…</html>', artifactSource: '' },
    ),
    true,
  )
})

test('没有 preview 就无所谓折叠', () => {
  assert.equal(shouldCollapseArtifactPreview(null, { content: 'hi' }), false)
})
