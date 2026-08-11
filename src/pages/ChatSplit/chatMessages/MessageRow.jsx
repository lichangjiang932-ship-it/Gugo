import { motion } from 'framer-motion'
import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Copy, FileText } from 'lucide-react'
import MarkdownRenderer from '../../../components/MarkdownRenderer.jsx'
import CompactionPill from '../../../components/CompactionPill.jsx'
import ChoicePicker from '../../../components/ChoicePicker.jsx'
import { hasChoices, stripChoices } from '../../../lib/choices.js'
import { buildMessageTimeline } from '../../../lib/messageTimeline.js'
import { shouldCollapseArtifactPreview } from '../../../lib/artifactPreview.js'
import { artifactHasInlineReference, artifactReferenceOpenPayload, buildMessageArtifactPreview, buildServerArtifactReferences, findArtifactReferenceByHref } from '../../../lib/artifactReferences.js'
import { formatMessageDateTime, formatMessageTime } from '../../../lib/messageTime.js'
import { copyTextToClipboard } from '../../../lib/clipboard.js'
import { ArtifactReferenceLinks } from './ArtifactCards.jsx'
import { ProgressTrace, ReasoningTrace, ToolCallTrace } from './ActivityTraces.jsx'
import { buildCollapsedUserMessagePreview, shouldCollapseUserMessage, splitUserSkillCommand } from './messageContent.js'
import DirectoryRequestCard from '../../taskRun/DirectoryRequestCard.jsx'

export default function MessageRow({
  msg,
  rowKey,
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
  const artifactPreview = buildMessageArtifactPreview(msg)
  const isCurrentStreamingMessage = msg.id === generatingMessageId || !!msg.meta?.streaming
  const modelActivity = msg.meta?.modelActivity?.kind === 'tool_call_ready'
    ? msg.meta.modelActivity
    : null
  const liveStatusLabel = modelActivity
    ? t('chatMessages.toolCallReady', { name: modelActivity.toolName })
    : t('chatMessages.reasoningActive')
  // A new turn must not make completed artifact messages look "streaming" again.
  // Their collapsed source/link presentation is part of the message itself, not
  // global chat generation state.
  const isMessageComplete = !isCurrentStreamingMessage
  const showArtifactPreview = !!artifactPreview && isMessageComplete
  const serverArtifactReferences = buildServerArtifactReferences({
    artifacts: msg.meta?.serverArtifacts,
    content: String(msg.meta?.artifactSource || msg.content || ''),
    messageId: msg.id,
    preview: artifactPreview,
  })
  const hasInlineArtifactReference = serverArtifactReferences.some((reference) => artifactHasInlineReference(msg.content, reference))
  const collapseArtifact = showArtifactPreview && !hasInlineArtifactReference && shouldCollapseArtifactPreview(artifactPreview, {
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
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`group/message flex w-full py-1.5 sm:py-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
    >
      <div className={collapseArtifact
        ? 'w-full max-w-[840px]'
        : msg.role === 'assistant'
          ? 'chat-assistant-message w-full max-w-[840px] text-[15px] leading-7'
          : 'flex max-w-[min(720px,86%)] flex-col items-end'}>
        {msg.role === 'assistant' && !collapseArtifact && isCurrentStreamingMessage && (
          <div data-testid={modelActivity ? 'model-activity' : undefined} className="mb-2 flex items-center gap-2 text-[11px] text-ink-fade" role="status" aria-live="polite">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ember" aria-hidden="true" />
            <span>{liveStatusLabel}</span>
          </div>
        )}
        {msg.role === 'assistant' ? (
          collapseArtifact ? (
            <CollapsedArtifactContent
              artifactPreview={artifactPreview}
              msg={msg}
              onOpenArtifact={openArtifact}
              t={t}
            />
          ) : (
            <AssistantContent
              artifactPreview={artifactPreview}
              isCurrentStreamingMessage={isCurrentStreamingMessage}
              isMessageComplete={isMessageComplete}
              msg={msg}
              onOpenArtifact={openArtifact}
              onOpenInPreview={onOpenInPreview}
              showArtifactPreview={showArtifactPreview}
            />
          )
        ) : (
          <UserContent attachments={msg.attachments} command={userSkillCommand} content={msg.content} t={t} />
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
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-dashed border-ember/40 pt-2 text-[11px]">
            <span className="text-ember">{t('chatMessages.replyIncomplete')}</span>
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

function AssistantContent({ artifactPreview, isCurrentStreamingMessage, isMessageComplete, msg, onOpenArtifact, showArtifactPreview }) {
  const artifactReferences = buildServerArtifactReferences({
    artifacts: msg.meta?.serverArtifacts,
    content: String(msg.meta?.artifactSource || msg.content || ''),
    messageId: msg.id,
    preview: artifactPreview,
  })
  const openInlineArtifact = (href) => {
    const reference = findArtifactReferenceByHref(artifactReferences, href)
    if (!reference) return false
    onOpenArtifact?.(artifactReferenceOpenPayload(reference, msg.id))
    return true
  }
  return (
    <>
      <div data-quotable="true">
        <ReasoningTrace text={msg.meta?.reasoning || ''} streaming={!!msg.meta?.streaming && !msg.content} />
        {buildMessageTimeline(stripChoices(msg.content), msg.meta?.toolCalls).map((segment, index) => (
          segment.kind === 'tools'
            ? <ToolCallTrace key={`tool-${index}`} calls={segment.calls} />
            : <MarkdownRenderer key={`text-${index}`} artifactReferences={artifactReferences} streaming={isCurrentStreamingMessage} onLinkClick={openInlineArtifact}>{segment.text}</MarkdownRenderer>
        ))}
      </div>
      {msg.meta?.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-ember/80 align-middle" aria-hidden="true" />}
      <ProgressTrace progress={msg.meta?.progress} />
      {hasChoices(msg.content) && isMessageComplete && (
        <ChoicePicker
          text={msg.content}
          onChoose={(id, title) => window.dispatchEvent(new CustomEvent('choice-selected', {
            detail: { messageId: msg.id, choiceId: id, choiceTitle: title },
          }))}
        />
      )}
      {isMessageComplete && (showArtifactPreview || msg.meta?.serverArtifacts?.length > 0) && (
        <ArtifactReferenceLinks msg={msg} preview={artifactPreview} onOpen={onOpenArtifact} />
      )}
    </>
  )
}

function CollapsedArtifactContent({ artifactPreview, msg, onOpenArtifact, t }) {
  return (
    <>
      <div className="chat-assistant-message text-[15px] leading-7" data-quotable="true">
        <ReasoningTrace text={msg.meta?.reasoning || ''} streaming={false} />
        {Array.isArray(msg.meta?.toolCalls) && msg.meta.toolCalls.length > 0 && (
          <ToolCallTrace calls={msg.meta.toolCalls} />
        )}
        <p>{t('chat.serverTurn.completed')}</p>
        <ProgressTrace progress={msg.meta?.progress} />
      </div>
      <ArtifactReferenceLinks msg={msg} preview={artifactPreview} onOpen={onOpenArtifact} />
    </>
  )
}

function UserContent({ attachments, command, content, t }) {
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
    <div data-testid="user-message-bubble" className={`chat-user-message max-w-full rounded-2xl rounded-br-md border bg-paper-2 px-3.5 py-2 text-[14px] leading-6 ${command?.command ? 'chat-user-skill-message border-ink/20' : 'border-ink/10'}`}>
      {command?.command && <span data-testid="sent-skill-command" className="mb-1.5 inline-flex h-6 items-center rounded-md bg-ink px-2 font-mono text-xs font-medium leading-none text-paper shadow-sm">{command.command}</span>}
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
        {files.map((file) => <span key={file.id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-ink/10 bg-paper px-2 py-1 text-xs text-ink-soft">
          <FileText className="h-3.5 w-3.5 shrink-0 text-ink-fade" />
          <span className="truncate">{file.name}</span>
        </span>)}
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
    setBusy(decision.usePicker ? 'picker' : 'grant')
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
    <div className="mt-1 flex h-4 items-center justify-end gap-3 pr-1 text-[10px] leading-none text-ink-fade">
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
    <div className={`${showArtifactPreview ? 'mt-2 px-2' : 'mt-4'} flex flex-wrap items-center gap-2 text-[11px] text-ink-fade/85`}>
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
      await copyTextToClipboard(content)
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
