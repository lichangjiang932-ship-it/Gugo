import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/** Composer popovers escape containment; React ownership/context remains unchanged. */
export default function PopoverPortal({ anchorRef, children, ref: externalRef, width = 304, matchAnchorWidth = false, heightLimit = 336, onDismiss }) {
  const localRef = useRef(null)
  useLayoutEffect(() => {
    const node = localRef.current, anchor = anchorRef?.current
    if (!node || !anchor) return undefined
    const inherited = new Set()
    const update = () => {
      const viewport = window.visualViewport
      const vw = viewport?.width || window.innerWidth, vh = viewport?.height || window.innerHeight
      const ox = viewport?.offsetLeft || 0, oy = viewport?.offsetTop || 0
      const rect = anchor.getBoundingClientRect(), availableAbove = rect.top - oy - 16
      const availableBelow = vh - (rect.bottom - oy) - 16
      const above = availableAbove >= Math.min(240, availableBelow)
      const actualWidth = Math.max(0, Math.min(matchAnchorWidth ? rect.width : width, vw - 24))
      node.style.width = actualWidth + 'px'
      node.style.left = Math.max(ox + 12, Math.min(rect.right - actualWidth, ox + vw - actualWidth - 12)) + 'px'
      node.style.top = above ? 'auto' : rect.bottom + 8 + 'px'
      node.style.bottom = above ? window.innerHeight - rect.top + 8 + 'px' : 'auto'
      node.style.maxHeight = Math.max(40, Math.min(heightLimit, above ? availableAbove : availableBelow)) + 'px'
      const style = window.getComputedStyle(anchor), root = window.getComputedStyle(document.documentElement)
      node.style.fontFamily = style.fontFamily
      node.style.fontSize = style.fontSize
      node.style.lineHeight = style.lineHeight
      for (const key of inherited) node.style.removeProperty(key)
      inherited.clear()
      for (let i = 0; i < style.length; i++) {
        const key = style[i]
        if (key.startsWith('--') && style.getPropertyValue(key) !== root.getPropertyValue(key)) { node.style.setProperty(key, style.getPropertyValue(key)); inherited.add(key) }
      }
      const modal = document.querySelector('[aria-modal="true"]')
      if (modal && !modal.contains(anchor)) onDismiss?.()
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(anchor); observer?.observe(node)
    const mutations = new window.MutationObserver(update)
    mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-density', 'style'] })
    mutations.observe(document.body, { childList: true })
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      observer?.disconnect(); mutations.disconnect()
      window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update); window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [anchorRef, heightLimit, matchAnchorWidth, onDismiss, width])
  if (typeof document === 'undefined' || !anchorRef) return children
  return createPortal(<div data-host-popover="" ref={node => {
    localRef.current = node
    if (typeof externalRef === 'function') externalRef(node)
    else if (externalRef) externalRef.current = node
  }} style={{ position: 'fixed', zIndex: 'var(--layer-popover, 40)', maxWidth: 'calc(100vw - 24px)' }}>{children}</div>, document.body)
}
