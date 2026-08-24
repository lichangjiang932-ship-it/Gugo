import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Pencil, RotateCcw } from 'lucide-react'
import { copyTextToClipboard } from '../../../../lib/clipboard.js'
import { formatMessageDateTime, formatMessageTime } from '../../../../lib/messageTime.js'
import { copyableMessageText } from '../messageContent.js'

function finiteOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export function UserMeta({ lang, msg, onEditMessage, t }) {
  return (
    <div className="mt-1 flex min-h-5 items-center justify-end gap-3 text-xs leading-5 text-ink-fade tabular-nums">
      <span data-testid="user-message-time" className="chat-message-meta pointer-events-none opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100" title={formatMessageDateTime(msg.timestamp, lang)}>{formatMessageTime(msg.timestamp, lang)}</span>
      {!msg.meta?.streaming && (
        <div className="chat-message-actions pointer-events-none flex items-center gap-3 opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100">
          {typeof onEditMessage === 'function' && (
            <button
              type="button"
              onClick={() => onEditMessage(msg)}
              className="chat-message-action inline-flex items-center gap-1 text-ink-fade hover:text-ink"
              title={t('chatMessages.editResend')}
              data-testid="edit-user-message"
            >
              <Pencil className="h-3 w-3" aria-hidden="true" />{t('chatMessages.edit')}
            </button>
          )}
          <CopyButton content={msg.content} t={t} />
        </div>
      )}
    </div>
  )
}

export function AssistantMeta({ isCurrentStreamingMessage, lang, msg, onRetryModelFailure, showArtifactPreview, t }) {
  const latency = finiteOptionalNumber(msg.meta?.latency)
  return (
    <div className={`${showArtifactPreview ? 'mt-2 px-2' : 'mt-1'} flex flex-wrap items-center gap-2 text-xs text-ink-fade/85 tabular-nums`}>
      <div data-testid="assistant-message-meta" className="chat-message-meta pointer-events-none flex items-center gap-2 opacity-0 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100">
        <span title={formatMessageDateTime(msg.timestamp, lang)}>{formatMessageTime(msg.timestamp, lang)}</span>
        {msg.meta?.type === 'model_reply' && <span>{t('chatMessages.model', { name: msg.meta.modelName })}</span>}
        {msg.meta?.type === 'model_reply' && latency !== null && <span>{t('chatMessages.latency', { value: latency })}</span>}
      </div>
      <div className="flex-1" />
      {!isCurrentStreamingMessage && (
        <div data-testid="assistant-message-actions" className="chat-message-actions ml-auto flex items-center gap-2 opacity-60 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
          {typeof onRetryModelFailure === 'function' && (
            <button
              type="button"
              onClick={() => onRetryModelFailure(msg)}
              className="chat-message-action inline-flex items-center gap-1 text-ink-fade hover:text-ink"
              title={t('chatMessages.resendMessage')}
              data-testid="retry-model-request"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />{t('chatMessages.resend')}
            </button>
          )}
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
      data-testid="copy-message"
      className={`inline-flex items-center gap-1 transition-colors hover:text-ink ${copyState === 'error' ? 'text-danger' : 'text-ink-fade'}`}
      title={copyState === 'idle' ? t('chatMessages.copyContent') : label}
      aria-live="polite"
    >
      {copyState === 'copied' ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}{label}
    </button>
  )
}
