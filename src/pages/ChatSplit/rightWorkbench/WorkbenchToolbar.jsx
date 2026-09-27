import { useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Maximize2,
  Minimize2,
  MoreVertical,
  RotateCcw,
  X,
} from 'lucide-react'
import { copyTextToClipboard } from '../../../lib/clipboard.js'
import { WORKBENCH_TOOLS, shortcutLabelFor } from '../../../lib/workbenchShortcuts.js'
import ToolIconTile from './ToolIconTile.jsx'
import { TOOL_GLYPHS } from './workbenchToolGlyphs.js'

const BUTTON = 'flex h-7 w-7 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent'
const MENU_ITEM = 'flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs text-ink-soft hover:bg-paper-2'
const MENU = 'absolute right-0 top-8 z-30 w-52 rounded-card border border-ink/10 bg-paper p-1 shadow-xl'
// The side chat is the tool people reach for most, so it keeps a direct button;
// the other two live one click away behind the dots menu (and their own keys).
const MENU_TOOLS = WORKBENCH_TOOLS.filter((tool) => tool.id !== 'chat')

function toolTitle(tool, t) {
  const label = t(tool.labelKey)
  const shortcut = shortcutLabelFor(tool)
  return shortcut ? t('workbench.toolWithShortcut', { label, shortcut }) : label
}

/**
 * The workbench action bar: back/forward walk between the entry page and the
 * tool you came from, the pencil opens the task list, the bubble is the side
 * chat, the arrow resets the panel width, the dots hold the remaining tools
 * and close, the squares copy the workspace path, the corners grow/shrink the
 * panel. Every control does a real job — no icon here is decoration.
 */
export default function WorkbenchToolbar({
  activeTab,
  contributedTabs = [],
  onClose,
  onResetWidth,
  onTabChange,
  onToggleExpand,
  panelExpanded = false,
  t,
  workspacePath = '',
}) {
  const [forwardTo, setForwardTo] = useState(null)
  const menuRef = useRef(null)
  const goBack = () => {
    if (activeTab === 'entry') return
    if (WORKBENCH_TOOLS.some((tool) => tool.id === activeTab)) setForwardTo(activeTab)
    onTabChange?.('entry')
  }
  const goForward = () => {
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
    <nav data-testid="workbench-tool-switch" aria-label={t('workbench.tools')} className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto">
      <button type="button" data-testid="workbench-tool-entry" disabled={activeTab === 'entry'}
        onClick={goBack} aria-label={t('workbench.entryBack')} title={t('workbench.entryBack')} className={BUTTON}>
        <ChevronLeft className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      </button>
      <button type="button" data-testid="workbench-tool-forward" disabled={!forwardTo}
        onClick={goForward} aria-label={t('workbench.entryForward')} title={t('workbench.entryForward')} className={BUTTON}>
        <ChevronRight className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      </button>
      <span className="mx-1 h-4 w-px bg-ink/10" aria-hidden="true" />
      <button type="button" data-tool="chat" data-testid="workbench-tool-chat"
        aria-current={activeTab === 'chat' ? 'page' : undefined}
        aria-label={toolTitle(WORKBENCH_TOOLS.find((tool) => tool.id === 'chat'), t)}
        title={toolTitle(WORKBENCH_TOOLS.find((tool) => tool.id === 'chat'), t)}
        onClick={() => pickTool('chat')}
        className={`flex h-7 w-7 items-center justify-center rounded-control transition-colors ${activeTab === 'chat' ? 'bg-ink/[0.07] ring-1 ring-ink/15' : 'hover:bg-ink/5'}`}>
        <ToolIconTile icon={TOOL_GLYPHS.chat} size="sm" toolId="chat" />
      </button>
      <span className="mx-1 h-4 w-px bg-ink/10" aria-hidden="true" />
      <button type="button" data-testid="workbench-tool-reset" onClick={onResetWidth}
        aria-label={t('workbench.resetWidth')} title={t('workbench.resetWidth')} className={BUTTON}>
        <RotateCcw className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      </button>
      <details ref={menuRef} className="relative" onKeyDown={(event) => { if (event.key === 'Escape') closeMenu() }}>
        <summary data-testid="workbench-tool-more" title={t('workbench.moreActions')} aria-label={t('workbench.moreActions')}
          className={`${BUTTON} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
          <MoreVertical className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
        </summary>
        <div role="menu" aria-label={t('workbench.moreActions')} className={MENU}>
          {MENU_TOOLS.map((tool) => (
            <button key={tool.id} type="button" role="menuitem" data-tool={tool.id}
              data-testid={`workbench-tool-${tool.id}`} title={toolTitle(tool, t)} onClick={() => pickTool(tool.id)}
              className={MENU_ITEM}>
              <ToolIconTile icon={TOOL_GLYPHS[tool.id]} size="sm" toolId={tool.id} />
              <span className="min-w-0 flex-1">{t(tool.labelKey)}</span>
            </button>
          ))}
          {contributedTabs.map((contribution) => (
            <button key={contribution.key} type="button" role="menuitem" data-tool={contribution.tabId}
              data-ui-plugin={contribution.pluginId} data-testid={`workbench-tool-${contribution.tabId}`}
              title={contribution.labelKey ? t(contribution.labelKey) : contribution.label}
              onClick={() => pickTool(contribution.tabId)} className={MENU_ITEM}>
              <ToolIconTile icon={contribution.icon} size="sm" toolId="fallback" />
              <span className="min-w-0 flex-1">{contribution.labelKey ? t(contribution.labelKey) : contribution.label}</span>
            </button>
          ))}
          <span className="my-1 block h-px bg-ink/10" aria-hidden="true" />
          <button type="button" role="menuitem" data-testid="workbench-close" onClick={() => { pickTool(activeTab); onClose?.() }}
            className={MENU_ITEM}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('workbench.close')}</span>
          </button>
        </div>
      </details>
      <button type="button" data-testid="workbench-tool-copy" disabled={!workspacePath}
        onClick={() => { if (workspacePath) copyTextToClipboard(workspacePath) }}
        aria-label={t('workbench.copyWorkspace')} title={t('workbench.copyWorkspace')} className={BUTTON}>
        <Copy className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
      </button>
      <button type="button" data-testid="workbench-tool-expand" aria-pressed={panelExpanded} onClick={() => onToggleExpand?.()}
        aria-label={t(panelExpanded ? 'workbench.collapsePanel' : 'workbench.expandPanel')}
        title={t(panelExpanded ? 'workbench.collapsePanel' : 'workbench.expandPanel')} className={BUTTON}>
        {panelExpanded
          ? <Minimize2 className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          : <Maximize2 className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />}
      </button>
    </nav>
  )
}
