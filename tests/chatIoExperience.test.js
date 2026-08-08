import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { readSourceTree } from './sourceTree.js'

const composerSource = readSourceTree('../src/pages/ChatSplit/chatComposer/') + fs.readFileSync(new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url), 'utf8')
const messagesSource = readSourceTree('../src/pages/ChatSplit/chatMessages/') + fs.readFileSync(new URL('../src/pages/ChatSplit/ChatMessages.jsx', import.meta.url), 'utf8')
const chatSource = readSourceTree('../src/pages/ChatSplit/')
const chatEntrySource = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
const lifecycleSource = fs.readFileSync(new URL('../src/pages/ChatSplit/useChatSessionLifecycle.js', import.meta.url), 'utf8')
const messageListSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatMessages.jsx', import.meta.url), 'utf8')
const messageRowSource = fs.readFileSync(new URL('../src/pages/ChatSplit/chatMessages/MessageRow.jsx', import.meta.url), 'utf8')
const activityTracesSource = fs.readFileSync(new URL('../src/pages/ChatSplit/chatMessages/ActivityTraces.jsx', import.meta.url), 'utf8')
const chatViewSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatSplitView.jsx', import.meta.url), 'utf8')
const markdownSource = fs.readFileSync(new URL('../src/components/MarkdownRenderer.jsx', import.meta.url), 'utf8')
const toolCardSource = fs.readFileSync(new URL('../src/components/ToolCallCard.jsx', import.meta.url), 'utf8')
const stylesSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

test('chat composer accepts pasted images and shows attachment errors', () => {
  assert.match(composerSource, /onPaste=/)
  assert.match(composerSource, /getClipboardImageFiles/)
  assert.match(composerSource, /\{item\.error\}/)
})

test('chat drafts persist while typing and message actions stay copy-only', () => {
  assert.match(lifecycleSource, /SET_SESSION_DRAFT[\s\S]{0,180}text: input/)
  assert.match(chatEntrySource, /triggerSendFlow\(typedContent \|\| describeAttachmentPrompt\(currentAttachments\), currentAttachments\)/)
  assert.doesNotMatch(chatSource, /handleEditMessage|editingMessageId|handleRegenerate|handleDeleteMessage/)
  assert.match(messageRowSource, /<CopyButton content=\{msg\.content\}/)
  assert.match(messageRowSource, /copyTextToClipboard\(content\)/)
  assert.match(messageRowSource, /chatMessages\.copied/)
  assert.doesNotMatch(messagesSource, /onEditMessage|onRegenerateMessage|onDeleteMessage|<RefreshCw|<Trash2/)
})

test('fresh sessions use a deterministic local title without a competing model request', () => {
  assert.match(chatSource, /UPDATE_SESSION_TITLE_FOR/)
  assert.doesNotMatch(chatSource, /summarizeSessionTitle/)
})

test('leaving chat detaches the view without cancelling the active server turn', () => {
  assert.doesNotMatch(lifecycleSource, /abortCtrlRef\.current\?\.abort\(\)/)
  assert.match(lifecycleSource, /getTurnRun\(state\.activeSessionId\)/)
  assert.match(lifecycleSource, /subscribeTurnRuns\(syncActiveTurn\)/)
  assert.match(chatEntrySource, /cancelTurnRun\(activeSessionId\)/)
})

test('streaming no longer reparses stable markdown or delays messages by history index', () => {
  assert.doesNotMatch(messagesSource, /delay:\s*i\s*\*/)
  assert.match(markdownSource, /export default memo\(MarkdownRenderer\)/)
  assert.match(toolCardSource, /export default memo\(ToolCallCard\)/)
})

test('only the streaming assistant hides copy actions while completed messages remain copyable', () => {
  assert.match(messageListSource, /isGenerating = false/)
  assert.match(messageListSource, /const generatingMessageId = isGenerating/)
  assert.match(messageRowSource, /<AssistantMeta[\s\S]*?isCurrentStreamingMessage=\{isCurrentStreamingMessage\}/)
  assert.match(messageRowSource, /function AssistantMeta[\s\S]*?!isCurrentStreamingMessage &&/)
  assert.match(messageRowSource, /function UserMeta[\s\S]*?!msg\.meta\?\.streaming &&/)
  assert.doesNotMatch(messageRowSource, /function (?:UserMeta|AssistantMeta)\([^)]*isGenerating/)
  assert.match(messageRowSource, /chat-message-actions/)
  assert.match(messageRowSource, /<MarkdownRenderer[^>]*streaming=\{isCurrentStreamingMessage\}/)
  assert.match(markdownSource, /function CodeBlock\(\{ children, streaming = false \}\)/)
  assert.match(markdownSource, /!streaming && \(/)
  assert.match(messageRowSource, /const isMessageComplete = !isCurrentStreamingMessage/)
  assert.match(messageRowSource, /const showArtifactPreview = !!artifactPreview && isMessageComplete/)
  assert.match(chatViewSource, /isGenerating=\{isGenerating\}/)
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
  assert.match(chatSource, /runtimeSkillIds=\{runtimeSkills\.filter\(\(skill\) => skill\.runnable !== false\)\.map\(\(skill\) => skill\.id\)\}/)
  assert.match(chatViewSource, /skillIds=\{runtimeSkillIds\}/)
})

test('sent slash skill keeps its tag and depth in the user message', () => {
  assert.match(messagesSource, /function splitUserSkillCommand/)
  assert.match(messagesSource, /data-testid="sent-skill-command"/)
  assert.match(messagesSource, /chat-user-skill-message/)
  assert.match(stylesSource, /\.chat-user-skill-message[\s\S]*?box-shadow:/)
})

test('long-term memory remains internal instead of adding a disclosure after every answer', () => {
  assert.doesNotMatch(messagesSource, /MemoryUsageDisclosure|getMemoriesByIdsApi|chatMessages\.memoryUsed/)
})

test('message time, model, and latency reveal with copy actions on hover or focus', () => {
  const userTime = messageRowSource.match(/data-testid="user-message-time"[\s\S]*?<\/span>/)?.[0] || ''
  const assistantMeta = messageRowSource.match(/data-testid="assistant-message-meta"[\s\S]*?<\/div>/)?.[0] || ''

  for (const revealable of [userTime, assistantMeta]) {
    assert.match(revealable, /chat-message-meta/)
    assert.match(revealable, /opacity-0/)
    assert.match(revealable, /pointer-events-none/)
    assert.match(revealable, /group-hover\/message:opacity-100/)
    assert.match(revealable, /group-focus-within\/message:opacity-100/)
  }

  assert.match(userTime, /formatMessageTime\(msg\.timestamp, lang\)/)
  assert.match(assistantMeta, /formatMessageTime\(msg\.timestamp, lang\)/)
  assert.match(assistantMeta, /chatMessages\.model/)
  assert.match(assistantMeta, /chatMessages\.latency/)
  assert.doesNotMatch(assistantMeta, /creditsCharged|creditsBalance|billingError/)
  assert.match(stylesSource, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.chat-message-actions,\s*\.chat-message-meta\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/)
})

test('user message time and copy actions sit outside the compact bubble', () => {
  const bubble = messageRowSource.match(/data-testid="user-message-bubble"[\s\S]*?<\/div>/)?.[0] || ''
  assert.match(bubble, /chat-user-message/)
  assert.match(bubble, /px-3\.5 py-2/)
  assert.doesNotMatch(bubble, /user-message-time|chat-message-actions/)
  assert.match(messageRowSource, /flex max-w-\[min\(720px,86%\)\] flex-col items-end/)
  assert.match(messageRowSource, /mt-1 flex h-4[\s\S]{0,160}leading-none/)
})

test('reasoning stays collapsed while running tool traces open as a compact timeline', () => {
  const reasoningTrace = activityTracesSource.match(/function ReasoningTrace[\s\S]*?(?=\nexport function ToolCallTrace)/)?.[0] || ''
  const toolCallTrace = activityTracesSource.match(/function ToolCallTrace[\s\S]*$/)?.[0] || ''

  assert.match(reasoningTrace, /useState\(false\)/)
  assert.match(toolCallTrace, /useState\(\(\) => calls\.some/)
  assert.match(toolCallTrace, /chat-tool-list/)
  assert.match(reasoningTrace, /aria-expanded=\{expanded\}/)
  assert.match(toolCallTrace, /aria-expanded=\{expanded\}/)
  assert.doesNotMatch(reasoningTrace, /chatMessages\.clickExpand/)
  assert.doesNotMatch(toolCallTrace, /chatMessages\.clickExpand/)
})

test('reasoning character count stays quiet until hover or keyboard focus', () => {
  const reasoningTrace = activityTracesSource.match(/function ReasoningTrace[\s\S]*?(?=\nexport function ToolCallTrace)/)?.[0] || ''
  assert.match(reasoningTrace, /aria-label=/)
  assert.match(reasoningTrace, /opacity-0/)
  assert.match(reasoningTrace, /group-hover\/reasoning:opacity-100/)
  assert.match(reasoningTrace, /group-focus-visible\/reasoning:opacity-100/)
})

test('completed artifact rows do not revert to streaming source when a later message generates', () => {
  assert.match(messageRowSource, /const isCurrentStreamingMessage = msg\.id === generatingMessageId \|\| !!msg\.meta\?\.streaming/)
  assert.match(messageRowSource, /const isMessageComplete = !isCurrentStreamingMessage/)
  assert.match(messageRowSource, /function CollapsedArtifactContent/)
  assert.match(messageRowSource, /chat\.serverTurn\.completed/)
  assert.match(messageRowSource, /<ArtifactReferenceLinks msg=\{msg\}/)
})
