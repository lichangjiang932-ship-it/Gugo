import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const composerSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url), 'utf8')
const messagesSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatMessages.jsx', import.meta.url), 'utf8')
const chatSource = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
const markdownSource = fs.readFileSync(new URL('../src/components/MarkdownRenderer.jsx', import.meta.url), 'utf8')
const toolCardSource = fs.readFileSync(new URL('../src/components/ToolCallCard.jsx', import.meta.url), 'utf8')

test('chat composer accepts pasted images and shows attachment errors', () => {
  assert.match(composerSource, /onPaste=/)
  assert.match(composerSource, /getClipboardImageFiles/)
  assert.match(composerSource, /\{item\.error\}/)
})

test('chat drafts persist while typing and editing stays non-destructive until send', () => {
  assert.match(chatSource, /SET_SESSION_DRAFT[\s\S]{0,180}text: input/)
  const editHandler = chatSource.match(/const handleEditMessage[\s\S]*?\}, \[isGenerating, messages\]\)/)?.[0] || ''
  assert.match(editHandler, /if \(isGenerating\) return/)
  assert.match(editHandler, /setEditingMessageId\(msgId\)/)
  assert.doesNotMatch(editHandler, /TRUNCATE_MESSAGES/)
  assert.match(chatSource, /triggerSendFlow\(content, currentAttachments, editIndex/)
})

test('streaming no longer reparses stable markdown or delays messages by history index', () => {
  assert.doesNotMatch(messagesSource, /delay:\s*i\s*\*/)
  assert.match(markdownSource, /export default memo\(MarkdownRenderer\)/)
  assert.match(toolCardSource, /export default memo\(ToolCallCard\)/)
})

test('streaming assistant hides result actions until generation finishes', () => {
  assert.match(messagesSource, /isGenerating = false/)
  assert.match(messagesSource, /const generatingMessageId = isGenerating/)
  assert.match(messagesSource, /!isGenerating && msg\.id !== generatingMessageId &&/)
  assert.match(messagesSource, /!msg\.meta\?\.streaming/)
  assert.match(messagesSource, /msg\.role === 'user'[\s\S]{0,1800}!isGenerating && !msg\.meta\?\.streaming/)
  const regenerateHandler = chatSource.match(/const handleRegenerate[\s\S]*?\}, \[dispatch, isGenerating, state\.activeSessionId, state\.sessions, triggerSendFlow\]\)/)?.[0] || ''
  assert.match(regenerateHandler, /if \(isGenerating\) return/)
  assert.match(messagesSource, /chat-message-actions/)
  assert.match(messagesSource, /<MarkdownRenderer[^>]*streaming=\{isGenerating \|\| !!msg\.meta\?\.streaming\}/)
  assert.match(markdownSource, /function CodeBlock\(\{ children, streaming = false \}\)/)
  assert.match(markdownSource, /!streaming && \(/)
  assert.match(messagesSource, /const isMessageComplete = !isGenerating && !msg\.meta\?\.streaming/)
  assert.match(messagesSource, /const showArtifactPreview = !!artifactPreview && isMessageComplete/)
  assert.match(chatSource, /isGenerating=\{isGenerating\}/)
})

test('reasoning and tool traces remain collapsed until the user expands them', () => {
  const reasoningTrace = messagesSource.match(/function ReasoningTrace[\s\S]*?(?=\nfunction ToolCallTrace)/)?.[0] || ''
  const toolCallTrace = messagesSource.match(/function ToolCallTrace[\s\S]*?(?=\nexport default)/)?.[0] || ''

  assert.match(reasoningTrace, /const expanded = manual === true/)
  assert.match(toolCallTrace, /const expanded = open/)
})
