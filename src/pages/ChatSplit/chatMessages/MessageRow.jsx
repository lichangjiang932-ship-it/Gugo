import { motion } from 'framer-motion'
import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Copy, FileText } from 'lucide-react'
import MarkdownRenderer from '../../../components/MarkdownRenderer.jsx'
import CompactionPill from '../../../components/CompactionPill.jsx'
import ChoicePicker from '../../../components/ChoicePicker.jsx'
import { hasChoices, stripChoices } from '../../../lib/choices.js'
import { buildMessageTimeline } from '../../../lib/messageTimeline.js'
import { shouldCollapseArtifactPreview } from '../../../lib/artifactPreview.js'
import { artifactHasInlineReference, artifactReferenceOpenPayload, buildMessageArtifactPreview, buildServerArtifactReferences, findArtifactReferenceByHref, findArtifactReferenceByLocalPath, resolveDeliveryArtifacts } from '../../../lib/artifactReferences.js'
import { buildVerifiedLocalFileReferences, mergeArtifactReferences, verifiedLocalFileOpenPayload } from '../../../lib/localFileReferences.js'
import { formatMessageDateTime, formatMessageTime } from '../../../lib/messageTime.js'
import { copyTextToClipboard } from '../../../lib/clipboard.js'
import { ArtifactReferenceLinks } from './ArtifactCards.jsx'
import { ToolCallTrace } from './ActivityTraces.jsx'
import ActivityStream from './ActivityStream.jsx'
import { buildCollapsedUserMessagePreview, copyableMessageText, shouldCollapseUserMessage, splitUserSkillCommand } from './messageContent.js'
import DirectoryRequestCard from '../../taskRun/DirectoryRequestCard.jsx'
import { buildAttachmentPreviewArtifact } from '../../../lib/attachmentPreview.js'

function stableTimelineSegments(content, toolCalls) {
  let previousToolKey = 'start'
  let toolStepOffset = 0
  return buildMessageTimeline(content, toolCalls).map((segment, index) => {
    if (segment.kind === 'tools') {
      const firstCall = segment.calls?.[0]
      const stepOffset = toolStepOffset
      toolStepOffset += segment.calls?.length || 0
      previousToolKey = String(firstCall?.id || `offset-${firstCall?.textOffset ?? index}`)
      return { ...segment, key: `tools:${previousToolKey}`, stepOffset }
    }
    return { ...segment, key: `text-after:${previousToolKey}` }
  })
}

export default function MessageRow({
  msg,
  rowKey,
  turnIndex,
  generatingMessageId,
  lang,
  onExpandCompaction,
  onAuthorizeDirectoryRequest,
  onOpenArtifact,
  onOpenInPreview,
  t,
}) {
  const serverClarification = msg.meta?.serverClarification
  const isDirectoryRequest = (serverClarification?.request_type || serverClarification?.requestType) === 'directory'
  const directoryRequestKey = [
    msg.meta?.serverTurnId || '',
    msg.meta?.serverLastSequence ?? '',
    serverClarification?.timestamp ?? '',
    serverClarification?.suggested_path || serverClarification?.suggestedPath || '',
    serverClarification?.access_mode || serverClarification?.accessMode || '',
  ].join(':')
  const resolvedDeliveryArtifacts = resolveDeliveryArtifacts(msg.meta)
  // Only server-confirmed final deliverables may become previewable UI. Legacy
  // artifactSource metadata can still help render a selected file, but it must
  // never create a clickable synthetic file by itself.
  const isCurrentStreamingMessage = msg.meta?.streaming === true
    || (msg.meta?.streaming == null && msg.id === generatingMessageId)
  // A new turn must not make completed artifact messages look "streaming" again.
  // Their collapsed source/link presentation is part of the message itself, not
  // global chat generation state.
  const isMessageComplete = !isCurrentStreamingMessage
  // A failed/interrupted turn may retain internal draft artifacts for durable
  // recovery, but those files are not final deliverables and must never appear
  // as clickable cards. Only a normally completed message may present files.
  const canPresentDeliverables = isMessageComplete
    && msg.meta?.failed !== true
    && msg.meta?.interrupted !== true
  const deliveryArtifacts = canPresentDeliverables ? resolvedDeliveryArtifacts : []
  const artifactPreview = deliveryArtifacts.length > 0 ? buildMessageArtifactPreview(msg) : null
  const showArtifactPreview = !!artifactPreview && canPresentDeliverables
  const serverArtifactReferences = canPresentDeliverables
    ? buildServerArtifactReferences({
        artifacts: deliveryArtifacts,
        content: String(msg.meta?.artifactSource || msg.content || ''),
        messageId: msg.id,
        preview: artifactPreview,
      })
    : []
  const verifiedLocalFileReferences = canPresentDeliverables
    ? buildVerifiedLocalFileReferences({
        toolCalls: msg.meta?.toolCalls,
        verifiedLocalFiles: msg.meta?.verifiedLocalFiles,
        messageId: msg.id,
        turnId: msg.meta?.serverTurnId,
      })
    : []
  const artifactReferences = mergeArtifactReferences({
    serverReferences: serverArtifactReferences,
    verifiedLocalFileReferences,
  })
  const hasInlineArtifactReference = artifactReferences.some((reference) => (
    artifactHasInlineReference(msg.content, reference, artifactReferences)
  ))
  const collapseArtifact = isMessageComplete && showArtifactPreview && !hasInlineArtifactReference && shouldCollapseArtifactPreview(artifactPreview, {
    content: msg.content,
    artifactSource: msg.meta?.artifactSource,
  })
  const userSkillCommand = msg.role === 'user' ? splitUserSkillCommand(msg.content) : null
  const openArtifact = onOpenArtifact || ((artifact) => {
    if (artifact?.preview) onOpenInPreview?.(msg, artifact.preview)
  })

  return (
    <motion.div
      key={rowKey}
      id={msg.id ? `message-${msg.id}` : undefined}
      data-chat-turn-index={msg.role === 'user' ? turnIndex : undefined}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`group/message flex w-full py-1 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
    >
      <div className={collapseArtifact
        ? 'w-full max-w-[840px]'
        : msg.role === 'assistant'
          ? 'chat-assistant-message w-full max-w-[840px] text-[15px] leading-[1.6]'
          : 'flex max-w-[min(720px,86%)] flex-col items-end'}>
        {msg.role === 'assistant' ? (
          collapseArtifact ? (
            <CollapsedArtifactContent
              artifactReferences={artifactReferences}
              artifactPreview={artifactPreview}
              msg={msg}
              onOpenArtifact={openArtifact}
              t={t}
              verifiedLocalFileReferences={verifiedLocalFileReferences}
            />
          ) : (
            <AssistantContent
              artifactPreview={artifactPreview}
              artifactReferences={artifactReferences}
              canPresentDeliverables={canPresentDeliverables}
              isCurrentStreamingMessage={isCurrentStreamingMessage}
              isMessageComplete={isMessageComplete}
              msg={msg}
              onOpenArtifact={openArtifact}
              onOpenInPreview={onOpenInPreview}
              showArtifactPreview={showArtifactPreview}
              t={t}
              verifiedLocalFileReferences={verifiedLocalFileReferences}
            />
          )
        ) : (
          <UserContent
            attachments={msg.attachments}
            command={userSkillCommand}
            content={msg.content}
            onOpenAttachment={(attachment) => {
              const artifact = buildAttachmentPreviewArtifact(attachment, { messageId: msg.id })
              if (artifact) openArtifact(artifact)
            }}
            t={t}
          />
        )}
        {msg.role === 'assistant' && isDirectoryRequest && (
          <InlineDirectoryRequestCard
            key={directoryRequestKey}
            msg={msg}
            onAuthorize={onAuthorizeDirectoryRequest}
            t={t}
          />
        )}
        {msg.role === 'user' && (
          <UserMeta lang={lang} msg={msg} t={t} />
        )}
        {msg.role === 'assistant' && (
          <AssistantMeta
            isCurrentStreamingMessage={isCurrentStreamingMessage}
            lang={lang}
            msg={msg}
            showArtifactPreview={showArtifactPreview}
            t={t}
          />
        )}
        {msg.role === 'assistant' && msg.meta?.failed && msg.meta?.type !== 'model_reply' && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-ember" data-testid="reply-completion-state">
              {t('chatMessages.replyIncomplete')}
            </span>
          </div>
        )}
        {msg.role === 'assistant' && msg.meta?.type === 'context_summary' && (
          <div className="mt-3 border-t border-ink/10 pt-2 text-[11px] text-ink-fade">
            <CompactionPill count={msg.meta.compressedCount || 0} archiveId={msg.meta.archiveId || msg.meta.compactionArchiveId} onExpand={onExpandCompaction} />
          </div>
        )}
      </div>
    </motion.div>
  )
}

function AssistantContent({ artifactPreview, artifactReferences, canPresentDeliverables, isCurrentStreamingMessage, isMessageComplete, msg, onOpenArtifact, showArtifactPreview, t, verifiedLocalFileReferences }) {
  const inlineFileReferences = artifactReferences
  const openInlineArtifact = (href) => {
    // 先按产物 URL 匹配,再按本地路径(含 file:/// 与 D:\ 形式)匹配,
    // 让输出文字里的文件路径能一键打开预览。
    const reference = findArtifactReferenceByHref(inlineFileReferences, href)
      || findArtifactReferenceByLocalPath(inlineFileReferences, href)
    if (!reference) return false
    onOpenArtifact?.(
      verifiedLocalFileOpenPayload(reference)
        || artifactReferenceOpenPayload(reference, msg.id),
    )
    return true
  }
  const openToolArtifact = (reference) => {
    const payload = artifactReferenceOpenPayload(reference, msg.id)
    if (!payload) return false
    onOpenArtifact?.(payload)
    return true
  }
  const timeline = stableTimelineSegments(stripChoices(msg.content), msg.meta?.toolCalls)
  const presentation = assistantTimelinePresentation(timeline)
  const hasExecution = isCurrentStreamingMessage || presentation.execution.length > 0
  return (
    <>
      <div data-quotable="true">
        {(hasExecution || msg.meta?.serverTurnId || msg.meta?.type === 'model_reply') && (
          <ExecutionDisclosure
            key={isCurrentStreamingMessage ? 'execution-running' : 'execution-complete'}
            hasExecution={hasExecution}
            msg={msg}
            running={isCurrentStreamingMessage}
            t={t}
          >
            <TimelineSegments
              artifacts={inlineFileReferences}
              onLinkClick={openInlineArtifact}
              onOpenArtifact={openToolArtifact}
              segments={presentation.execution}
              streaming={isCurrentStreamingMessage}
            />
            {isCurrentStreamingMessage && <ActivityStream msg={msg} />}
          </ExecutionDisclosure>
        )}
        {presentation.answer && (
          <MarkdownRenderer
            artifactReferences={inlineFileReferences}
            streaming={isCurrentStreamingMessage}
            onLinkClick={openInlineArtifact}
          >
            {presentation.answer}
          </MarkdownRenderer>
        )}
      </div>
      {hasChoices(msg.content) && isMessageComplete && (
        <ChoicePicker
          text={msg.content}
          onChoose={(id, title) => window.dispatchEvent(new CustomEvent('choice-selected', {
            detail: { messageId: msg.id, choiceId: id, choiceTitle: title },
          }))}
        />
      )}
      {canPresentDeliverables && (showArtifactPreview || resolveDeliveryArtifacts(msg.meta).length > 0 || verifiedLocalFileReferences.length > 0) && (
        <ArtifactReferenceLinks
          msg={msg}
          preview={artifactPreview}
          onOpen={onOpenArtifact}
          referenceContent={presentation.answer}
          verifiedLocalFileReferences={verifiedLocalFileReferences}
        />
      )}
    </>
  )
}

function assistantTimelinePresentation(timeline) {
  const normalized = Array.isArray(timeline) ? timeline : []
  const hasTools = normalized.some((segment) => segment.kind === 'tools')
  if (!hasTools) {
    return {
      execution: [],
      answer: normalized.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join(''),
    }
  }
  const lastToolIndex = normalized.findLastIndex((segment) => segment.kind === 'tools')
  const finalTextIndex = normalized.findLastIndex((segment, index) => (
    index > lastToolIndex
    && segment.kind === 'text'
    && String(segment.text || '').trim()
  ))
  if (finalTextIndex < 0) return { execution: normalized, answer: '' }
  return {
    execution: normalized.filter((_, index) => index !== finalTextIndex),
    answer: normalized[finalTextIndex].text,
  }
}

function TimelineSegments({ artifacts, onLinkClick, onOpenArtifact, segments, streaming }) {
  return segments.map((segment, index) => segment.kind === 'tools' ? (
    <ToolCallTrace
      key={segment.key}
      calls={segment.calls}
      stepOffset={segment.stepOffset}
      artifacts={artifacts}
      onOpenArtifact={onOpenArtifact}
    />
  ) : (
    <MarkdownRenderer
      key={segment.key}
      artifactReferences={artifacts}
      streaming={streaming && index === segments.length - 1}
      onLinkClick={onLinkClick}
    >
      {segment.text}
    </MarkdownRenderer>
  ))
}

function ExecutionDisclosure({ children, hasExecution, msg, running, t }) {
  const [expanded, setExpanded] = useState(running)
  const contentId = useId()
  const [fallbackStartedAt] = useState(() => Date.now())
  const storedLatency = Number(msg.meta?.latency)
  const storedStartedAt = Number(msg.meta?.turnStartedAt)
  const storedCompletedAt = Number(msg.meta?.turnCompletedAt)
  const derivedLatency = Number.isFinite(storedStartedAt) && Number.isFinite(storedCompletedAt)
    ? Math.max(0, storedCompletedAt - storedStartedAt)
    : null
  const elapsedMs = !running
    ? Number.isFinite(storedLatency) ? Math.max(0, storedLatency) : derivedLatency ?? 0
    : null
  const startedAt = Number(msg.meta?.turnStartedAt || msg.timestamp) || fallbackStartedAt
  const elapsed = useElapsedMilliseconds({ elapsedMs, running, startedAt })
  const elapsedLabel = t('chatMessages.elapsed', { value: formatTaskDuration(elapsed, t) })
  const label = `${t('chatMessages.execution')} · ${elapsedLabel}`

  if (!hasExecution) {
    return <div className="chat-task-duration" data-testid="task-duration-header">{elapsedLabel}</div>
  }

  return (
    <section className="chat-execution-disclosure" data-running={running || undefined}>
      <button
        type="button"
        className="chat-execution-toggle"
        data-testid="execution-toggle"
        aria-controls={contentId}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span data-testid="task-duration-header">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {expanded && <div id={contentId} className="chat-execution-content" data-testid="execution-content">{children}</div>}
    </section>
  )
}

function useElapsedMilliseconds({ elapsedMs, running, startedAt }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || elapsedMs !== null) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [elapsedMs, running])
  return elapsedMs !== null ? elapsedMs : Math.max(0, now - startedAt)
}

function formatTaskDuration(milliseconds, t) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0
    ? t('chatMessages.durationMinutesSeconds', { minutes, seconds })
    : t('chatMessages.durationSeconds', { seconds })
}

const ARTIFACT_TYPE_LABELS = Object.freeze({
  docx: 'Word',
  html: 'HTML',
  html_multi: 'HTML',
  json: 'JSON',
  markdown: 'Markdown',
  mermaid: 'Mermaid',
  pdf: 'PDF',
  pptx: 'PowerPoint',
  react: 'React',
  svg: 'SVG',
  text: 'Text',
  xlsx: 'Excel',
})

function artifactTypeLabel(reference) {
  const type = String(reference?.type || '').trim().toLowerCase()
  if (!type || type === 'file') return ''
  return ARTIFACT_TYPE_LABELS[type] || type.toUpperCase()
}

function collapsedArtifactSummary(artifactReferences, t) {
  const references = Array.isArray(artifactReferences) ? artifactReferences : []
  if (references.length === 0) return t('chatMessages.artifactReadyGeneric')
  if (references.length === 1) {
    const [reference] = references
    const type = artifactTypeLabel(reference)
    if (!type) return t('chatMessages.artifactReadySingleFile', { filename: reference.filename })
    return t('chatMessages.artifactReadySingle', {
      filename: reference.filename,
      type,
    })
  }
  return t('chatMessages.artifactReadyMultiple', {
    count: references.length,
    filenames: references.map((reference) => reference.filename).join(', '),
  })
}

function CollapsedArtifactContent({ artifactPreview, artifactReferences, msg, onOpenArtifact, t, verifiedLocalFileReferences }) {
  const openToolArtifact = (reference) => {
    const payload = artifactReferenceOpenPayload(reference, msg.id)
    if (!payload) return false
    onOpenArtifact?.(payload)
    return true
  }
  return (
    <>
      <div className="chat-assistant-message text-[15px] leading-7" data-quotable="true">
        <ExecutionDisclosure
          hasExecution={Array.isArray(msg.meta?.toolCalls) && msg.meta.toolCalls.length > 0}
          msg={msg}
          running={false}
          t={t}
        >
          {Array.isArray(msg.meta?.toolCalls) && msg.meta.toolCalls.length > 0 && (
            <ToolCallTrace calls={msg.meta.toolCalls} artifacts={artifactReferences} onOpenArtifact={openToolArtifact} />
          )}
        </ExecutionDisclosure>
        <p data-testid="artifact-completion-summary">{collapsedArtifactSummary(artifactReferences, t)}</p>
      </div>
      <ArtifactReferenceLinks
        msg={msg}
        preview={artifactPreview}
        onOpen={onOpenArtifact}
        verifiedLocalFileReferences={verifiedLocalFileReferences}
      />
    </>
  )
}

function UserContent({ attachments, command, content, onOpenAttachment, t }) {
  const files = Array.isArray(attachments) ? attachments : []
  const displayContent = String(command?.command ? command.body : content || '')
  const collapsible = shouldCollapseUserMessage(displayContent)
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const collapsed = collapsible && !expanded
  const toggleLabel = t(expanded ? 'chatMessages.collapse' : 'chatMessages.expand')
  const visibleContent = collapsed
    ? buildCollapsedUserMessagePreview(displayContent)
    : displayContent

  return (
    <div data-testid="user-message-bubble" className={`chat-user-message max-w-full text-[14px] leading-[1.6] ${command?.command ? 'chat-user-skill-message' : ''}`}>
      {command?.command && <span data-testid="sent-skill-command" className="mb-1.5 inline-flex h-6 items-center rounded-md bg-ink/5 px-2 font-mono text-xs font-medium leading-none text-ink-soft">{command.command}</span>}
      {displayContent && (
        <div className={command?.command ? 'text-ink' : ''}>
          <span
            id={contentId}
            data-testid="user-message-content"
            className="block whitespace-pre-wrap break-words"
          >
            {visibleContent}{collapsed && <span aria-hidden="true">{'\u2026'}</span>}
          </span>
          {collapsible && (
            <button
              type="button"
              data-testid="user-message-collapse-toggle"
              aria-controls={contentId}
              aria-expanded={expanded}
              aria-label={toggleLabel}
              title={toggleLabel}
              onClick={() => setExpanded((value) => !value)}
              className="mt-1 inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/45"
            >
              {expanded
                ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
              {toggleLabel}
            </button>
          )}
        </div>
      )}
      {files.length > 0 && <div className={`${displayContent || command?.command ? 'mt-2' : ''} flex flex-wrap gap-1.5`} data-testid="user-message-attachments">
        {files.map((file) => <button key={file.id} type="button" onClick={() => onOpenAttachment?.(file)} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-ink/10 bg-paper px-2 py-1 text-xs text-ink-soft transition-colors hover:border-ember/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/45">
          <FileText className="h-3.5 w-3.5 shrink-0 text-ink-fade" />
          <span className="truncate">{file.name}</span>
        </button>)}
      </div>}
    </div>
  )
}

function InlineDirectoryRequestCard({ msg, onAuthorize, t }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const request = msg.meta?.serverClarification || {}
  const pending = msg.meta?.directoryAuthorizationPending === true

  const authorize = async (decision) => {
    if (pending || busy || typeof onAuthorize !== 'function') return
    setBusy('grant')
    setError('')
    try {
      await onAuthorize({ message: msg, ...decision })
    } catch (reason) {
      setError(reason?.message || t('taskSteering.directoryGrantFailed'))
    } finally {
      setBusy('')
    }
  }

  return (
    <DirectoryRequestCard
      request={request}
      busy={pending ? 'grant' : busy}
      error={error || msg.meta?.directoryAuthorizationError || ''}
      onAuthorize={authorize}
      t={t}
    />
  )
}

function UserMeta({ lang, msg, t }) {
  return (
    <div className="mt-1 flex min-h-5 items-center justify-end gap-3 text-[11px] leading-5 text-ink-fade tabular-nums">
      <span data-testid="user-message-time" className="chat-message-meta pointer-events-none opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100" title={formatMessageDateTime(msg.timestamp, lang)}>{formatMessageTime(msg.timestamp, lang)}</span>
      {!msg.meta?.streaming && (
        <div className="chat-message-actions pointer-events-none flex items-center gap-3 opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100">
          <CopyButton content={msg.content} t={t} />
        </div>
      )}
    </div>
  )
}

function AssistantMeta({ isCurrentStreamingMessage, lang, msg, showArtifactPreview, t }) {
  return (
    <div className={`${showArtifactPreview ? 'mt-2 px-2' : 'mt-1'} flex flex-wrap items-center gap-2 text-[11px] text-ink-fade/85`}>
      <div data-testid="assistant-message-meta" className="chat-message-meta pointer-events-none flex items-center gap-2 opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100">
        <span title={formatMessageDateTime(msg.timestamp, lang)}>{formatMessageTime(msg.timestamp, lang)}</span>
        {msg.meta?.type === 'model_reply' && <span>{t('chatMessages.model', { name: msg.meta.modelName })}</span>}
        {msg.meta?.type === 'model_reply' && msg.meta.latency !== undefined && <span>{t('chatMessages.latency', { value: msg.meta.latency })}</span>}
      </div>
      <div className="flex-1" />
      {!isCurrentStreamingMessage && (
        <div data-testid="assistant-message-actions" className="chat-message-actions pointer-events-none ml-auto flex items-center gap-2 opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100">
          <CopyButton content={msg.content} t={t} />
        </div>
      )}
    </div>
  )
}

function CopyButton({ content, t }) {
  const [copyState, setCopyState] = useState('idle')
  const resetTimerRef = useRef(null)

  useEffect(() => () => window.clearTimeout(resetTimerRef.current), [])

  const copy = async () => {
    try {
      await copyTextToClipboard(copyableMessageText(content))
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
    window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1600)
  }

  const label = copyState === 'copied'
    ? t('chatMessages.copied')
    : copyState === 'error'
      ? t('chatMessages.copyFailed')
      : t('chatMessages.copy')

  return (
    <button
      type="button"
      onClick={copy}
      className={`inline-flex items-center gap-1 transition-colors hover:text-ink ${copyState === 'error' ? 'text-rose-700' : 'text-ink-fade'}`}
      title={copyState === 'idle' ? t('chatMessages.copyContent') : label}
      aria-live="polite"
    >
      {copyState === 'copied' ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}{label}
    </button>
  )
}
