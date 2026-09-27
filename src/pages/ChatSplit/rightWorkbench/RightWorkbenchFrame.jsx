import { clampWidth, MIN_WIDTH } from './rightWorkbenchLayout.js'

/**
 * The panel's frame: resize handle, title/status, and a slot for the action
 * bar. The bar itself is built by the panel (RightWorkbench) and passed in as
 * `toolbar`, so this file only knows where it sits, never what it does.
 */
export default function RightWorkbenchFrame({
  beginResize,
  isGenerating,
  onResetWidth,
  panelWidth,
  resizeWithKeyboard,
  statusMessage,
  t,
  toolbar,
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
        {toolbar}
      </header>
    </>
  )
}
