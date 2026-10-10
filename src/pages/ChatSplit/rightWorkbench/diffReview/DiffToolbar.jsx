import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ExternalLink, Maximize2, MoreVertical, RotateCw, Search, X } from 'lucide-react'
import { COMPARE_MODES, compareLabel } from '../../../../lib/diffReviewModel.js'

const BUTTON = 'flex h-7 w-7 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-default disabled:opacity-40'
const MENU = 'absolute right-0 top-8 z-30 w-64 rounded-card border border-ink/10 bg-surface p-1 shadow-xl'
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
 * The reviewer chrome: the file list toggle, the comparison breadcrumb, search,
 * the view-options menu, and the panel controls. Every control here does
 * something today — the window button only appears when a desktop shell can
 * actually host a window, so nothing is a decorative icon.
 */
export default function DiffToolbar({
  compact = false,
  onClose,
  onExpandToggle,
  onRefresh,
  onReviewCode,
  onSearchChange,
  onTargetChange,
  onToggleFiles,
  onViewChange,
  searchTerm = '',
  target,
  t,
  view,
}) {
  const [menu, setMenu] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const rootRef = useRef(null)
  const bridgeOpenWindow = globalThis.window?.gugoDesktop?.openDiffWindow
  const canOpenWindow = typeof bridgeOpenWindow === 'function'

  useEffect(() => {
    if (!menu) return undefined
    const close = (event) => { if (!rootRef.current?.contains(event.target)) setMenu('') }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const pick = (mode) => {
    onTargetChange?.({ ...target, mode })
    setMenu('')
  }
  const flip = (key) => { onViewChange?.({ ...view, [key]: !view[key] }); setMenu('') }

  return (
    <header ref={rootRef} className="flex h-10 shrink-0 items-center gap-1 border-b border-ink/10 px-2" data-testid="diff-toolbar">
      <button type="button" className={BUTTON} data-testid="diff-toggle-files" aria-pressed={view.showFiles}
        aria-label={t('diffReview.showFiles')} title={t('diffReview.showFiles')} onClick={() => onToggleFiles?.()}>
        <MoreVertical className="h-4 w-4 rotate-90" strokeWidth={1.6} aria-hidden="true" />
      </button>

      <details className="relative" open={menu === 'target'}>
        <summary
          data-testid="diff-breadcrumb"
          onClick={(event) => { event.preventDefault(); setMenu(menu === 'target' ? '' : 'target') }}
          className="flex cursor-pointer list-none items-center gap-1 rounded-control px-2 py-1 text-xs text-ink-soft hover:bg-ink/[0.05] [&::-webkit-details-marker]:hidden">
          <span className="truncate" data-testid="diff-breadcrumb-label">{compareLabel(target, t)}</span>
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        </summary>
        <div role="menu" data-testid="diff-target-menu" className="absolute left-0 top-8 z-30 w-56 rounded-card border border-ink/10 bg-surface p-1 shadow-xl">
          {COMPARE_MODES.map((mode) => (
            <button key={mode} type="button" role="menuitem" data-testid={`diff-target-${mode}`} className={MENU_ITEM}
              onClick={() => pick(mode)}>
              <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${target.mode === mode ? 'text-accent' : 'text-transparent'}`}>
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">{mode === 'branch' ? `${t('diffReview.compareAgainst')} ${target.branch}` : t(mode === 'all' ? 'diffReview.allChanges' : 'diffReview.uncommitted')}</span>
            </button>
          ))}
        </div>
      </details>

      <span className="min-w-0 flex-1" />

      <button type="button" className={BUTTON} data-testid="diff-search-toggle" aria-expanded={searchOpen}
        aria-label={t('diffReview.searchChangedFiles')} title={t('diffReview.searchChangedFiles')}
        onClick={() => { setSearchOpen((open) => !open); if (searchOpen) onSearchChange?.('') }}>
        <Search className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
      </button>

      <details className="relative" open={menu === 'more'}>
        <summary
          data-testid="diff-more"
          onClick={(event) => { event.preventDefault(); setMenu(menu === 'more' ? '' : 'more') }}
          aria-label={t('diffReview.more')} title={t('diffReview.more')}
          className={`${BUTTON} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
          <MoreVertical className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
        </summary>
        <div role="menu" data-testid="diff-view-menu" className={MENU}>
          <ViewToggle testId="diff-view-group" active={view.groupByFolder} onClick={() => flip('groupByFolder')}>{t('diffReview.groupByFolder')}</ViewToggle>
          <ViewToggle testId="diff-view-separate" active={view.separateSpecial} onClick={() => flip('separateSpecial')}>{t('diffReview.separateSpecial')}</ViewToggle>
          <span className="my-1 block h-px bg-ink/10" aria-hidden="true" />
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

      {searchOpen && (
        <input
          autoFocus
          value={searchTerm}
          data-testid="diff-search-input"
          aria-label={t('diffReview.searchChangedFiles')}
          placeholder={t('diffReview.searchChangedFiles')}
          onChange={(event) => onSearchChange?.(event.target.value)}
          className="ml-1 h-7 w-40 rounded-control border border-ink/15 bg-paper px-2 text-xs text-ink outline-none focus:border-focus"
        />
      )}
    </header>
  )
}
