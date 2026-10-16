import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ExternalLink, Maximize2, Menu, MoreVertical, RotateCw, X } from 'lucide-react'
import DiffReadingControls from './DiffReadingControls.jsx'
import { isCompositionEvent } from '../../../../lib/compositionEvent.js'

const BUTTON = 'flex h-7 w-7 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-default disabled:opacity-40'
const MENU = 'absolute right-0 top-8 z-30 w-64 max-w-[calc(100vw-1rem)] rounded-card border border-ink/10 bg-surface p-1 shadow-xl'
const MENU_ITEM = 'flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs text-ink-soft transition-colors hover:bg-[var(--color-row-hover)]'

function ViewToggle({ active, children, onClick, testId }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={active} data-testid={testId} className={MENU_ITEM} onClick={onClick}>
      <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${active ? 'text-accent' : 'text-transparent'}`}>
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  )
}

/**
 * The reviewer chrome: the file list toggle,
 * the view-options menu, and the panel controls. Every control here does
 * something today — the window button only appears when a desktop shell can
 * actually host a window, so nothing is a decorative icon.
 */
export default function DiffToolbar({
  compact = false,
  fileListOpen = false,
  onClose,
  onExpandToggle,
  onRefresh,
  onReviewCode,
  onToggleFileList,
  onViewChange,
  target, onTargetChange,
  t,
  view,
}) {
  const [menu, setMenu] = useState('')
  const rootRef = useRef(null)
  const bridgeOpenWindow = globalThis.window?.gugoDesktop?.openDiffWindow
  const canOpenWindow = typeof bridgeOpenWindow === 'function'

  useEffect(() => {
    if (!menu) return undefined
    const close = (event) => { if (!rootRef.current?.contains(event.target)) setMenu('') }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const flip = (key) => { onViewChange?.({ ...view, [key]: !view[key] }); setMenu('') }

  return (
    <header ref={rootRef} onKeyDown={event => { if (menu && event.key === 'Escape' && !isCompositionEvent(event)) { event.preventDefault(); event.stopPropagation(); setMenu(''); rootRef.current?.querySelector('[data-testid=diff-more]')?.focus() } }} className="flex h-10 shrink-0 items-center gap-1 border-b border-ink/10 px-2" data-testid="diff-toolbar">
      {/* One entry for this comparison set; no second diff/file navigation mode. */}
      <button type="button" className={BUTTON} data-testid="diff-toggle-files" aria-pressed={fileListOpen}
        aria-label={t(fileListOpen ? 'diffReview.hideFiles' : 'diffReview.showFiles')}
        title={t(fileListOpen ? 'diffReview.hideFiles' : 'diffReview.showFiles')} onClick={() => onToggleFileList?.()}>
        <Menu className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
      </button>

      <span className="min-w-0 flex-1" />

      <details className="relative" open={menu === 'more'}>
        <summary
          data-testid="diff-more"
          onClick={(event) => { event.preventDefault(); setMenu(menu === 'more' ? '' : 'more') }}
          aria-label={t('diffReview.more')} title={t('diffReview.more')}
          className={`${BUTTON} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
          <MoreVertical className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
        </summary>
        <div role="menu" data-testid="diff-view-menu" className={MENU}>
          {target && onTargetChange && <DiffReadingControls target={target} onTargetChange={onTargetChange} t={t} />}
          <button type="button" role="menuitem" data-testid="diff-collapse-all" className={MENU_ITEM} onClick={() => { setMenu(''); onViewChange?.({ ...view, collapseToken: (view.collapseToken || 0) + 1 }) }}>
            <span className="min-w-0 flex-1">{t('diffReview.collapseAll')}</span>
          </button>
          <button type="button" role="menuitem" data-testid="diff-expand-all" className={MENU_ITEM} onClick={() => { setMenu(''); onViewChange?.({ ...view, expandToken: (view.expandToken || 0) + 1 }) }}>
            <span className="min-w-0 flex-1">{t('diffReview.expandAll')}</span>
          </button>
          <span className="my-1 block h-px bg-ink/10" aria-hidden="true" />
          <ViewToggle testId="diff-view-side-by-side" active={view.sideBySide} onClick={() => flip('sideBySide')}>{t('diffReview.sideBySide')}</ViewToggle>
          <ViewToggle testId="diff-view-wrap" active={view.wordWrap} onClick={() => flip('wordWrap')}>{t('diffReview.wordWrap')}</ViewToggle>
          <ViewToggle testId="diff-view-words" active={view.highlightWords} onClick={() => flip('highlightWords')}>{t('diffReview.highlightWords')}</ViewToggle>
          <ViewToggle testId="diff-view-whitespace" active={view.hideWhitespace} onClick={() => flip('hideWhitespace')}>{t('diffReview.hideWhitespace')}</ViewToggle>
          <span className="my-1 block h-px bg-ink/10" aria-hidden="true" />
          <button type="button" role="menuitem" data-testid="diff-review-code-item" className={MENU_ITEM}
            onClick={() => { setMenu(''); onReviewCode?.() }}>
            <span className="min-w-0 flex-1">{t('diffReview.reviewCode')}</span>
          </button>
          <button type="button" role="menuitem" data-testid="diff-refresh" className={MENU_ITEM} onClick={() => { setMenu(''); onRefresh?.() }}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="min-w-0 flex-1">{t('diffReview.refresh')}</span>
          </button>
        </div>
      </details>

      {canOpenWindow && (
        <button type="button" className={BUTTON} data-testid="diff-open-window"
          aria-label={t('diffReview.openInNewWindow')} title={t('diffReview.openInNewWindow')}
          onClick={() => bridgeOpenWindow()}>
          <ExternalLink className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
        </button>
      )}

      <button type="button" className={BUTTON} data-testid="diff-expand-toggle" aria-pressed={compact === false}
        aria-label={t(compact ? 'diffReview.expandWidth' : 'diffReview.collapseWidth')}
        title={t(compact ? 'diffReview.expandWidth' : 'diffReview.collapseWidth')}
        onClick={() => onExpandToggle?.()}>
        {compact ? <Maximize2 className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" /> : <ChevronLeft className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />}
      </button>

      <button type="button" className={BUTTON} data-testid="diff-close" aria-label={t('diffReview.close')} title={t('diffReview.close')} onClick={() => onClose?.()}>
        <X className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
      </button>
    </header>
  )
}
