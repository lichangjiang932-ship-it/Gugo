import { COMPARE_MODES, compareLabel, WIRED_COMPARE_MODES } from '../../../../lib/diffReviewModel.js'

/** Secondary reading options live with the file list, not in the resident toolbar. */
export default function DiffReadingControls({ contentMode, onContentModeChange, target, onTargetChange, t }) {
  return <div className="shrink-0 space-y-2 border-b border-ink/10 px-2 py-2" data-testid="diff-reading-controls">
    <div role="group" aria-label={t('diffReview.displayMode')} className="flex items-center gap-1 rounded-control bg-paper-2 p-0.5 text-xs">
      {['diff', 'file'].map(mode => <button key={mode} type="button" data-testid={`diff-mode-${mode}`}
        aria-pressed={contentMode === mode} onClick={() => onContentModeChange?.(mode)}
        className={`h-7 min-w-0 flex-1 rounded-control px-2 outline-none focus-visible:ring-2 focus-visible:ring-focus/30 ${contentMode === mode ? 'bg-paper text-ink shadow-sm' : 'text-ink-fade hover:text-ink'}`}>
        {t(mode === 'diff' ? 'diffReview.modeDiff' : 'diffReview.modeFile')}
      </button>)}
    </div>
    <label className="flex items-center gap-2 text-xs text-ink-fade">
      <span className="shrink-0">{t('diffReview.comparisonTarget')}</span>
      <select data-testid="diff-target-select" value={target.mode} onChange={event => onTargetChange?.({ ...target, mode: event.target.value })}
        className="h-8 min-w-0 flex-1 rounded-control border border-ink/10 bg-paper px-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus/30">
        {COMPARE_MODES.map(mode => <option key={mode} value={mode} disabled={!WIRED_COMPARE_MODES.includes(mode)} data-testid={`diff-target-${mode}`}>
          {compareLabel({ ...target, mode }, t)}
        </option>)}
      </select>
    </label>
    {target.mode === 'branch' && <input value={target.branch || ''} data-testid="diff-branch-input"
      aria-label={t('diffReview.compareAgainst')} placeholder="main" onChange={event => onTargetChange?.({ ...target, branch: event.target.value })}
      className="h-8 w-full rounded-control border border-ink/15 bg-paper px-2 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus/30" />}
  </div>
}
