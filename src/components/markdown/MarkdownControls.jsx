import { isValidElement, useState } from 'react'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import { copyTextToClipboard } from '../../lib/clipboard.js'
import { nodeText, selectedTextIntersects } from './markdownUtils.js'

export function SelectableFileLink({
  anchorProps,
  children,
  href,
  localPath,
  onLinkClick,
}) {
  const { t } = useT()
  const [copyState, setCopyState] = useState('idle')
  const copyPath = async (event) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      await copyTextToClipboard(localPath)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
    window.setTimeout(() => setCopyState('idle'), 1600)
  }

  return (
    <span className="chat-inline-file-reference">
      <a
        {...anchorProps}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="inline-artifact-link"
        title={anchorProps?.title || nodeText(children)}
        className="chat-output-file-name font-semibold decoration-current/45 underline-offset-4 hover:decoration-current"
        onClick={(event) => {
          if (selectedTextIntersects(event.currentTarget)) {
            event.preventDefault()
            return
          }
          if (onLinkClick?.(href, event)) event.preventDefault()
        }}
      >
        {children}
      </a>
      {localPath && (
        <button
          type="button"
          data-testid="copy-local-path"
          className="chat-inline-path-copy"
          aria-label={copyState === 'copied' ? t('chatMessages.copied') : t('chatMessages.copyContent')}
          title={copyState === 'copied' ? t('chatMessages.copied') : localPath}
          onClick={copyPath}
        >
          {copyState === 'copied'
            ? <Check className="h-3 w-3 text-success" />
            : <Copy className="h-3 w-3" />}
        </button>
      )}
    </span>
  )
}

/** Lines a finished block shows before it folds behind "show all". */
const CODE_FOLD_LINES = 24

export function CodeBlock({ children, streaming = false }) {
  const { t } = useT()
  const [copyState, setCopyState] = useState('idle')
  const [expanded, setExpanded] = useState(false)
  const child = Array.isArray(children) ? children[0] : children
  const className = isValidElement(child) ? child.props.className || '' : ''
  const language = className.match(/language-([\w-]+)/)?.[1] || 'text'
  const source = nodeText(child).replace(/\n$/, '')
  const lineCount = source ? source.split('\n').length : 0
  // A 300-line stylesheet pushed the actual answer a screen away. Finished
  // blocks fold; a streaming one never does, so nothing is hidden mid-write.
  const foldable = !streaming && lineCount > CODE_FOLD_LINES + 4
  const folded = foldable && !expanded

  const copy = async () => {
    try {
      await copyTextToClipboard(source)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
    window.setTimeout(() => setCopyState('idle'), 1600)
  }

  const copyLabel = copyState === 'copied'
    ? t('chatMessages.copied')
    : copyState === 'error'
      ? t('chatMessages.copyFailed')
      : t('chatMessages.copy')

  return (
    <div className="chat-code-block not-prose my-3 overflow-hidden rounded-card border border-ink/10 bg-paper-2/70 shadow-sm">
      <div className="chat-code-block-header flex h-7 items-center justify-between border-b border-ink/10 bg-paper/45 px-2.5">
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-fade">
          {language}
          {foldable && <span className="ml-2 normal-case tracking-normal">{t('codeBlock.lines', { count: lineCount })}</span>}
        </span>
        {!streaming && (
          <button
            type="button"
            onClick={copy}
            className={`chat-code-copy inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-xs transition-colors hover:bg-paper hover:text-ink ${copyState === 'error' ? 'text-danger' : 'text-ink-fade'}`}
            aria-label={copyState === 'idle' ? t('chatMessages.copyContent') : copyLabel}
            aria-live="polite"
          >
            {copyState === 'copied' ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            {copyLabel}
          </button>
        )}
      </div>
      <div className={folded ? 'chat-code-folded relative' : 'relative'} data-folded={folded || undefined}>
        <pre
          className="chat-code-scroll m-0 overflow-x-auto p-3 text-[12px] leading-5"
          style={folded ? { maxHeight: `calc(${CODE_FOLD_LINES} * 1.25rem + 1.5rem)`, overflowY: 'hidden' } : undefined}
        >
          {children}
        </pre>
        {foldable && (
          <button
            type="button"
            data-testid="code-block-fold"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="chat-code-fold-toggle flex w-full items-center justify-center gap-1 border-t border-ink/10 py-1.5 text-xs text-ink-fade transition-colors hover:bg-ink/[0.04] hover:text-ink"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
            {expanded ? t('codeBlock.collapse') : t('codeBlock.expand', { count: lineCount })}
          </button>
        )}
      </div>
    </div>
  )
}
