import {
  Files,
  Globe2,
  MessageSquare,
  RotateCcw,
  TerminalSquare,
  X,
} from 'lucide-react'
import { clampWidth, MIN_WIDTH } from './rightWorkbenchLayout.js'

const TABS = { files: Files, chat: MessageSquare, browser: Globe2, terminal: TerminalSquare }

export default function RightWorkbenchFrame({
  activeTab,
  artifacts,
  beginResize,
  contributedTabs,
  isGenerating,
  onClose,
  onResetWidth,
  onTabChange,
  panelWidth,
  resizeWithKeyboard,
  statusMessage,
  t,
}) {
  return (
    <>
      <button
        type="button"
        data-testid="workbench-resize-handle"
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none bg-transparent outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-accent/50 focus-visible:after:bg-focus"
        aria-label={t('workbench.resize')}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={clampWidth(Number.MAX_SAFE_INTEGER)}
        aria-valuenow={panelWidth}
        aria-orientation="vertical"
        role="separator"
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={onResetWidth}
      />

      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink/10 px-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-xs font-semibold text-ink">{t('workbench.title')}</h2>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-pill ${isGenerating ? 'animate-pulse bg-running' : 'bg-success'}`} aria-hidden="true" />
          </div>
          <p className="mt-0.5 truncate text-xs leading-5 text-ink-fade" title={statusMessage || undefined}>
            {statusMessage || t(isGenerating ? 'workbench.active' : 'workbench.ready')}
          </p>
        </div>
        <button
          type="button"
          onClick={onResetWidth}
          aria-label={t('workbench.resetWidth')}
          title={t('workbench.resetWidth')}
          className="flex h-7 w-7 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button type="button" data-testid="workbench-close" onClick={onClose} aria-label={t('workbench.close')} title={t('workbench.close')} className="flex h-7 w-7 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink"><X className="h-4 w-4" /></button>
      </header>

      <nav data-testid="workbench-navigation" className="flex h-10 shrink-0 items-stretch gap-1 border-b border-ink/10 px-2" aria-label={t('workbench.show')}>
        {Object.entries(TABS).map(([tab, Icon]) => (
          <button
            key={tab}
            type="button"
            data-testid={`workbench-tab-${tab}`}
            onClick={() => onTabChange(tab)}
            aria-current={activeTab === tab ? 'page' : undefined}
            aria-label={t(`workbench.${tab}`)}
            title={t(`workbench.${tab}`)}
            className={`group relative flex min-w-0 flex-1 items-center justify-center gap-1.5 border-b-2 px-1 text-xs transition-colors ${activeTab === tab ? 'border-accent text-accent-ink' : 'border-transparent text-ink-fade hover:text-ink'}`}
          >
            <Icon className="h-[18px] w-[18px] shrink-0" />
            <span className="sr-only">{t(`workbench.${tab}`)}</span>
            {tab === 'files' && artifacts.length > 0 && <span data-testid="workbench-file-count" data-compact-numeric-badge className="min-w-4 rounded-pill bg-ink/[0.08] px-1 py-0.5 text-center text-[9px] font-semibold leading-none text-ink-soft">{artifacts.length}</span>}
          </button>
        ))}
        {contributedTabs.map((contribution) => {
          const Icon = contribution.icon || Files
          const label = contribution.labelKey ? t(contribution.labelKey) : contribution.label
          return <button
            key={contribution.key}
            type="button"
            data-testid={`workbench-tab-${contribution.tabId}`}
            data-ui-plugin={contribution.pluginId}
            onClick={() => onTabChange(contribution.tabId)}
            aria-current={activeTab === contribution.tabId ? 'page' : undefined}
            aria-label={label}
            title={label}
            className={`group relative flex min-w-0 flex-1 items-center justify-center border-b-2 px-1 text-xs transition-colors ${activeTab === contribution.tabId ? 'border-accent text-accent-ink' : 'border-transparent text-ink-fade hover:text-ink'}`}
          ><Icon className="h-[18px] w-[18px] shrink-0" /><span className="sr-only">{label}</span></button>
        })}
      </nav>
    </>
  )
}
