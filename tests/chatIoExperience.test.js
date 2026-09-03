import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { readSourceTree } from './sourceTree.js'

const composerSource = readSourceTree('../src/pages/ChatSplit/chatComposer/') + fs.readFileSync(new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url), 'utf8')
const messagesSource = readSourceTree('../src/pages/ChatSplit/chatMessages/') + fs.readFileSync(new URL('../src/pages/ChatSplit/ChatMessages.jsx', import.meta.url), 'utf8')
const chatSource = readSourceTree('../src/pages/ChatSplit/')
const chatSendActionsSource = fs.readFileSync(new URL('../src/pages/ChatSplit/chatSendActions.js', import.meta.url), 'utf8')
const chatTurnRecoverySource = fs.readFileSync(new URL('../src/pages/ChatSplit/useChatTurnRecovery.js', import.meta.url), 'utf8')
const composerActionsSource = fs.readFileSync(new URL('../src/pages/ChatSplit/chatComposer/ComposerActions.jsx', import.meta.url), 'utf8')
const lifecycleSource = fs.readFileSync(new URL('../src/pages/ChatSplit/useChatSessionLifecycle.js', import.meta.url), 'utf8')
const messageListSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatMessages.jsx', import.meta.url), 'utf8')
const messageRowSource = fs.readFileSync(new URL('../src/pages/ChatSplit/chatMessages/MessageRow.jsx', import.meta.url), 'utf8')
  + readSourceTree('../src/pages/ChatSplit/chatMessages/messageRow/')
const serverTurnSource = fs.readFileSync(new URL('../src/pages/ChatSplit/serverTurnFlow.js', import.meta.url), 'utf8')
const activityTracesSource = fs.readFileSync(new URL('../src/pages/ChatSplit/chatMessages/ActivityTraces.jsx', import.meta.url), 'utf8')
const activityStreamSource = fs.readFileSync(new URL('../src/pages/ChatSplit/chatMessages/ActivityStream.jsx', import.meta.url), 'utf8')
const chatViewSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatSplitView.jsx', import.meta.url), 'utf8')
const markdownSource = fs.readFileSync(new URL('../src/components/MarkdownRenderer.jsx', import.meta.url), 'utf8')
  + readSourceTree('../src/components/markdown/')
const toolCardSource = fs.readFileSync(new URL('../src/components/ToolCallCard.jsx', import.meta.url), 'utf8')
const stylesSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
const runtimeCompletionSource = fs.readFileSync(new URL('../server/services/loop/runtime-initializeCompletion.js', import.meta.url), 'utf8')
const incompleteTerminalPresentationSource = fs.readFileSync(new URL('../server/services/loop/incompleteTerminalPresentation.js', import.meta.url), 'utf8')

test('chat composer accepts pasted files and shows managed upload state', () => {
  assert.match(composerSource, /onPaste=/)
  assert.match(composerSource, /getClipboardFiles/)
  assert.match(composerSource, /item\.uploadStatus === 'uploading'/)
  assert.match(composerSource, /item\.uploadStatus === 'error'/)
})

test('chat drafts persist while user edit, failure resend, and copy actions stay real', () => {
  assert.match(lifecycleSource, /SET_SESSION_DRAFT[\s\S]{0,180}text: input/)
  assert.match(lifecycleSource, /attachments: normalizeDraftAttachments\(attachmentsRef\.current\)/)
  assert.match(lifecycleSource, /const nextDraft = readSessionDraft\(\(state\.sessionDrafts \|\| \{\}\)\[nextId\]\)/)
  assert.match(lifecycleSource, /if \(!preserveAttachments\) setAttachments\(nextDraft\.attachments\)/)
  assert.match(
    chatSendActionsSource,
    /await triggerSendFlow\([\s\S]{0,120}typedContent \|\| describeAttachmentPrompt\(currentAttachments, lang\),[\s\S]{0,80}currentAttachments,[\s\S]{0,120}\(\{ sessionId: acceptedSessionId \}/,
  )
  assert.match(chatSource, /handleEditMessage/)
  assert.doesNotMatch(chatSource, /handleRegenerateMessage|canRegenerateAssistantMessage|onRegenerateMessage/)
  assert.match(
    chatSendActionsSource,
    /if \(replayDraft\)[\s\S]*?type: 'TRUNCATE_MESSAGES'[\s\S]*?payload: replayDraft\.historyLimit/,
  )
  assert.doesNotMatch(chatSource, /handleDeleteMessage/)
  assert.match(messageRowSource, /<CopyButton content=\{msg\.content\}/)
  assert.match(messageRowSource, /copyTextToClipboard\(copyableMessageText\(content\)\)/)
  assert.match(messageRowSource, /chatMessages\.copied/)
  assert.match(messagesSource, /onEditMessage/)
  assert.doesNotMatch(messagesSource, /onDeleteMessage|<Trash2/)
  assert.match(messageRowSource, /isModelPreExecutionFailure\(msg\) \? onRetryModelFailure : null/)
  assert.match(messageRowSource, /data-testid="retry-model-request"/)
  assert.doesNotMatch(messageRowSource, /data-testid="edit-assistant-prompt"/)
  assert.doesNotMatch(messageRowSource, /data-testid="regenerate-assistant-message"/)
  assert.match(messageRowSource, /data-testid="edit-user-message"/)
  assert.doesNotMatch(messageRowSource, /onDeleteMessage/)
})

test('fresh sessions use a deterministic local title without a competing model request', () => {
  assert.match(chatSource, /UPDATE_SESSION_TITLE_FOR/)
  assert.doesNotMatch(chatSource, /summarizeSessionTitle/)
})

test('leaving chat detaches the view without cancelling the active server turn', () => {
  assert.doesNotMatch(lifecycleSource, /abortCtrlRef\.current\?\.abort\(\)/)
  assert.match(lifecycleSource, /getTurnRun\(state\.activeSessionId\)/)
  assert.match(lifecycleSource, /subscribeTurnRuns\(syncActiveTurn\)/)
  assert.match(chatTurnRecoverySource, /cancelTurnRun\(activeSessionId\)/)
  assert.match(chatTurnRecoverySource, /if \(!cancelTurnRun\(activeSessionId\)\) abortCtrlRef\.current\?\.abort\(\)/)
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
  assert.match(messageRowSource, /<MarkdownRenderer[\s\S]*?streaming=\{isCurrentStreamingMessage\}/)
  assert.match(markdownSource, /function CodeBlock\(\{ children, streaming = false \}\)/)
  assert.match(markdownSource, /!streaming && \(/)
  assert.match(messageRowSource, /const isMessageComplete = !isCurrentStreamingMessage/)
  assert.match(messageRowSource, /const isSuspendedTurn = msg\.meta\?\.interrupted === true \|\| msg\.meta\?\.paused === true/)
  assert.match(messageRowSource, /const canPresentManagedDeliverables = isMessageComplete[\s\S]*?msg\.meta\?\.failed !== true[\s\S]*?!isSuspendedTurn/)
  assert.match(messageRowSource, /const canPresentLocalFiles = isMessageComplete[\s\S]*?\|\| isSuspendedTurn[\s\S]*?\|\| msg\.meta\?\.failed === true/)
  assert.match(messageRowSource, /const canPresentDeliverables = canPresentManagedDeliverables \|\| canPresentLocalFiles/)
  assert.match(messageRowSource, /const showArtifactPreview = !!artifactPreview && canPresentManagedDeliverables/)
  assert.match(chatViewSource, /isGenerating=\{isGenerating\}/)
})

test('local mutation receipts stay visible when managed-artifact acceptance fails', () => {
  assert.doesNotMatch(runtimeCompletionSource, /未通过验证的中间文件不会交付/)
  assert.doesNotMatch(runtimeCompletionSource, /文件工具连续纠错|所需文件尚未通过完整性验证/)
  assert.match(runtimeCompletionSource, /ARTIFACT_DELIVERY_INCOMPLETE_REASON/)
  assert.match(incompleteTerminalPresentationSource, /已提交到本地的文件仍会保留并显示其验证状态/)
  assert.match(incompleteTerminalPresentationSource, /未通过验证的受管理产物不会作为最终交付/)
  assert.match(incompleteTerminalPresentationSource, /Files written locally are preserved with their verification status/)
  assert.match(incompleteTerminalPresentationSource, /unverified managed artifacts are not delivered as final output/)
  assert.match(messageRowSource, /const canPresentLocalFiles = isMessageComplete[\s\S]*?\|\| isSuspendedTurn[\s\S]*?\|\| msg\.meta\?\.failed === true/)
})

test('composer sends steering drafts while preserving an independent stop action', () => {
  assert.match(composerActionsSource, /<ModelPicker/)
  assert.match(composerActionsSource, /data-testid="context-ring"/)
  assert.match(composerSource, /hasDraftText=\{Boolean\(String\(input \|\| ''\)\.trim\(\)\)\}/)
  assert.match(composerActionsSource, /const primaryActionStopsTurn = isGenerating && !hasDraftText/)
  assert.match(composerActionsSource, /data-testid="composer-stop-action"[\s\S]*?onClick=\{onAbort\}/)
  assert.match(composerActionsSource, /onClick=\{primaryActionStopsTurn \? onAbort : onSend\}/)
  assert.match(composerActionsSource, /disabled=\{!isGenerating && sendDisabled\}/)
  assert.match(composerActionsSource, /\{primaryActionStopsTurn[\s\S]*?<Square[\s\S]*?<Send/)
  assert.doesNotMatch(composerActionsSource, /chatComposer\.steer|<Pause/)
  assert.doesNotMatch(composerSource, />Enter<\/span>/)
})

test('transient tool readiness is visible in the streaming assistant without creating a tool trace', () => {
  assert.match(activityStreamSource, /activity\?\.kind === 'tool_call_ready'/)
  assert.match(activityStreamSource, /chatMessages\.toolCallReady/)
  assert.match(activityStreamSource, /chatMessages\.toolUnknown/)
  assert.match(activityStreamSource, /testId="model-activity"/)
})

test('tool failures expose status, retryability, attempts, and recovery hints', () => {
  assert.match(toolCardSource, /call\.errorCode/)
  assert.match(toolCardSource, /call\.errorStatus/)
  assert.match(toolCardSource, /call\.retryable/)
  assert.match(toolCardSource, /call\.attempts/)
  assert.match(toolCardSource, /call\.errorHint/)
})

test('selected slash skill renders as a quiet inline tag inside the composer', () => {
  assert.match(composerSource, /function splitLeadingSkillCommand/)
  assert.match(composerSource, /data-testid="active-skill-command"/)
  assert.match(composerSource, /bg-ink\/5[\s\S]{0,120}text-ink-soft/)
  assert.match(composerSource, /value=\{skillCommand\.command \? skillCommand\.body : input\}/)
  assert.match(chatSource, /runtimeSkillIds=\{runtimeSkills\.filter\(\(skill\) => skill\.runnable !== false\)\.map\(\(skill\) => skill\.id\)\}/)
  assert.match(chatViewSource, /skillIds=\{runtimeSkillIds\}/)
})

test('sent slash skill keeps a quiet inline tag inside the soft user bubble', () => {
  assert.match(messagesSource, /function splitUserSkillCommand/)
  assert.match(messagesSource, /data-testid="sent-skill-command"/)
  assert.match(messagesSource, /chat-user-skill-message/)
  assert.match(stylesSource, /\.chat-user-skill-message\s*\{[\s\S]*?background:\s*rgb\(var\(--color-paper-2-rgb\)[\s\S]*?box-shadow:\s*none;/)
})

test('long-term memory remains internal instead of adding a disclosure after every answer', () => {
  assert.doesNotMatch(messagesSource, /MemoryUsageDisclosure|getMemoriesByIdsApi|chatMessages\.memoryUsed/)
})

test('mini timeline keeps a narrow inset from the chat surface edge', () => {
  assert.match(stylesSource, /\.chat-mini-timeline\s*\{\s*left:\s*0\.75rem;\s*\}/)
  assert.doesNotMatch(stylesSource, /\.chat-mini-timeline\s*\{[^}]*left:\s*0\.5rem/)
  assert.doesNotMatch(stylesSource, /\.chat-mini-timeline\s*\{[^}]*calc\(50%\s*-\s*28rem\)/)
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

test('user messages stay right-aligned in a soft bubble while metadata remains outside the text flow', () => {
  const bubble = messageRowSource.match(/data-testid="user-message-bubble"[\s\S]*?<\/div>/)?.[0] || ''
  assert.match(bubble, /chat-user-message/)
  assert.doesNotMatch(bubble, /user-message-time|chat-message-actions/)
  assert.match(messageRowSource, /flex max-w-\[min\(620px,72%\)\] flex-col items-end/)
  assert.match(messageRowSource, /mt-1 flex min-h-5[\s\S]{0,180}leading-5[\s\S]{0,80}tabular-nums/)
  assert.match(stylesSource, /\.chat-user-message\s*\{[\s\S]*?border-radius:\s*1\.125rem;[\s\S]*?background:\s*rgb\(var\(--color-paper-2-rgb\)[\s\S]*?padding:\s*0\.62rem 0\.9rem;[\s\S]*?box-shadow:\s*none;/)
})

test('tool activity is an inline label while command arguments and logs default collapsed', () => {
  assert.match(toolCardSource, /toolCallLabel\(call\.name, t\)/)
  assert.match(toolCardSource, /chat-tool-label[^>]*>\{label\}/)
  assert.match(toolCardSource, /chat-tool-raw-name[^>]*>\{call\.name \|\| label\}/)
  assert.match(toolCardSource, /const isExpanded = expanded === true/)
  assert.doesNotMatch(activityTracesSource, /shouldAutoExpandToolCall|defaultExpandedCallKey/)
  assert.match(stylesSource, /\.chat-tool-action\s*\{[\s\S]*?display:\s*inline-flex;/)
})

test('composer stays compact, softly framed, and keeps a circular primary action', () => {
  assert.match(composerSource, /data-testid="chat-composer-surface"/)
  assert.match(composerSource, /chat-composer-surface[\s\S]{0,120}min-h-\[108px\][\s\S]{0,120}rounded-\[22px\] border/)
  assert.doesNotMatch(composerSource, /focus-within:-translate-y-px|focus-within:border-blue/)
  assert.match(stylesSource, /\.chat-composer-surface\s*\{[\s\S]*?box-shadow:[\s\S]*?0 12px 32px/)
  assert.match(stylesSource, /\.chat-composer-surface:focus-within\s*\{[\s\S]*?box-shadow:[\s\S]*?0 14px 38px/)
  assert.match(stylesSource, /\.chat-composer-project-strip\s*\{[\s\S]*?width:\s*fit-content;[\s\S]*?margin-bottom:\s*0\.5rem/)
  assert.match(composerActionsSource, /h-8 w-8[\s\S]{0,80}rounded-full/)
})

test('reasoning stays a compact live status while tool traces remain inspectable', () => {
  const reasoningTrace = activityTracesSource.match(/function ReasoningTrace[\s\S]*?(?=\nexport function ToolCallTrace)/)?.[0] || ''
  const toolCallTrace = activityTracesSource.match(/function ToolCallTrace[\s\S]*$/)?.[0] || ''

  assert.match(reasoningTrace, /if \(!streaming && !completed\) return null/)
  assert.match(reasoningTrace, /reasoningCompleted/)
  assert.match(reasoningTrace, /role=\{streaming \? 'status' : undefined\}/)
  assert.doesNotMatch(reasoningTrace, /<pre/)
  assert.match(toolCallTrace, /const normalizedCalls = Array\.isArray\(calls\) \? calls : \[\]/)
  assert.match(toolCallTrace, /useState\(false\)/)
  assert.match(toolCallTrace, /chat-tool-list/)
  assert.match(toolCallTrace, /chat-timeline-history/)
  assert.match(toolCallTrace, /aria-expanded=\{showAll\}/)
  assert.doesNotMatch(toolCallTrace, /chatMessages\.clickExpand/)
  assert.doesNotMatch(toolCallTrace, /chatMessages\.execution/)
})

test('one assistant turn preserves narration and tool batches in their recorded order', () => {
  assert.match(messageRowSource, /buildMessageTimeline\(content, toolCalls\)/)
  assert.match(messageRowSource, /assistantTimelinePresentation\(timeline\)/)
  assert.match(messageRowSource, /segments\.map\(\(segment, index\)/)
  assert.match(messageRowSource, /segment\.kind === 'tools'/)
  assert.match(messageRowSource, /<ToolCallTrace[\s\S]*?calls=\{segment\.calls\}/)
  assert.match(messageRowSource, /\{segment\.text\}/)
  assert.match(messageRowSource, /<ExecutionDisclosure[\s\S]*?\(isCurrentStreamingMessage \|\| hasReasoningSummary\) && <ActivityStream/)
  assert.doesNotMatch(messageRowSource, /execution-running|execution-complete/)
  assert.match(messageRowSource, /useState\(running\)/)
  assert.match(messageRowSource, /if \(running && !wasRunning\.current\) setExpanded\(true\)/)
  assert.match(messageRowSource, /chatMessages\.executionToolCount/)
  assert.doesNotMatch(messageRowSource, /compactMessagePresentation|timeline\.flatMap|\.reverse\(\)/)
})

test('reasoning does not expose raw text or character counts', () => {
  const reasoningTrace = activityTracesSource.match(/function ReasoningTrace[\s\S]*?(?=\nexport function ToolCallTrace)/)?.[0] || ''
  assert.doesNotMatch(reasoningTrace, /text\.length/)
  assert.doesNotMatch(reasoningTrace, /chatMessages\.characters/)
  assert.doesNotMatch(reasoningTrace, /\{text\}/)
})

test('completed artifact rows do not revert to streaming source when a later message generates', () => {
  assert.match(messageRowSource, /const isCurrentStreamingMessage = msg\.meta\?\.streaming === true/)
  assert.match(messageRowSource, /msg\.meta\?\.streaming == null && msg\.id === generatingMessageId/)
  assert.match(messageRowSource, /const isMessageComplete = !isCurrentStreamingMessage/)
  assert.match(messageRowSource, /function CollapsedArtifactContent/)
  assert.match(messageRowSource, /artifact-completion-summary/)
  assert.doesNotMatch(messageRowSource, /Server turn completed/)
  assert.match(messageRowSource, /<ArtifactReferenceLinks[\s\S]*?msg=\{msg\}/)
})

test('model setup failures use one durable in-message card without a duplicate toast', () => {
  assert.doesNotMatch(serverTurnSource, /toast\.error/)
  assert.match(messageRowSource, /const modelSetupFailure = msg\.meta\?\.failed === true && isModelSetupFailure\(msg\)/)
  assert.match(messageRowSource, /modelSetupFailure \? \([\s\S]{0,100}<ModelSetupFailureCard/)
  assert.match(messageRowSource, /testId="model-setup-error-card"/)
  assert.match(messageRowSource, /onClick=\{onManageModels\}/)
})
