/* eslint-disable react-refresh/only-export-components -- compatibility module intentionally mirrors react-router-dom's component and hook exports */
import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const RouterContext = createContext(null)

function readHashLocation() {
  if (typeof window === 'undefined') return { pathname: '/', search: '', hash: '', state: null, key: 'ssr' }
  const raw = window.location.hash.slice(1) || '/'
  const anchorAt = raw.indexOf('#')
  const route = anchorAt >= 0 ? raw.slice(0, anchorAt) : raw
  const anchor = anchorAt >= 0 ? raw.slice(anchorAt) : ''
  const queryAt = route.indexOf('?')
  const pathname = (queryAt >= 0 ? route.slice(0, queryAt) : route) || '/'
  const search = queryAt >= 0 ? route.slice(queryAt) : ''
  return {
    pathname: pathname.startsWith('/') ? pathname : `/${pathname}`,
    search,
    hash: anchor,
    state: window.history.state,
    key: `${raw}:${window.history.length}`,
  }
}

function targetHash(to) {
  const value = String(to || '/').trim() || '/'
  return value.startsWith('/') ? value : `/${value}`
}

export function HashRouter({ children }) {
  const [location, setLocation] = useState(readHashLocation)

  useEffect(() => {
    const sync = () => setLocation(readHashLocation())
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    if (!window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/`)
    sync()
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])

  const navigate = useCallback((to, options = {}) => {
    if (typeof to === 'number') {
      window.history.go(to)
      return
    }
    const next = targetHash(to)
    const url = `${window.location.pathname}${window.location.search}#${next}`
    if (options.replace) {
      window.history.replaceState(options.state ?? null, '', url)
      setLocation(readHashLocation())
    } else {
      window.history.pushState(options.state ?? null, '', url)
      setLocation(readHashLocation())
    }
  }, [])

  const value = useMemo(() => ({ location, navigate }), [location, navigate])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

function useRouter() {
  const router = useContext(RouterContext)
  if (!router) throw new Error('Router hooks must be used inside <HashRouter>.')
  return router
}

export function useNavigate() {
  return useRouter().navigate
}

export function useLocation() {
  return useRouter().location
}

export function useSearchParams() {
  const { location, navigate } = useRouter()
  const params = useMemo(() => new URLSearchParams(location.search), [location.search])
  const setParams = useCallback((next, options = {}) => {
    const value = typeof next === 'function' ? next(new URLSearchParams(location.search)) : next
    const query = value instanceof URLSearchParams ? value.toString() : new URLSearchParams(value).toString()
    navigate(`${location.pathname}${query ? `?${query}` : ''}${location.hash || ''}`, options)
  }, [location, navigate])
  return [params, setParams]
}

export function Route() {
  return null
}

export function Routes({ children }) {
  const { pathname } = useLocation()
  let fallback = null
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue
    if (child.props.path === '*') {
      fallback = child.props.element ?? null
      continue
    }
    if (child.props.path === pathname) return child.props.element ?? null
  }
  return fallback
}

export function Navigate({ to, replace = false, state = null }) {
  const navigate = useNavigate()
  useEffect(() => { navigate(to, { replace, state }) }, [navigate, replace, state, to])
  return null
}

export function Link({ to, replace = false, state = null, onClick, target, children, ...props }) {
  const navigate = useNavigate()
  const href = `#${targetHash(to)}`
  const handleClick = (event) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to, { replace, state })
  }
  return <a {...props} href={href} target={target} onClick={handleClick}>{children}</a>
}
