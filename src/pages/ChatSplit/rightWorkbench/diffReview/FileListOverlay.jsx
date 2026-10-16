import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import FileTypeGlyph from '../../../../components/FileTypeGlyph.jsx'
import FileNameLabel from '../../../../components/FileNameLabel.jsx'
import { isCompositionEvent } from '../../../../lib/compositionEvent.js'
import { getAuthToken } from '../../../../lib/accountClient.js'

/** Shared picker: Changes supplies exact paths; the file workspace browses its authorized folder. */
function authHeaders() {
  const token = getAuthToken?.()
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

const EXTENSION_OF = (name) => {
  const value = String(name || '')
  const dot = value.lastIndexOf('.')
  return dot > 0 ? value.slice(dot + 1).toLowerCase() : 'file'
}

export default function FileListOverlay({ changed = [], entries: given = null, selectedPath = '', onClose, onPick, rootPath, t }) {
  const [state, setState] = useState({ key: '', entries: [], error: '' })
  const [term, setTerm] = useState('')
  const fieldRef = useRef(null)

  // A caller that already knows the list — the review, which shows only what the
  // conversation changed — hands it in. Without one, the folder is read, which is
  // what the workspace-files pane wants.
  const supplied = Array.isArray(given)
  useEffect(() => {
    if (supplied || !rootPath) return undefined
    let cancelled = false
    Promise.resolve()
      .then(async () => {
        const response = await fetch('/api/tools/fs/list', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ path: rootPath, limit: 500 }),
        })
        const payload = await response.json().catch(() => null)
        if (cancelled) return
        if (!response.ok || payload?.ok === false) {
          setState({ key: rootPath, entries: [], error: String(payload?.error || `HTTP ${response.status}`) })
          return
        }
        const entries = (Array.isArray(payload?.entries) ? payload.entries : [])
          .filter((entry) => entry?.type === 'file')
          .map((entry) => ({ name: String(entry.name || ''), size: entry.size ?? null }))
        setState({ key: rootPath, entries, error: '' })
      })
      .catch((error) => { if (!cancelled) setState({ key: rootPath, entries: [], error: String(error?.message || error) }) })
    return () => { cancelled = true }
  }, [rootPath, supplied])

  useEffect(() => {
    const previous = document.activeElement
    fieldRef.current?.focus?.()
    return () => { if (previous?.isConnected) previous.focus?.() }
  }, [])

  // A file's changed-ness is asked of its full path: the list gives names, the
  // change set gives paths, and comparing names alone would mark a file changed
  // because something of the same name moved elsewhere.
  const marks = useMemo(() => {
    const byPath = new Map()
    for (const file of changed) {
      const path = String(file?.path || '')
      if (path) byPath.set(path.replace(/\\/gu, '/'), file)
    }
    return byPath
  }, [changed])

  const loaded = supplied || state.key === rootPath
  const all = useMemo(() => (supplied ? given : state.entries).map(entry => {
    const root = String(rootPath || '').replace(/\\/gu, '/').replace(/\/+$/u, '')
    const path = entry.path || (rootPath ? String(rootPath).replace(/[\\/]+$/u, '') + (rootPath.includes('\\') ? '\\' : '/') : '') + entry.name
    const normalized = String(entry.displayPath || path).replace(/\\/gu, '/')
    const displayPath = root && normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : normalized
    return { ...entry, path, name: entry.name || normalized.split('/').pop() || '', displayPath, parent: displayPath.includes('/') ? displayPath.slice(0, displayPath.lastIndexOf('/')) : '' }
  }), [given, rootPath, state.entries, supplied])
  const needle = term.trim().toLowerCase()
  const visible = needle
    ? all.filter((entry) => entry.name.toLowerCase().includes(needle) || entry.displayPath.toLowerCase().includes(needle))
    : all
  const failed = !supplied && Boolean(state.error)

  return (
    <div data-testid="diff-file-list" role="dialog" aria-label={t('diffReview.showFiles')} onKeyDown={event => {
      if (event.key === 'Escape' && !isCompositionEvent(event)) { event.preventDefault(); event.stopPropagation(); onClose?.() }
    }} className="absolute inset-y-0 left-0 z-20 flex w-[min(280px,100%)] flex-col border-r border-ink/10 bg-surface shadow-xl">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ink/10 px-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" />
        <input
          ref={fieldRef}
          type="text"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('diffReview.filterFiles')}
          aria-label={t('diffReview.filterFiles')}
          className="h-7 min-w-0 flex-1 border-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-fade"
        />
        <button
          type="button"
          onClick={onClose}
          data-testid="diff-file-list-close"
          aria-label={t('diffReview.hideFiles')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/[0.06] hover:text-ink"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {!supplied && !rootPath && <p className="p-3 text-xs leading-5 text-ink-fade">{t('diffReview.fileListNoFolder')}</p>}
        {!supplied && rootPath && !loaded && <p className="p-3 text-xs leading-5 text-ink-fade">{t('diffReview.loading')}</p>}
        {failed && <p role="alert" className="p-3 text-xs leading-5 text-danger">{state.error}</p>}
        {(supplied || (rootPath && loaded)) && !failed && visible.length === 0 && (
          <p className="p-3 text-xs leading-5 text-ink-fade">{t('diffReview.fileListEmpty')}</p>
        )}
        {visible.map((entry) => {
          const path = entry.path
          const mark = marks.get(path.replace(/\\/gu, '/'))
          return (
            <button
              key={path}
              type="button"
              data-testid="diff-file-list-row"
              data-changed={mark ? 'true' : undefined}
              aria-current={path === selectedPath ? 'true' : undefined}
              data-selected={path === selectedPath ? 'true' : undefined}
              onClick={() => onPick?.(path)}
              title={entry.displayPath}
              className={`flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs transition-colors ${path === selectedPath ? 'bg-[var(--color-selected)] text-ink' : 'text-ink-soft hover:bg-[var(--color-row-hover)] hover:text-ink'}`}
            >
              <FileTypeGlyph name={entry.name} size={14} type={EXTENSION_OF(entry.name)} />
              <span className="min-w-0 flex-1"><FileNameLabel value={entry.name} className="w-full" />
                {entry.parent && <span className="block truncate text-meta text-ink-fade">{entry.parent}</span>}
              </span>
              {mark && (Number(mark.additions) > 0 || Number(mark.deletions) > 0) && (
                <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums" aria-hidden="true">
                  <span className="text-success">+{mark.additions ?? 0}</span>
                  <span className="ml-1 text-danger">−{mark.deletions ?? 0}</span>
                </span>
              )}
              {/* A file a tool touched but that recorded no line-level edit still
                  belongs to the conversation's change set. Saying "+0 −0" beside
                  it is noise; a dot says "this one moved" and stops there. */}
              {mark && !(Number(mark.additions) > 0 || Number(mark.deletions) > 0) && (
                <span data-testid="file-list-changed-dot" className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-fade" aria-hidden="true" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
