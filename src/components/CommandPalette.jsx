import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '../lib/router.jsx'
import { Search, ChevronRight, Sparkles, Wand2, Plug, BookOpen } from 'lucide-react'
import { useAppContext } from '../store/AppContext'
import { listCommands, fuzzySearch } from '../lib/commandRegistry.js'
import { getRecentCommands, recordCommandUse } from '../lib/commandHistory.js'
import { useT } from '../i18n/I18nProvider.jsx'

function KindIcon({ kind }) {
  if (kind === 'skill') return <Sparkles className="w-3.5 h-3.5" />
  if (kind === 'mcp') return <Plug className="w-3.5 h-3.5" />
  if (kind === 'macro') return <BookOpen className="w-3.5 h-3.5" />
  return <Wand2 className="w-3.5 h-3.5" />
}

export default function CommandPalette() {
  const { t } = useT()
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [message, setMessage] = useState('')
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const openPalette = () => {
    setQuery('')
    setSelectedIdx(0)
    setMessage('')
    setOpen(true)
  }

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (open) setOpen(false)
        else openPalette()
      } else if (e.key === 'Escape' && open) {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const timer = window.setTimeout(() => inputRef.current?.focus(), 10)
    return () => window.clearTimeout(timer)
  }, [open])

  const allCommands = listCommands()
  const results = useMemo(() => {
    if (!query.trim()) {
      const recents = getRecentCommands(8)
      const recentIds = new Set(recents.map((r) => r.id))
      const recentCmds = recents
        .map((r) => allCommands.find((c) => c.id === r.id))
        .filter(Boolean)
      const rest = allCommands.filter((c) => !recentIds.has(c.id))
      return [...recentCmds, ...rest].map((cmd) => ({ cmd, score: 50 }))
    }
    return fuzzySearch(allCommands, query)
  }, [allCommands, query])

  const filtered = results.slice(0, 60)
  const safeSelectedIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1))

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const el = list.children?.[safeSelectedIdx]
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [safeSelectedIdx])

  const execute = (cmd) => {
    recordCommandUse(cmd.id)
    setOpen(false)
    if (cmd.kind === 'skill') {
      window.dispatchEvent(new CustomEvent('command-palette:prefill', { detail: `/${cmd.id} ` }))
      return
    }
    if (typeof cmd.handler === 'function') {
      try {
        const ret = cmd.handler({ args: {}, dispatch, navigate, state, notify: setMessage })
        if (typeof ret === 'string') {
          window.dispatchEvent(new CustomEvent('command-palette:prefill', { detail: ret }))
        }
      } catch (err) {
        setMessage(err?.message || t('errors.unknown'))
      }
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered[safeSelectedIdx]?.cmd
      if (cmd) execute(cmd)
    }
  }

  if (!open) return message ? <div className="sr-only" aria-live="polite">{message}</div> : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-[600px] mx-4 bg-paper border border-ink/15 rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-ink/10">
          <Search className="w-4 h-4 text-ink-fade shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIdx(0) }}
            onKeyDown={handleKeyDown}
            placeholder={`${t('slash.menuLabel')}…`}
            aria-label={t('slash.menuLabel')}
            className="flex-1 bg-transparent outline-none text-sm text-ink placeholder:text-ink-fade"
          />
          <kbd className="font-mono text-[10px] text-ink-fade border border-ink/15 rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        <div ref={listRef} className="max-h-[400px] overflow-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ink-fade">{t('slash.noMatches')}</div>
          ) : (
            filtered.map(({ cmd }, idx) => (
              <button
                key={`${cmd.kind}:${cmd.id}`}
                type="button"
                onClick={() => execute(cmd)}
                onMouseEnter={() => setSelectedIdx(idx)}
                className={`w-full text-left flex items-center gap-3 px-4 py-2.5 transition-colors ${
                  idx === safeSelectedIdx ? 'bg-accent/10' : 'hover:bg-paper-2'
                }`}
              >
                <span className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                  cmd.kind === 'skill' ? 'bg-amber-50 text-amber-700'
                    : cmd.kind === 'mcp' ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-paper-2 text-ink-fade'
                }`}
                >
                  <KindIcon kind={cmd.kind} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-accent-ink">/{cmd.id}</span>
                    <span className="text-[10px] uppercase tracking-wider text-ink-fade">{cmd.kind}</span>
                  </div>
                  {cmd.description && <div className="text-xs text-ink-fade truncate mt-0.5">{cmd.description}</div>}
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-ink-fade shrink-0" />
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-ink/10 text-[10px] text-ink-fade bg-paper-2/50">
          <span><kbd className="font-mono">↑↓</kbd> {t('slash.navigate')}</span>
          <span><kbd className="font-mono">Enter</kbd> {t('slash.select')}</span>
          <span className="ml-auto">{filtered.length} / {allCommands.length}</span>
        </div>
      </div>
    </div>
  )
}
