import { useEffect, useRef, useState } from 'react'
import { GitFork, LoaderCircle } from 'lucide-react'
import { getSessionBranchesRemote } from '../../../lib/sessionClient.js'

export default function SessionBranchNavigator({ sessionId, onOpenSession, t }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [branches, setBranches] = useState([])
  const [error, setError] = useState('')
  const hostRef = useRef(null)
  const requestRef = useRef(0)

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsidePointer = (event) => {
      if (!hostRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => () => { requestRef.current += 1 }, [])

  if (!sessionId) return null

  const toggle = async () => {
    if (open) {
      setOpen(false)
      return
    }
    const requestId = ++requestRef.current
    setOpen(true)
    setLoading(true)
    setError('')
    try {
      const result = await getSessionBranchesRemote(sessionId)
      if (requestRef.current !== requestId) return
      setBranches(Array.isArray(result?.branches) ? result.branches : [])
    } catch (loadError) {
      if (requestRef.current !== requestId) return
      setBranches([])
      setError(String(loadError?.message || t('nav.branchLoadFailed')))
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }

  const selectBranch = (branch) => {
    setOpen(false)
    if (branch?.id && branch.id !== sessionId) onOpenSession?.(branch)
  }

  return (
    <div ref={hostRef} className="relative shrink-0">
      <button
        type="button"
        className="chat-chrome-button inline-flex h-8 w-8 items-center justify-center rounded-control text-ink-fade hover:text-ink"
        aria-label={t('nav.branchNavigator')}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="session-branch-navigator"
        onClick={toggle}
        title={t('nav.branchNavigator')}
      >
        <GitFork className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('nav.branchNavigator')}
          className="absolute right-0 top-9 z-30 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-ink/10 bg-paper shadow-xl"
          data-testid="session-branch-menu"
        >
          <div className="border-b border-ink/8 px-3 py-2 text-xs font-medium text-ink-soft">
            {t('nav.branchNavigator')}
          </div>
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-ink-fade" role="status">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t('nav.branchLoading')}
            </div>
          ) : error ? (
            <div className="px-3 py-3 text-xs text-danger" role="alert">{error}</div>
          ) : (
            <div className="max-h-72 overflow-y-auto p-1">
              {branches.map((branch) => {
                const current = branch.id === sessionId
                const depth = Math.max(0, Math.min(5, Number(branch.depth) || 0))
                const branchName = depth === 0
                  ? t('nav.branchRoot')
                  : branch.branchLabel || t('nav.branchUntitled')
                const branchSummary = String(branch.branchSummary || branch.title || t('nav.untitledSession'))
                const fileOperations = Array.isArray(branch.fileOperations) ? branch.fileOperations : []
                const fileOperationText = fileOperations.map((operation) => {
                  const filename = String(operation?.path || '').split(/[\\/]/u).pop() || operation?.path
                  const marker = operation?.action === 'created'
                    ? '+'
                    : operation?.action === 'deleted' ? '−' : operation?.action === 'modified' ? '~' : '•'
                  return `${marker} ${filename}`
                }).join(', ')
                const fileOperationTitle = fileOperations
                  .map((operation) => `${operation.action}: ${operation.path} (${operation.toolName})`)
                  .join('\n')
                return (
                  <button
                    key={branch.id}
                    type="button"
                    role="menuitem"
                    data-branch-id={branch.id}
                    className={`flex w-full items-center gap-2 rounded-control py-2 pr-2 text-left text-xs hover:bg-ink/[0.05] ${current ? 'bg-ink/[0.045] text-ink' : 'text-ink-soft'}`}
                    style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
                    onClick={() => selectBranch(branch)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{branchName}</span>
                      <span className="block truncate text-ink-fade" title={branchSummary}>{branchSummary}</span>
                      {fileOperations.length > 0 && (
                        <span
                          className="block truncate text-[11px] text-ink-fade"
                          data-testid={`branch-file-operations-${branch.id}`}
                          title={fileOperationTitle}
                        >
                          {t('nav.branchFileChanges', { count: fileOperations.length })}: {fileOperationText}
                          {branch.fileOperationsTruncated === true ? ` ${t('nav.branchFileChangesIncomplete')}` : ''}
                        </span>
                      )}
                      {fileOperations.length === 0 && branch.fileOperationsTruncated === true && (
                        <span className="block truncate text-[11px] text-ink-fade">
                          {t('nav.branchFileChangesUnavailable')}
                        </span>
                      )}
                    </span>
                    {current && <span className="shrink-0 text-[11px] text-accent-ink">{t('nav.branchCurrent')}</span>}
                  </button>
                )
              })}
              {branches.length === 0 && (
                <div className="px-2 py-3 text-xs text-ink-fade">{t('nav.branchEmpty')}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
