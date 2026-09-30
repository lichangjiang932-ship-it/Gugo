import { useRef, useState } from 'react'
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Copy,
  Home,
  Maximize2,
  Minimize2,
  MousePointer,
  MoreVertical,
  RotateCw,
  X,
} from 'lucide-react'
import { copyTextToClipboard } from '../../../lib/clipboard.js'
import { isDesktopPageFactsAvailable } from '../../../lib/desktopBrowserClient.js'
import { usePreviewPageStatus } from '../../../lib/previewPageStore.js'
import { WORKBENCH_TOOLS, shortcutLabelFor } from '../../../lib/workbenchShortcuts.js'
import ToolIconTile from './ToolIconTile.jsx'
import { TOOL_GLYPHS } from './workbenchToolGlyphs.js'

const BUTTON = 'flex h-7 w-7 items-center justify-center rounded-full text-ink-fade transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-default disabled:text-skel-2 disabled:hover:bg-transparent disabled:hover:text-skel-2'
const MENU_ITEM = 'flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs text-ink-soft hover:bg-[var(--color-row-hover)] disabled:opacity-40'
const MENU = 'absolute right-0 top-8 z-30 w-56 rounded-card bg-surface p-1 shadow-xl'
const MENU_GROUP = 'px-2.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-fade'

function toolTitle(tool, t) {
  const label = t(tool.labelKey)
  const shortcut = shortcutLabelFor(tool)
  return shortcut ? t('workbench.toolWithShortcut', { label, shortcut }) : label
}

/**
 * Two panels, one behind the other: the reference's "open in a window of its own"
 * mark, drawn to the same 1.5px outline as the rest of the bar. It is not the
 * copy glyph on purpose — this control never puts anything on the clipboard.
 */
function OpenInWindowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <rect x="3" y="7" width="13" height="10" rx="2.5" />
      <path d="M9.5 4.5h8A3.5 3.5 0 0 1 21 8v7" />
    </svg>
  )
}

const PREVIEW_EVENT = Object.freeze({
  back: 'workbench-preview:back',
  forward: 'workbench-preview:forward',
  reload: 'workbench-preview:reload',
  openExternal: 'workbench-preview:open-external',
  copyUrl: 'workbench-preview:copy-url',
})

function previewEvent(name) {
  window.dispatchEvent(new CustomEvent(name))
}

/**
 * The sidebar's top bar, in the reference order: back, forward, select,
 * refresh, settings, open-external, expand, close.
 *
 * Back/forward walk between the entry page and the tool you came from. The
 * preview controls (select, refresh, settings, open-external) act on the
 * embedded browser through events — the browser owns its URL, the bar only
 * names the intent — and stay disabled on tabs where they mean nothing, or
 * until element selection lands with the Preview integration.
 *
 * The bar itself holds only those controls: at the panel's minimum width eight
 * icons already fill it. Switching tools therefore lives in the settings menu,
 * grouped above the preview settings, so every tool stays one press away and
 * none of them competes with the preview order for space.
 */
export default function WorkbenchToolbar({
  activeTab,
  contributedTabs = [],
  onClose,
  onResetWidth,
  onPickElement,
  onScreenshot,
  onTabChange,
  onToggleExpand,
  panelExpanded = false,
  picking = false,
  t,
  workspacePath = '',
}) {
  const [forwardTo, setForwardTo] = useState(null)
  const menuRef = useRef(null)
  const onPreview = activeTab === 'browser'
  const pageFactsAvailable = () => isDesktopPageFactsAvailable()
  // On the browser tab the pair walks the page's own history, which is what the
  // reference means by back and forward; on the other tabs there is no page, so
  // they walk between the entry page and the tool, and the tooltips say which.
  const page = usePreviewPageStatus()
  const pageHistory = activeTab === 'browser' && Boolean(page.url || page.backend === 'host')
  const backEnabled = pageHistory ? page.canGoBack : activeTab !== 'entry'
  const forwardEnabled = pageHistory ? page.canGoForward : Boolean(forwardTo)
  const backTitle = pageHistory ? t('workbench.browserBack') : t('workbench.entryBack')
  const forwardTitle = pageHistory ? t('workbench.browserForward') : t('workbench.entryForward')
  const goBack = () => {
    if (pageHistory) {
      previewEvent(PREVIEW_EVENT.back)
      return
    }
    if (activeTab === 'entry') return
    setForwardTo(activeTab)
    onTabChange?.('entry')
  }
  const goForward = () => {
    if (pageHistory) {
      previewEvent(PREVIEW_EVENT.forward)
      return
    }
    if (!forwardTo) return
    const target = forwardTo
    setForwardTo(null)
    onTabChange?.(target)
  }
  const pickTool = (id) => { if (menuRef.current) menuRef.current.open = false; onTabChange?.(id) }
  const closeMenu = () => {
    if (!menuRef.current?.open) return
    menuRef.current.open = false
    menuRef.current?.querySelector('summary')?.focus()
  }
  return (
    <nav data-testid="workbench-tool-switch" aria-label={t('workbench.tools')} className="flex h-9 shrink-0 items-center justify-end gap-2 pr-3">
      <button type="button" data-testid="workbench-tool-entry" disabled={!backEnabled}
        onClick={goBack} aria-label={backTitle} title={backTitle} className={BUTTON}>
        <ChevronLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button type="button" data-testid="workbench-tool-forward" disabled={!forwardEnabled}
        onClick={goForward} aria-label={forwardTitle} title={forwardTitle} className={BUTTON}>
        <ChevronRight className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button type="button" data-testid="workbench-tool-select"
        disabled={!onPreview || !pageFactsAvailable()}
        aria-pressed={picking || undefined}
        onClick={() => onPickElement?.()}
        aria-label={t('workbench.selectElement')} title={t('workbench.selectElement')}
        className={`${BUTTON} ${picking ? 'bg-accent-soft text-accent-ink hover:bg-accent-soft' : ''}`}>
        <MousePointer className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button type="button" data-testid="workbench-tool-refresh" disabled={!onPreview}
        onClick={() => previewEvent(PREVIEW_EVENT.reload)}
        aria-label={t('workbench.browserReload')} title={t('workbench.browserReload')} className={BUTTON}>
        <RotateCw className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
      </button>
      <details ref={menuRef} className="group relative" onKeyDown={(event) => { if (event.key === 'Escape') closeMenu() }}>
        <summary data-testid="workbench-tool-settings" aria-label={t('workbench.moreActions')}
          className={`${BUTTON} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
          <MoreVertical className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          {/* Inside the summary: a closed <details> does not render its slot, so a
              tooltip parked beside the menu would never appear on hover. */}
          <span className="preview-settings-tip" role="tooltip" data-testid="workbench-settings-tip">Preview settings</span>
        </summary>
        <div role="menu" aria-label={t('workbench.moreActions')} className={MENU}>
          <p className={MENU_GROUP}>{t('workbench.tools')}</p>
          {/* On the browser tab the arrows belong to the page, so the way back to
              the tool list is here rather than nowhere. */}
          {activeTab !== 'entry' && (
            <button type="button" role="menuitem" data-testid="workbench-menu-entry"
              title={t('workbench.entryHome')} onClick={() => pickTool('entry')} className={MENU_ITEM}>
              <Home className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{t('workbench.entryHome')}</span>
            </button>
          )}
          {WORKBENCH_TOOLS.map((tool) => (
            <button key={tool.id} type="button" role="menuitem" data-tool={tool.id}
              data-testid={`workbench-tool-${tool.id}`} title={toolTitle(tool, t)}
              aria-current={activeTab === tool.id ? 'page' : undefined}
              onClick={() => pickTool(tool.id)} className={MENU_ITEM}>
              <ToolIconTile icon={TOOL_GLYPHS[tool.id]} size="sm" toolId={tool.id} />
              <span className="min-w-0 flex-1">{t(tool.labelKey)}</span>
              {shortcutLabelFor(tool) && <span className="shrink-0 font-mono text-xs text-ink-fade">{shortcutLabelFor(tool)}</span>}
            </button>
          ))}
          {contributedTabs.map((contribution) => (
            <button key={contribution.key} type="button" role="menuitem" data-tool={contribution.tabId}
              data-ui-plugin={contribution.pluginId} data-testid={`workbench-tool-${contribution.tabId}`}
              title={contribution.labelKey ? t(contribution.labelKey) : contribution.label}
              aria-current={activeTab === contribution.tabId ? 'page' : undefined}
              onClick={() => pickTool(contribution.tabId)} className={MENU_ITEM}>
              <ToolIconTile icon={contribution.icon} size="sm" toolId="fallback" />
              <span className="min-w-0 flex-1">{contribution.labelKey ? t(contribution.labelKey) : contribution.label}</span>
            </button>
          ))}
          <span className="my-1 block h-px bg-ink/10" aria-hidden="true" />
          <p className={MENU_GROUP}>{t('workbench.previewSettings')}</p>
          {/* The reference puts this one control on its own, as a raised pill
              inside the menu: it is the action people come to this menu for. */}
          <button type="button" role="menuitem" data-testid="preview-menu-screenshot"
            disabled={!onPreview || !pageFactsAvailable()}
            title={pageFactsAvailable() ? t('workbench.previewSaveScreenshot') : t('workbench.selectElement')}
            onClick={() => { closeMenu(); onScreenshot?.() }}
            className="preview-menu-pill">
            <Camera className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('workbench.previewSaveScreenshot')}</span>
          </button>
          <button type="button" role="menuitem" data-testid="preview-menu-reload" disabled={!onPreview}
            onClick={() => { closeMenu(); previewEvent(PREVIEW_EVENT.reload) }} className={MENU_ITEM}>
            {t('workbench.browserReload')}
          </button>
          <button type="button" role="menuitem" data-testid="preview-menu-open" disabled={!onPreview}
            onClick={() => { closeMenu(); previewEvent(PREVIEW_EVENT.openExternal) }} className={MENU_ITEM}>
            {t('workbench.openBrowser')}
          </button>
          <button type="button" role="menuitem" data-testid="preview-menu-copy" disabled={!onPreview}
            onClick={() => { closeMenu(); previewEvent(PREVIEW_EVENT.copyUrl) }} className={MENU_ITEM}>
            {t('workbench.copyPreviewUrl')}
          </button>
          <span className="my-1 block h-px bg-ink/10" aria-hidden="true" />
          <button type="button" role="menuitem" data-testid="preview-menu-copy-workspace" disabled={!workspacePath}
            title={t('workbench.copyWorkspace')}
            onClick={() => { closeMenu(); if (workspacePath) void copyTextToClipboard(workspacePath) }}
            className={MENU_ITEM}>
            <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{t('workbench.copyWorkspace')}</span>
          </button>
          <button type="button" role="menuitem" data-testid="preview-menu-reset" onClick={() => { closeMenu(); onResetWidth?.() }}
            className={MENU_ITEM}>
            {t('workbench.resetWidth')}
          </button>
        </div>
      </details>
      <button type="button" data-testid="workbench-tool-open-external" disabled={!onPreview}
        onClick={() => previewEvent(PREVIEW_EVENT.openExternal)}
        aria-label={t('workbench.previewOpenWindow')} title={t('workbench.previewOpenWindow')} className={BUTTON}>
        <OpenInWindowIcon />
      </button>
      <button type="button" data-testid="workbench-tool-expand" aria-pressed={panelExpanded} onClick={() => onToggleExpand?.()}
        aria-label={t(panelExpanded ? 'workbench.collapsePanel' : 'workbench.expandPanel')}
        title={t(panelExpanded ? 'workbench.collapsePanel' : 'workbench.expandPanel')} className={BUTTON}>
        {panelExpanded
          ? <Minimize2 className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          : <Maximize2 className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
      </button>
      <button type="button" data-testid="workbench-close" onClick={() => onClose?.()}
        aria-label={t('workbench.close')} title={t('workbench.close')} className={BUTTON}>
        <X className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
      </button>
    </nav>
  )
}
