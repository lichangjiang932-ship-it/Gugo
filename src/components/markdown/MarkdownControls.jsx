import { isValidElement, useState } from 'react'
import { Check, Copy } from 'lucide-react'
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

export function CodeBlock({ children, streaming = false }) {
  const { t } = useT()
  const [copyState, setCopyState] = useState('idle')
  const child = Array.isArray(children) ? children[0] : children
  const className = isValidElement(child) ? child.props.className || '' : ''
  const language = className.match(/language-([\w-]+)/)?.[1] || 'text'
  const source = nodeText(child).replace(/\n$/, '')

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
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-ink-fade">{language}</span>
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
      <pre className="chat-code-scroll m-0 overflow-x-auto p-3 text-[12px] leading-5">{children}</pre>
    </div>
  )
}
