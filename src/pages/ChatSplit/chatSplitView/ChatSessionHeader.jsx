import { Folder, MessageSquare, PanelRightClose, PanelRightOpen } from 'lucide-react'

export function ChatSessionHeading({ hasWorkspace, title, ...headingAttributes }) {
  return <>
    {hasWorkspace
      ? <Folder className="h-4 w-4 shrink-0 text-ink-fade" aria-hidden="true" />
      : <MessageSquare className="h-4 w-4 shrink-0 text-ink-fade" aria-hidden="true" />}
    <h1
      {...headingAttributes}
      className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-ink"
      title={title}
    >
      {title}
    </h1>
  </>
}

export function ChatWorkbenchToggle({ open, ...buttonAttributes }) {
  return <button
    {...buttonAttributes}
    type="button"
    className="chat-chrome-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-fade hover:text-ink"
  >
    {open ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
  </button>
}
