import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import MarkdownRenderer from '../../../components/MarkdownRenderer.jsx'
import CompactionPill from '../../../components/CompactionPill.jsx'
import ChoicePicker from '../../../components/ChoicePicker.jsx'
import { hasChoices, stripChoices } from '../../../lib/choices.js'
import { buildMessageTimeline } from '../../../lib/messageTimeline.js'
import { buildArtifactPreview, shouldCollapseArtifactPreview } from '../../../lib/artifactPreview.js'
import { artifactHasInlineLink, artifactReferenceOpenPayload, buildServerArtifactReferences, findArtifactReferenceByHref } from '../../../lib/artifactReferences.js'
import { formatMessageDateTime, formatMessageTime } from '../../../lib/messageTime.js'
import { copyTextToClipboard } from '../../../lib/clipboard.js'
import { ArtifactReferenceLinks } from './ArtifactCards.jsx'
import { ReasoningTrace, ToolCallTrace } from './ActivityTraces.jsx'
import { splitUserSkillCommand } from './messageContent.js'

export default function MessageRow({
  msg,
  rowKey,
  generatingMessageId,
  isGenerating,
  lang,
  onExpandCompaction,
  onOpenArtifact,
  onOpenInPreview,
  t,
}) {
  const artifactPreview = msg.role === 'assistant' && (msg.meta?.artifactSource || msg.content)
    ? buildArtifactPreview({ content: msg.meta?.artifactSource || msg.content, meta: msg.meta || {} })
    : null
  const isCurrentStreamingMessage = msg.id === generatingMessageId || !!msg.meta?.streaming
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
  const hasInlineArtifactLink = serverArtifactReferences.some((reference) => artifactHasInlineLink(msg.content, reference))
  const collapseArtifact = showArtifactPreview && !hasInlineArtifactLink && shouldCollapseArtifactPreview(artifactPreview, {
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
          <div className="mb-2 flex items-center gap-2 text-[11px] text-ink-fade" role="status" aria-live="polite">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ember" aria-hidden="true" />
            <span>{t('chatMessages.reasoningActive')}</span>
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
          <UserContent command={userSkillCommand} content={msg.content} />
        )}
        {msg.role === 'user' && (
          <UserMeta isGenerating={isGenerating} lang={lang} msg={msg} t={t} />
        )}
        {msg.role === 'assistant' && (
          <AssistantMeta
            generatingMessageId={generatingMessageId}
            isGenerating={isGenerating}
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
            : <MarkdownRenderer key={`text-${index}`} streaming={isCurrentStreamingMessage} onLinkClick={openInlineArtifact}>{segment.text}</MarkdownRenderer>
        ))}
      </div>
      {msg.meta?.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-ember/80 align-middle" aria-hidden="true" />}
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
      </div>
      <ArtifactReferenceLinks msg={msg} preview={artifactPreview} onOpen={onOpenArtifact} />
    </>
  )
}

function UserContent({ command, content }) {
  return (
    <div data-testid="user-message-bubble" className={`chat-user-message max-w-full rounded-2xl rounded-br-md border bg-paper-2 px-3.5 py-2 text-[14px] leading-6 ${command?.command ? 'chat-user-skill-message border-ink/20' : 'border-ink/10'}`}>
      {command?.command && <span data-testid="sent-skill-command" className="mb-1.5 inline-flex h-6 items-center rounded-md bg-ink px-2 font-mono text-xs font-medium leading-none text-paper shadow-sm">{command.command}</span>}
      <span className={`whitespace-pre-wrap ${command?.command ? 'block text-ink' : ''}`}>{command?.command ? command.body : content}</span>
    </div>
  )
}

function UserMeta({ isGenerating, lang, msg, t }) {
  return (
    <div className="mt-1 flex h-4 items-center justify-end gap-3 pr-1 text-[10px] leading-none text-ink-fade">
      <span data-testid="user-message-time" className="chat-message-meta pointer-events-none opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100" title={formatMessageDateTime(msg.timestamp, lang)}>{formatMessageTime(msg.timestamp, lang)}</span>
      {!isGenerating && !msg.meta?.streaming && (
        <div className="chat-message-actions pointer-events-none flex items-center gap-3 opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100">
          <CopyButton content={msg.content} t={t} />
        </div>
      )}
    </div>
  )
}

function AssistantMeta({ generatingMessageId, isGenerating, lang, msg, showArtifactPreview, t }) {
  return (
    <div className={`${showArtifactPreview ? 'mt-2 px-2' : 'mt-4'} flex flex-wrap items-center gap-2 text-[11px] text-ink-fade/85`}>
      <div data-testid="assistant-message-meta" className="chat-message-meta pointer-events-none flex items-center gap-2 opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100">
        <span title={formatMessageDateTime(msg.timestamp, lang)}>{formatMessageTime(msg.timestamp, lang)}</span>
        {msg.meta?.type === 'model_reply' && <span>{t('chatMessages.model', { name: msg.meta.modelName })}</span>}
        {msg.meta?.type === 'model_reply' && msg.meta.latency !== undefined && <span>{t('chatMessages.latency', { value: msg.meta.latency })}</span>}
      </div>
      <div className="flex-1" />
      {!isGenerating && msg.id !== generatingMessageId && !msg.meta?.streaming && (
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
