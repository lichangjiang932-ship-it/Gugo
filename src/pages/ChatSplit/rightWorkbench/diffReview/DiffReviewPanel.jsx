import { useEffect, useState } from 'react'
import { filesFromStatusPayload } from '../../../../lib/diffReviewModel.js'
import DiffToolbar from './DiffToolbar.jsx'

const DEFAULT_TARGET = Object.freeze({ mode: 'uncommitted', branch: 'main' })
const DEFAULT_VIEW = Object.freeze({
  showFiles: true,
  groupByFolder: true,
  separateSpecial: false,
  sideBySide: false,
  wordWrap: true,
  highlightWords: true,
  hideWhitespace: false,
})

/**
 * The docked review panel: the reviewer chrome on top, the changed files on the
 * left, the selected file's diff on the right.
 *
 * Stage 2 ships the layout and the real file list; the diff body, the tree
 * grouping and the inline comments arrive in the next stages. Every control in
 * the toolbar already does something — nothing here is a placeholder icon.
 */
export default function DiffReviewPanel({ onClose, onExpandToggle, panelExpanded = false, t }) {
  const [target, setTarget] = useState(DEFAULT_TARGET)
  const [view, setView] = useState(DEFAULT_VIEW)
  const [files, setFiles] = useState([])
  const [status, setStatus] = useState('loading')
  const [refreshToken, setRefreshToken] = useState(0)
  const [searchTerm, setSearchTerm] = useState('')
  const [selected, setSelected] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/workbench/git/status')
        const payload = await response.json().catch(() => null)
        if (cancelled) return
        setFiles(filesFromStatusPayload(payload))
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    }
    void load()
    return () => { cancelled = true }
  }, [refreshToken])

  const needle = searchTerm.trim().toLowerCase()
  const visible = needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="diff-review-panel" data-target-mode={target.mode} data-status={status}>
      <DiffToolbar
        compact={!panelExpanded}
        onClose={onClose}
        onExpandToggle={onExpandToggle}
        onRefresh={() => setRefreshToken((token) => token + 1)}
        onSearchChange={setSearchTerm}
        onTargetChange={setTarget}
        onToggleFiles={() => setView((current) => ({ ...current, showFiles: !current.showFiles }))}
        onViewChange={setView}
        searchTerm={searchTerm}
        t={t}
        target={target}
        view={view}
      />
      <div className="flex min-h-0 flex-1">
        {view.showFiles && (
          <aside className="min-h-0 w-[46%] max-w-[320px] shrink-0 overflow-y-auto border-r border-ink/10 p-2" data-testid="diff-file-pane">
            {status === 'error' && <p role="alert" className="px-2 py-3 text-xs text-danger">{t('diffReview.failed')}</p>}
            {status === 'loading' && <p className="px-2 py-3 text-xs text-ink-fade">{t('diffReview.loading')}</p>}
            {status === 'ready' && visible.length === 0 && (
              <p className="px-2 py-3 text-xs leading-5 text-ink-fade" data-testid="diff-tree-empty">{t('diffReview.emptyTree')}</p>
            )}
            {visible.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {visible.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      data-testid="diff-file-row"
                      data-path={file.path}
                      aria-current={selected === file.path ? 'true' : undefined}
                      title={file.path}
                      onClick={() => setSelected(file.path)}
                      className={`flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs transition-colors ${
                        selected === file.path ? 'bg-[var(--color-selected)] text-ink' : 'text-ink-soft hover:bg-[var(--color-row-hover)]'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate" dir="rtl">{file.path}</span>
                      <span className="shrink-0 font-mono text-accent">+{file.additions}</span>
                      <span className="shrink-0 font-mono text-danger">−{file.deletions}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
        <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="diff-viewer-pane">
          {selected
            ? <p className="text-xs text-ink-fade" data-testid="diff-viewer-pending">{t('diffReview.loading')}</p>
            : <p className="text-xs text-ink-fade" data-testid="diff-empty">{t('diffReview.emptyDiff')}</p>}
        </div>
      </div>
    </section>
  )
}
