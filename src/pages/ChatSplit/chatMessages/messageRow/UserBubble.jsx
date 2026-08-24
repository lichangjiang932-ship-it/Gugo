import { useId, useState } from 'react'
import { ChevronDown, ChevronUp, FileText } from 'lucide-react'
import DirectoryRequestCard from '../../../taskRun/DirectoryRequestCard.jsx'
import {
  buildCollapsedUserMessagePreview,
  shouldCollapseUserMessage,
} from '../messageContent.js'

export function UserBubble({ attachments, command, content, onOpenAttachment, t }) {
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
      {command?.command && <span data-testid="sent-skill-command" className="mb-1.5 inline-flex h-6 items-center rounded-control bg-ink/5 px-2 font-mono text-xs font-medium leading-5 text-ink-soft">{command.command}</span>}
      {displayContent && (
        <div className={command?.command ? 'text-ink' : ''}>
          <span
            id={contentId}
            data-testid="user-message-content"
            className="block whitespace-pre-wrap break-words"
          >
            {visibleContent}{collapsed && <span aria-hidden="true">{'…'}</span>}
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
              className="mt-1 inline-flex min-h-7 items-center gap-1 rounded-control px-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/45"
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
        {files.map((file) => <button key={file.id} type="button" onClick={() => onOpenAttachment?.(file)} className="inline-flex max-w-full items-center gap-1.5 rounded-control border border-ink/10 bg-paper px-2 py-1 text-xs text-ink-soft transition-colors hover:border-accent/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/45">
          <FileText className="h-3.5 w-3.5 shrink-0 text-ink-fade" />
          <span className="truncate">{file.name}</span>
        </button>)}
      </div>}
    </div>
  )
}

export function InlineDirectoryRequestCard({ msg, onAuthorize, t }) {
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
