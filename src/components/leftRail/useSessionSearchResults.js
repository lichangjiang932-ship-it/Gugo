import { useEffect, useRef, useState } from 'react'
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

export default function useSessionSearchResults({ open, query, localResults, getLocalResults, t }) {
  const [results, setResults] = useState([])
  const [error, setError] = useState('')
  const [settledQuery, setSettledQuery] = useState('')
  // A parent may rebuild this getter on every streamed token because it closes
  // over the session list. Reading it through a ref keeps that identity churn
  // from restarting the debounce while the user is searching.
  const getLocalResultsRef = useRef(getLocalResults)
  const localResultsRef = useRef(localResults)
  useEffect(() => {
    getLocalResultsRef.current = getLocalResults
    localResultsRef.current = localResults
  }, [getLocalResults, localResults])

  const trimmedQuery = query.trim()
  useEffect(() => {
    if (!open || !trimmedQuery) return undefined
    let cancelled = false
    const timer = window.setTimeout(async () => {
      if (cancelled) return
      let fallback = []
      try {
        // Local history can be large. Scan only once the same debounce that owns
        // the remote request has elapsed; preserve unsynced local fallbacks.
        fallback = getLocalResultsRef.current
          ? (getLocalResultsRef.current(trimmedQuery) || [])
          : (localResultsRef.current || [])
        if (!getAuthToken()) {
          if (cancelled) return
          setResults(fallback)
          setError('')
          return
        }
        const data = await searchSessionMessages({ query: trimmedQuery, limit: 50 })
        if (cancelled) return
        setResults(mergeResults(Array.isArray(data.results) ? data.results : [], fallback))
        setError('')
      } catch (cause) {
        if (cancelled) return
        setResults(fallback)
        setError(cause?.message || t('sessionSearch.failed'))
      } finally {
        // Settling after the result write prevents a frame where loading has
        // ended but the new result set has not rendered yet.
        if (!cancelled) setSettledQuery(trimmedQuery)
      }
    }, 250)
    // Clearing only the timer is insufficient once its async request started.
    // A late response must not replace a newer query or a reopened dialog.
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [open, trimmedQuery, t])

  // Derive loading instead of setting it synchronously in the effect: the first
  // render after typing is already a loading frame, with no empty-state flash.
  const loading = Boolean(trimmedQuery) && trimmedQuery !== settledQuery
  const visibleResults = !trimmedQuery || loading ? [] : results
  const visibleError = !trimmedQuery || loading ? '' : error
  return { results: visibleResults, loading, error: visibleError }
}
