import { MessageSquare, PanelRight, Play } from 'lucide-react'
import ProjectGlyph from '../../../components/ProjectGlyph.jsx'

export function ChatSessionHeading({ hasWorkspace, title, workspacePath = '', ...headingAttributes }) {
  const project = String(workspacePath || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  return <>
    {hasWorkspace && project
      ? <ProjectGlyph name={project} open className="chat-session-project-glyph" title={workspacePath} />
      : <MessageSquare className="h-4 w-4 shrink-0 text-ink-fade" strokeWidth={1.6} aria-hidden="true" />}
    {/* project / conversation, as Codex and Claude Code show the thread's place:
        the project is context, the title is what this header is about. */}
    {hasWorkspace && project && (
      <>
        <span className="hidden max-w-[12rem] shrink-0 truncate text-[13px] text-ink-fade sm:inline" title={workspacePath} data-testid="chat-session-project">{project}</span>
        <span className="hidden shrink-0 text-ink/20 sm:inline" aria-hidden="true">/</span>
      </>
    )}
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
    data-open={open || undefined}
    className="chat-chrome-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-fade hover:text-ink"
  >
    <PanelRight className="h-[18px] w-[18px]" strokeWidth={1.5} aria-hidden="true" />
  </button>
}

/**
 * The way into the preview: one press, and the same key works from the keyboard.
 *
 * The tooltip carries the key beside the label — the reference product's own
 * shape — and is worth having here because this is the only control in the header
 * whose shortcut is not implied by a familiar icon.
 */
export function ChatPreviewButton({ label, open, shortcut, ...buttonAttributes }) {
  return <button
    {...buttonAttributes}
    type="button"
    data-open={open || undefined}
    className="chat-chrome-button group relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-fade hover:text-ink"
  >
    <Play className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
    <span role="tooltip" data-testid="chat-preview-tip" className="chat-chrome-tip">
      <span>{label}</span>
      {shortcut && <span className="chat-chrome-tip-key">{shortcut}</span>}
    </span>
  </button>
}
