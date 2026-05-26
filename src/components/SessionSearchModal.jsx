import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, Search, User, X } from 'lucide-react'
import { useAppContext } from '../store/AppContext.jsx'
import { getAuthToken } from '../lib/accountClient.js'
import { searchSessionMessages } from '../lib/sessionClient.js'
import { useT } from '../i18n/I18nProvider.jsx'

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .filter(Boolean)
    .join(' ')
}

function localSnippet(text, query) {
  const haystack = String(text || '')
  const needle = String(query || '').trim()
  if (!haystack || !needle) return ''
  const lower = haystack.toLowerCase()
  const idx = lower.indexOf(needle.toLowerCase())
  if (idx < 0) return haystack.slice(0, 140)
  const start = Math.max(0, idx - 48)
  const end = Math.min(haystack.length, idx + needle.length + 72)
  return `${start > 0 ? '…' : ''}${haystack.slice(start, idx)}<mark>${haystack.slice(idx, idx + needle.length)}</mark>${haystack.slice(idx + needle.length, end)}${end < haystack.length ? '…' : ''}`
}

function buildLocalResults(sessions, query) {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return []
  const results = []
  for (const session of sessions || []) {
    for (const message of session.messages || []) {
      const text = messageText(message.content)
      if (!text.toLowerCase().includes(trimmed) && !String(session.title || '').toLowerCase().includes(trimmed)) continue
      results.push({
        messageId: message.id,
        sessionId: session.id,
        sessionTitle: session.title || 'Untitled',
        role: message.role || 'assistant',
        snippet: localSnippet(text || session.title, query),
        createdAt: message.timestamp || session.updatedAt || session.createdAt || Date.now(),
        rank: results.length,
      })
      break
    }
    if (results.length >= 50) break
  }
  return results
}

function mergeResults(primary, fallback) {
  const seen = new Set()
  const merged = []
  for (const result of [...(primary || []), ...(fallback || [])]) {
    const key = `${result.sessionId}:${result.messageId || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(result)
  }
  return merged
}

function HighlightedSnippet({ value }) {
  const parts = String(value || '').split(/(<mark>|<\/mark>)/g)
  const segments = parts.reduce((acc, part) => {
    if (part === '<mark>') return { ...acc, marked: true }
    if (part === '</mark>') return { ...acc, marked: false }
    if (!part) return acc
    return { ...acc, items: [...acc.items, { text: part, marked: acc.marked }] }
  }, { marked: false, items: [] }).items
  return (
    <>
      {segments.map((segment, index) => {
        return segment.marked
          ? <mark key={index} className="bg-ember-soft text-ember rounded px-0.5">{segment.text}</mark>
          : <span key={index}>{segment.text}</span>
      })}
    </>
  )
}

export default function SessionSearchModal() {
  const { state, dispatch } = useAppContext()
  const navigate = useNavigate()
  const { t } = useT()
  const inputRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const localResults = useMemo(() => buildLocalResults(state.sessions, query), [state.sessions, query])

  useEffect(() => {
    const openSearch = () => setOpen(true)
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
      }
      if (event.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('session-search:open', openSearch)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('session-search:open', openSearch)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const trimmed = query.trim()
    if (!trimmed) {
      const timer = window.setTimeout(() => {
        setResults([])
        setError('')
        setLoading(false)
      }, 0)
      return () => window.clearTimeout(timer)
    }

    const timer = window.setTimeout(async () => {
      if (!getAuthToken()) {
        setResults(localResults)
        setError('')
        return
      }
      setLoading(true)
      setError('')
      try {
        const data = await searchSessionMessages({ query: trimmed, limit: 50 })
        setResults(mergeResults(Array.isArray(data.results) ? data.results : [], localResults).slice(0, 50))
      } catch (err) {
        setResults(localResults)
        setError(err?.message || t('sessionSearch.failed'))
      } finally {
        setLoading(false)
      }
    }, 250)

    return () => window.clearTimeout(timer)
  }, [open, query, localResults, t])

  if (!open) return null

  const shownResults = query.trim() && !getAuthToken() ? localResults : results

  const openResult = (result) => {
    dispatch({ type: 'SWITCH_SESSION', payload: result.sessionId })
    const hash = result.messageId ? `#message-${encodeURIComponent(result.messageId)}` : ''
    navigate(`/chat${hash}`)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="fixed inset-0 z-[70] bg-ink/35 flex items-start justify-center px-4 pt-[12vh]" onMouseDown={() => setOpen(false)}>
      <div
        className="w-full max-w-2xl bg-paper border border-ink rounded-md shadow-xl overflow-hidden"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="h-12 px-4 border-b border-ink-fade/30 flex items-center gap-3">
          <Search className="w-4 h-4 text-ink-fade" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('sessionSearch.placeholder')}
            className="flex-1 h-full bg-transparent outline-none text-sm text-ink placeholder:text-ink-fade"
          />
          <span className="font-mono text-[10px] text-ink-fade border border-ink-fade/40 rounded px-1.5 py-0.5">Esc</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1 rounded hover:bg-paper-2 text-ink-fade hover:text-ink"
            title={t('common.cancel')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[56vh] overflow-y-auto p-2">
          {loading && (
            <div className="px-3 py-6 text-center text-xs text-ink-fade">{t('common.loading')}</div>
          )}
          {!loading && query.trim() && shownResults.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-ink-fade">{t('sessionSearch.empty')}</div>
          )}
          {!loading && !query.trim() && (
            <div className="px-3 py-8 text-center text-xs text-ink-fade">{t('sessionSearch.hint')}</div>
          )}
          {!loading && shownResults.map((result) => {
            const Icon = result.role === 'user' ? User : Bot
            return (
              <button
                key={`${result.sessionId}:${result.messageId}`}
                type="button"
                onClick={() => openResult(result)}
                className="w-full flex items-start gap-3 px-3 py-2.5 rounded-md text-left hover:bg-paper-2 transition-colors"
              >
                <div className="w-7 h-7 rounded-md border border-ink-fade/40 flex items-center justify-center text-ink-fade shrink-0">
                  <Icon className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ink truncate">{result.sessionTitle}</span>
                    <span className="font-mono text-[10px] text-ink-fade shrink-0">{result.role}</span>
                    <span className="text-[11px] text-ink-fade shrink-0">
                      {new Date(result.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-soft line-clamp-2">
                    <HighlightedSnippet value={result.snippet} />
                  </p>
                </div>
              </button>
            )
          })}
        </div>
        {error && (
          <div className="px-4 py-2 border-t border-ink-fade/30 text-[11px] text-ink-fade">
            {t('sessionSearch.localFallback')} · {error}
          </div>
        )}
      </div>
    </div>
  )
}
