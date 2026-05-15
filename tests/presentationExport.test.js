import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildHtmlPreview,
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

  assert.match(html, /<div class="slide slide-content">[\s\S]*市场结论/)
  assert.doesNotMatch(html, /<div class="slide slide-end">[\s\S]*市场结论/)
})
