import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  buildHtmlPreview,
  buildPremiumHtmlPreview,
  buildPresentationFilename,
  createPptxBlobFromMarkdown,
  parseMarkdownSlides,
  shouldOfferPptxExport,
} from '../src/lib/presentationExport.js'

test('parses markdown slides separated by horizontal rules', () => {
  const slides = parseMarkdownSlides(`# 标题页

GPT-5.6 即将到来

---

## 竞争格局

- OpenAI 与 Anthropic 正面竞争
- 企业开始多模型部署`)

  assert.equal(slides.length, 2)
  assert.equal(slides[0].title, '标题页')
  assert.deepEqual(slides[0].bullets, ['GPT-5.6 即将到来'])
  assert.equal(slides[1].title, '竞争格局')
  assert.deepEqual(slides[1].bullets, ['OpenAI 与 Anthropic 正面竞争', '企业开始多模型部署'])
})

test('infers untagged table and image slides for backwards-compatible layouts', () => {
  const markdown = `# Cover
Intro

---

## Metrics

| A | B |
| - | - |
| 1 | 2 |

---

## Visual

![chart](image)
- trend`
  const slides = parseMarkdownSlides(markdown)

  assert.equal(slides[1].type, 'table')
  assert.equal(slides[2].type, 'image')

  const html = buildHtmlPreview(markdown)
  assert.match(html, /<div class="slide slide-table">[\s\S]*Metrics/)
  assert.match(html, /<div class="slide slide-image">[\s\S]*Visual/)
})

test('premium export keeps off-screen capture slides renderable', () => {
  const source = fs.readFileSync(new URL('../src/lib/presentationExport.js', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /visibility:hidden/)
  assert.match(source, /left:-99999px/)
})

test('parses numbered outline output when the model omits separators', () => {
  const slides = parseMarkdownSlides(`GPT-5.6 即将到来
OpenAI 最新发展 & 与 Claude 的竞争格局

1. 引言：AI 竞赛进入新阶段
2024-2025 年，大语言模型迭代速度加快
OpenAI 与 Anthropic 形成强力竞争

2. OpenAI 路线图
2023: GPT-4 发布
2024: GPT-4o 发布`)

  assert.equal(slides.length, 3)
  assert.equal(slides[0].title, 'GPT-5.6 即将到来')
  assert.equal(slides[1].title, '引言：AI 竞赛进入新阶段')
  assert.deepEqual(slides[1].bullets, [
    '2024-2025 年，大语言模型迭代速度加快',
    'OpenAI 与 Anthropic 形成强力竞争',
  ])
  assert.equal(slides[2].title, 'OpenAI 路线图')
})

test('detects ppt replies and creates safe filenames', () => {
  assert.equal(shouldOfferPptxExport({ skillId: 'ppt', artifactType: undefined }), true)
  assert.equal(shouldOfferPptxExport({ skillId: undefined, artifactType: 'pptx' }), true)
  assert.equal(shouldOfferPptxExport({ skillId: 'doc', artifactType: undefined }), false)
  assert.equal(buildPresentationFilename('GPT-5.6 即将到来: OpenAI / Claude?'), 'GPT-5.6-即将到来-OpenAI-Claude.pptx')
})

test('creates a pptx blob from markdown for explicit browser download', async () => {
  const blob = await createPptxBlobFromMarkdown('# Demo\nIntro\n\n---\n\n## Plan\n- Build\n- Ship')

  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
  assert.ok(blob.size > 1000)
})

test('keeps a concise final content slide as content instead of forcing an ending slide', () => {
  const html = buildHtmlPreview(`# 封面
副标题

---

## 市场结论
- 增长仍在继续`)

  assert.match(html, /<div class="slide slide-content[^"]*">[\s\S]*content-card-grid/)
  assert.equal(html.includes('\u5e02\u573a\u7ed3\u8bba'), true)
  assert.doesNotMatch(html, /<div class="slide slide-end">[\s\S]*市场结论/)
})

test('presentation themes vary by topic cues', async () => {
  const mod = await import('../src/lib/presentationExport.js')
  assert.equal(mod.resolvePresentationTheme('AI product roadmap').id, 'tech')
  assert.equal(mod.resolvePresentationTheme('bank annual strategy').id, 'finance')
  assert.equal(mod.resolvePresentationTheme('consumer brand launch').id, 'consumer')
})

test('parses Chinese page headings into multiple slides for ppt artifacts', () => {
  const slides = parseMarkdownSlides(`以下是一份5页产品介绍PPT的完整内容方案\n\n第1页：封面页\n- 产品名称\n\n第2页：核心卖点\n- 快\n\n第3页：功能亮点\n- 稳`)

  assert.equal(slides.length, 3)
  assert.equal(slides[0].title, '封面页')
  assert.equal(slides[1].title, '核心卖点')
})


test('default PPT preview uses premium responsive visual system instead of legacy bullet template', () => {
  const html = buildHtmlPreview(`# DeepSeek V4 Pro
Premium agentic reasoning platform

---

## Reasoning becomes production grade
- Multi-step tasks stabilize
- Long context stays controllable
- Tool calls become reliable`)

  assert.match(html, /slide-cover/)
  assert.match(html, /cover-tag/) // premium cover marker
  assert.match(html, /content-card-grid/) // cards, not plain bullet template
  assert.match(html, /@media screen/) // iframe preview is responsive
  assert.doesNotMatch(html, /cover-top-bar/) // old low-fi preview marker
})

test('premium preview alternates content pages and keeps screenshot mode fixed-size', () => {
  const markdown = `# Cover
Subtitle

---

## First strategic claim
- Speed improves 40%
- Cost drops 25%

---

## Second strategic claim
- Integration is lighter
- Security boundary is clearer`
  const responsive = buildPremiumHtmlPreview(markdown, { responsive: true })
  const screenshot = buildPremiumHtmlPreview(markdown)

  assert.match(responsive, /slide-content-dark|slide-content-light/)
  assert.match(responsive, /content-card-index/)
  assert.match(responsive, /@media screen/)
  assert.doesNotMatch(screenshot, /@media screen/)
})
