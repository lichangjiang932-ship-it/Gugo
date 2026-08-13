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
  assert.match(withPpt, /高级 PPT 必守规则/)
  assert.doesNotMatch(withPpt, /create_docx \(Word\)/)

  const none = buildArtifactPrompt(new Set())
  assert.match(none, /未匹配到专用的 PowerPoint/)
  assert.doesNotMatch(none, /高级 PPT 必守规则/)
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
