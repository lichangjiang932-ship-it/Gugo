import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildArtifactPrompt,
  buildCitationPrompt,
  buildCodeWorkflowPrompt,
  buildDelayedFollowupPrompt,
} from '../server/services/jobPromptBlocks.js'

test('artifact prompt only injects rules for requested artifact tools', () => {
  const withPpt = buildArtifactPrompt(new Set(['create_pptx']))
  assert.match(withPpt, /create_pptx \(PowerPoint\)/)
  assert.match(withPpt, /User-directed presentation policy/)
  assert.doesNotMatch(withPpt, /create_docx \(Word\)/)

  const withPdf = buildArtifactPrompt(new Set(['create_pdf']))
  assert.match(withPdf, /create_pdf \(PDF\)/)
  assert.doesNotMatch(withPdf, /User-directed presentation policy/)

  const none = buildArtifactPrompt(new Set())
  assert.match(none, /未匹配到专用的 PowerPoint \/ Word \/ Excel \/ PDF/)
  assert.doesNotMatch(none, /User-directed presentation policy/)
  assert.match(none, /没有明确要求代码片段/)
  assert.match(none, /不要输出完整源码/)

  const snippet = buildArtifactPrompt(new Set(['create_html_app']), { codeSnippetRequested: true })
  assert.match(snippet, /明确要求了代码片段/)
  assert.match(snippet, /代码片段不能代替真实工具执行与文件交付/)
  assert.doesNotMatch(snippet, /不要输出完整源码/)
})

test('PPT job instructions follow user-defined design and real file delivery without fixed slide quotas', () => {
  const prompt = buildArtifactPrompt(new Set(['create_pptx']))
  assert.match(prompt, /N total slides/)
  assert.match(prompt, /slides\[\]\.elements/)
  assert.match(prompt, /heading_font_size/)
  assert.match(prompt, /image_index/)
  assert.match(prompt, /do not invent/i)
  assert.doesNotMatch(prompt, /配色、版式、字体由系统控制|标题 ≤ 14 字|bullet ≤ 30 字|单页 bullet ≤ 4 条|至少含 1 个|theme 字段按主题选/)
})

test('citation prompt guides the model to emit clickable links', () => {
  const citation = buildCitationPrompt()
  assert.match(citation, /Markdown 链接/)
  assert.match(citation, /相对工作区路径/)
  assert.match(citation, /完整 URL/)
})

test('code workflow and delayed followup prompts are non-empty and stable', () => {
  assert.match(buildCodeWorkflowPrompt(), /代码工作流/)
  assert.match(buildCodeWorkflowPrompt(), /apply_patch/)
  assert.match(buildDelayedFollowupPrompt(), /sleep_until/)
})
