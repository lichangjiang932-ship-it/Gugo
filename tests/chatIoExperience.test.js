import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const composerSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url), 'utf8')
const messagesSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatMessages.jsx', import.meta.url), 'utf8')
const chatSource = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
const markdownSource = fs.readFileSync(new URL('../src/components/MarkdownRenderer.jsx', import.meta.url), 'utf8')
const toolCardSource = fs.readFileSync(new URL('../src/components/ToolCallCard.jsx', import.meta.url), 'utf8')
const stylesSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

test('chat composer accepts pasted images and shows attachment errors', () => {
  assert.match(composerSource, /onPaste=/)
  assert.match(composerSource, /getClipboardImageFiles/)
  assert.match(composerSource, /\{item\.error\}/)
})

test('chat drafts persist while typing and message actions stay copy-only', () => {
  assert.match(chatSource, /SET_SESSION_DRAFT[\s\S]{0,180}text: input/)
  assert.match(chatSource, /triggerSendFlow\(content, currentAttachments\)/)
  assert.doesNotMatch(chatSource, /handleEditMessage|editingMessageId|handleRegenerate|handleDeleteMessage/)
  assert.match(messagesSource, /navigator\.clipboard\?\.writeText\(msg\.content\)/)
  assert.doesNotMatch(messagesSource, /onEditMessage|onRegenerateMessage|onDeleteMessage|<RefreshCw|<Trash2/)
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
  assert.match(messagesSource, /chat-message-actions/)
  assert.match(messagesSource, /<MarkdownRenderer[^>]*streaming=\{isGenerating \|\| !!msg\.meta\?\.streaming\}/)
  assert.match(markdownSource, /function CodeBlock\(\{ children, streaming = false \}\)/)
  assert.match(markdownSource, /!streaming && \(/)
  assert.match(messagesSource, /const isMessageComplete = !isGenerating && !msg\.meta\?\.streaming/)
  assert.match(messagesSource, /const showArtifactPreview = !!artifactPreview && isMessageComplete/)
  assert.match(chatSource, /isGenerating=\{isGenerating\}/)
})

test('composer groups model and voice beside send without an Enter label', () => {
  const controls = composerSource.match(/<div className="flex min-w-0 items-center gap-1\.5">[\s\S]*?\{isGenerating \? \(/)?.[0] || ''
  assert.match(controls, /<ModelPicker/)
  assert.match(controls, /<Mic/)
  assert.doesNotMatch(composerSource, />Enter<\/span>/)
})

test('selected slash skill renders as a dark tag inside the composer', () => {
  assert.match(composerSource, /function splitLeadingSkillCommand/)
  assert.match(composerSource, /data-testid="active-skill-command"/)
  assert.match(composerSource, /bg-ink[\s\S]{0,120}text-paper/)
  assert.match(composerSource, /value=\{skillCommand\.command \? skillCommand\.body : input\}/)
  assert.match(chatSource, /skillIds=\{runtimeSkills\.map\(\(skill\) => skill\.id\)\}/)
})

test('long-term memory remains internal instead of adding a disclosure after every answer', () => {
  assert.doesNotMatch(messagesSource, /MemoryUsageDisclosure|getMemoriesByIdsApi|chatMessages\.memoryUsed/)
})

test('message time, model, and latency reveal with copy actions on hover or focus', () => {
  const userTime = messagesSource.match(/data-testid="user-message-time"[\s\S]*?<\/span>/)?.[0] || ''
  const assistantMeta = messagesSource.match(/data-testid="assistant-message-meta"[\s\S]*?<\/div>/)?.[0] || ''

  for (const revealable of [userTime, assistantMeta]) {
    assert.match(revealable, /chat-message-meta/)
    assert.match(revealable, /opacity-0 pointer-events-none/)
    assert.match(revealable, /group-hover\/message:opacity-100/)
    assert.match(revealable, /group-focus-within\/message:opacity-100/)
  }

  assert.match(userTime, /formatMessageTime\(msg\.timestamp, lang\)/)
  assert.match(assistantMeta, /formatMessageTime\(msg\.timestamp, lang\)/)
  assert.match(assistantMeta, /chatMessages\.model/)
  assert.match(assistantMeta, /chatMessages\.latency/)
  assert.doesNotMatch(assistantMeta, /chatMessages\.credits/)
  assert.match(stylesSource, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.chat-message-actions,\s*\.chat-message-meta\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/)
})

test('user message time and copy actions sit outside the compact bubble', () => {
  const bubble = messagesSource.match(/data-testid="user-message-bubble"[\s\S]*?<\/div>/)?.[0] || ''
  assert.match(bubble, /chat-user-message/)
  assert.match(bubble, /px-3\.5 py-2/)
  assert.doesNotMatch(bubble, /user-message-time|chat-message-actions/)
  assert.match(messagesSource, /max-w-\[min\(720px,86%\)\] flex flex-col items-end/)
  assert.match(messagesSource, /mt-1 flex h-4[\s\S]{0,120}leading-none/)
})

test('reasoning and tool traces remain collapsed until the user expands them', () => {
  const reasoningTrace = messagesSource.match(/function ReasoningTrace[\s\S]*?(?=\nfunction ToolCallTrace)/)?.[0] || ''
  const toolCallTrace = messagesSource.match(/function ToolCallTrace[\s\S]*?(?=\nexport default)/)?.[0] || ''

  assert.match(reasoningTrace, /const expanded = manual === true/)
  assert.match(toolCallTrace, /const expanded = open/)
  assert.doesNotMatch(reasoningTrace, /chatMessages\.clickExpand/)
  assert.doesNotMatch(toolCallTrace, /chatMessages\.clickExpand/)
})
