import { useCallback, useEffect, useRef, useState } from 'react'

const COLLAPSED_KEY = 'gugo:left-rail-collapsed'
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

function initialCollapsed() {
  try { return window.localStorage?.getItem(COLLAPSED_KEY) === '1' } catch { return false }
}

function initialNarrowViewport(mediaQuery) {
  try { return window.matchMedia?.(mediaQuery)?.matches === true } catch { return false }
}

function focusableChildren(rail) {
  return [...rail.querySelectorAll(FOCUSABLE)].filter((element) => (
    element.tabIndex >= 0 && !element.closest('[hidden], [inert], [aria-hidden="true"]')
  ))
}

function makeBackgroundInert(rail) {
  const siblings = [...(rail.parentElement?.children || [])]
    .filter((element) => element !== rail && !element.hasAttribute('data-left-rail-backdrop'))
  const previous = siblings.map((element) => [element, element.getAttribute('inert')])
  for (const [element] of previous) element.setAttribute('inert', '')
  return () => {
    for (const [element, value] of previous) {
      if (value === null) element.removeAttribute('inert')
      else element.setAttribute('inert', value)
    }
  }
}

export default function useLeftRailDisclosure({ mediaQuery, onCollapse, hasOpenMenu = false }) {
  const [collapsedPreference, setCollapsedPreference] = useState(initialCollapsed)
  const [narrowViewport, setNarrowViewport] = useState(() => initialNarrowViewport(mediaQuery))
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const railRef = useRef(null)
  const toggleRef = useRef(null)
  const focusOriginRef = useRef(null)
  const restoreFocusRef = useRef(false)
  const hasOpenMenuRef = useRef(hasOpenMenu)

  useEffect(() => { hasOpenMenuRef.current = hasOpenMenu }, [hasOpenMenu])

  useEffect(() => {
    const media = window.matchMedia?.(mediaQuery)
    if (!media) return undefined
    const onChange = (event) => {
      restoreFocusRef.current = true
      onCollapse?.()
      setNarrowViewport(event.matches)
      setMobileExpanded(false)
    }
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [mediaQuery, onCollapse])

  const closeMobileRail = useCallback(({ restoreFocus = false } = {}) => {
    if (!narrowViewport) return
    restoreFocusRef.current = restoreFocus
    onCollapse?.()
    setMobileExpanded(false)
  }, [narrowViewport, onCollapse])

  const setRailCollapsed = useCallback((next) => {
    onCollapse?.()
    if (narrowViewport) {
      if (!next) focusOriginRef.current = document.activeElement
      restoreFocusRef.current = next
      setMobileExpanded(!next)
      return
    }
    setCollapsedPreference(next)
    try { window.localStorage?.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch { /* storage is optional */ }
  }, [narrowViewport, onCollapse])

  useEffect(() => {
    if (!narrowViewport || !mobileExpanded) return undefined
    const rail = railRef.current
    if (!rail) return undefined
    const restoreBackground = makeBackgroundInert(rail)
    const toggle = toggleRef.current
    const initialFocus = toggle || focusableChildren(rail)[0] || rail
    initialFocus.focus({ preventScroll: true })

    const closeDrawer = () => closeMobileRail({ restoreFocus: true })
    const onEscapeBroadcast = () => {
      if (!hasOpenMenuRef.current) closeDrawer()
    }
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        // A nested menu owns the first Escape. Its own handler restores its
        // trigger; a subsequent Escape closes the navigation drawer.
        if (hasOpenMenuRef.current) return
        event.preventDefault()
        event.stopPropagation()
        closeDrawer()
        return
      }
      if (event.key !== 'Tab') return
      const controls = focusableChildren(rail)
      const first = controls[0] || rail
      const last = controls.at(-1) || rail
      const current = document.activeElement
      if (!controls.includes(current) || (!event.shiftKey && current === last)
        || (event.shiftKey && current === first)) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus({ preventScroll: true })
      }
    }
    const keepFocusInside = (event) => {
      if (!rail.contains(event.target)) initialFocus.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', keepFocusInside)
    window.addEventListener('app:escape', onEscapeBroadcast)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', keepFocusInside)
      window.removeEventListener('app:escape', onEscapeBroadcast)
      restoreBackground()
      if (!restoreFocusRef.current) return
      const origin = focusOriginRef.current
      const target = origin?.isConnected ? origin : toggle
      target?.focus?.({ preventScroll: true })
    }
  }, [closeMobileRail, mobileExpanded, narrowViewport])

  return {
    collapsed: narrowViewport ? !mobileExpanded : collapsedPreference,
    closeMobileRail,
    mobileExpanded,
    narrowViewport,
    railRef,
    setRailCollapsed,
    toggleRef,
  }
}
