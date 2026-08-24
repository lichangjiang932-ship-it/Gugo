import { isValidElement } from 'react'

export function nodeText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText(node.props.children)
  return ''
}

export function selectedTextIntersects(element) {
  const selection = element?.ownerDocument?.defaultView?.getSelection?.()
  if (!selection || selection.isCollapsed || selection.rangeCount < 1) return false
  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(element)) return true
    } catch {
      // Selection ranges can disappear between pointerup and React's click handler.
    }
  }
  return false
}
