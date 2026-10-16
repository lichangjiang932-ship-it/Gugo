import { useLayoutEffect, useRef } from 'react'
import { scrollEdges } from '../../lib/scrollPinning.js'
import './ScrollFadeContainer.css'

/** Only host scroll chrome: no prompt/content changes, no extra scroll owner. */
export default function ScrollFadeContainer({ children, className = '', ref: externalRef, onContentResize, ...props }) {
  const nodeRef = useRef(null)
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!node) return undefined
    const update = () => {
      const edges = scrollEdges(node)
      node.dataset.scrollFaded = edges.top || edges.bottom ? 'true' : 'false'
      node.style.setProperty('--scroll-fade-top', edges.top + 'px')
      node.style.setProperty('--scroll-fade-bottom', edges.bottom + 'px')
      node.style.setProperty('--scroll-native-width', Math.max(0, node.offsetWidth - node.clientWidth) + 'px')
    }
    const resize = () => { onContentResize?.(); update() }
    update()
    node.addEventListener('scroll', update, { passive: true })
    const Observer = globalThis.ResizeObserver
    const observer = Observer ? new Observer(resize) : null
    observer?.observe(node)
    if (node.firstElementChild) observer?.observe(node.firstElementChild)
    return () => { node.removeEventListener('scroll', update); observer?.disconnect() }
  }, [onContentResize])
  return <div {...props} ref={node => {
    nodeRef.current = node
    if (typeof externalRef === 'function') externalRef(node)
    else if (externalRef) externalRef.current = node
  }} className={'gugo-scroll-fade ' + className}>{children}</div>
}
