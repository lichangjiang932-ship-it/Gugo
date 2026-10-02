import { useCallback, useEffect, useState } from 'react'
import { getDesktopBrowserHost } from '../lib/desktopBrowserClient.js'
import { isLocalWorkbenchPath, resolveBrowserInput } from '../lib/browserUrlPolicy.js'

const EMPTY_STATUS = Object.freeze({
  canGoBack: false,
  canGoForward: false,
  loading: false,
  title: '',
})

const RECENT_KEY = 'yma:workbench-browser-recent'
const RECENT_LIMIT = 6

function readRecent() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string').slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

function rememberRecent(list, url) {
  // Searches are not places worth returning to; addresses are.
  if (!url || url.startsWith('https://www.bing.com/search')) return list
  const next = [url, ...list.filter((entry) => entry !== url)].slice(0, RECENT_LIMIT)
  try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* storage is optional */ }
  return next
}

/** Fired by the preview server bar when a dev server becomes ready. */
export const BROWSER_OPEN_EVENT = 'workbench-browser:open'

/**
 * Drives whichever browser backend this build has.
 *
 * With a desktop host the panel reports its docking rectangle and the native
 * Chromium view is positioned over that area, so the page being browsed is never
 * inside the app's own document. Without one the same URL renders in a sandboxed
 * iframe — visibly worse, because sites are allowed to refuse, so the panel says
 * which backend is in use instead of leaving the reader to guess why a page is
 * blank.
 */
export default function useEmbeddedBrowser({ containerRef, active = true } = {}) {
  // The capability probe reads a global, so it is resolved once for the mount
  // rather than on every render.
  const [host] = useState(getDesktopBrowserHost)

  const [input, setInput] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState(EMPTY_STATUS)
  const [reloadKey, setReloadKey] = useState(0)
  const [recent, setRecent] = useState(readRecent)

  const applyStatus = useCallback((next) => {
    if (!next || typeof next !== 'object') return
    setStatus({
      canGoBack: next.canGoBack === true,
      canGoForward: next.canGoForward === true,
      loading: next.loading === true,
      title: String(next.title || ''),
    })
    // The page can navigate itself (a link, a redirect). The address bar has to
    // follow the real location, not the last thing that was typed into it.
    if (typeof next.url === 'string' && next.url) {
      setUrl((current) => (current === next.url ? current : next.url))
      setInput(next.url)
    }
  }, [])

  useEffect(() => {
    if (!host?.onUpdated) return undefined
    const unsubscribe = host.onUpdated(applyStatus)
    return () => { unsubscribe?.() }
  }, [applyStatus, host])

  // The view outlives this panel: switching tabs hides it rather than unloading
  // the page. A remounted panel therefore starts empty while a page is still
  // loaded, so it asks the main process what is really there before showing
  // anything, instead of presenting a blank address bar over a live view.
  useEffect(() => {
    if (!host?.state) return undefined
    let cancelled = false
    void host.state().then((result) => {
      if (cancelled) return
      applyStatus(result?.state)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [applyStatus, host])

  // Dock the native view onto the panel. It is shown exactly while its container
  // has real area and its view is the active one, so switching tabs hides the
  // view without tearing it down — the session and scroll position survive.
  useEffect(() => {
    if (!host?.setBounds) return undefined
    const element = containerRef?.current
    if (!element) return undefined
    let frame = 0
    const sync = () => {
      const rect = element.getBoundingClientRect()
      const usable = active && url && rect.width >= 1 && rect.height >= 1
      if (!usable) {
        host.setBounds(null)
        return
      }
      host.setBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    }
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; sync() })
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(element)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [active, containerRef, host, url])

  useEffect(() => () => { host?.hide?.() }, [host])

  const navigate = useCallback((rawValue) => {
    const resolved = resolveBrowserInput(rawValue)
    if (resolved.kind === 'empty') return false
    if (!resolved.url) {
      setError(resolved.kind === 'refused' && isLocalWorkbenchPath(rawValue) ? 'local' : 'invalid')
      return false
    }
    const nextUrl = resolved.url
    setError('')
    setInput(nextUrl)
    setUrl(nextUrl)
    setRecent((list) => rememberRecent(list, nextUrl))
    host?.navigate?.(nextUrl)
    return true
  }, [host])

  // A dev server that just became ready is opened here — unless the reader is
  // already looking at a page, which is theirs and is not replaced.
  useEffect(() => {
    const onOpen = (event) => {
      const target = String(event?.detail?.url || '')
      if (!target || (url && !event?.detail?.force)) return
      navigate(target)
    }
    window.addEventListener(BROWSER_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(BROWSER_OPEN_EVENT, onOpen)
  }, [navigate, url])

  const submit = useCallback((event) => {
    event?.preventDefault?.()
    navigate(input)
  }, [input, navigate])

  const goBack = useCallback(() => { host?.back?.() }, [host])
  const goForward = useCallback(() => { host?.forward?.() }, [host])
  const reload = useCallback(() => {
    if (host?.reload) host.reload()
    // Without a host the iframe is remounted, which is the only way to reload it.
    else setReloadKey((value) => value + 1)
  }, [host])
  const stop = useCallback(() => { host?.stop?.() }, [host])

  return {
    backend: host ? 'host' : 'frame',
    error,
    goBack,
    goForward,
    input,
    navigate,
    recent,
    reload,
    reloadKey,
    setInput,
    status,
    stop,
    submit,
    url,
  }
}
