import { useEffect, useState } from 'react'
import { getAuthToken } from '../../lib/accountClient.js'
import { searchSessionMessages } from '../../lib/sessionClient.js'

function mergeResults(primary, fallback) {
  const seen = new Set()
  return [...primary, ...fallback].filter((result) => {
    const key = `${result.sessionId}:${result.messageId || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 50)
}

export default function useSessionSearchResults({ open, query, localResults, t }) {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return undefined
    const trimmed = query.trim()
    let cancelled = false
    const timer = window.setTimeout(async () => {
      if (cancelled) return
      if (!trimmed || !getAuthToken()) {
        setResults(trimmed ? localResults : [])
        setError('')
        setLoading(false)
        return
      }
      setLoading(true)
      setError('')
      try {
        const data = await searchSessionMessages({ query: trimmed, limit: 50 })
        if (cancelled) return
        setResults(mergeResults(Array.isArray(data.results) ? data.results : [], localResults))
      } catch (cause) {
        if (cancelled) return
        setResults(localResults)
        setError(cause?.message || t('sessionSearch.failed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, trimmed ? 250 : 0)
    // Clearing only the timer is insufficient once its async request started.
    // A late response must not replace a newer query or a reopened dialog.
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [open, query, localResults, t])

  return { results, loading, error }
}
