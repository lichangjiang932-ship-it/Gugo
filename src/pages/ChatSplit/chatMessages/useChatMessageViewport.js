import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_MESSAGE_WINDOW_SIZE, getExpandedWindowCount, getMessageWindow } from '../../../lib/messageWindow.js'

export default function useChatMessageViewport({ messages, onQuoteSelection }) {
  const [visibleCount, setVisibleCount] = useState(DEFAULT_MESSAGE_WINDOW_SIZE)
  const { hiddenCount, visibleMessages } = getMessageWindow(messages, visibleCount)
  const [quoteBubble, setQuoteBubble] = useState(null)
  const scrollRef = useRef(null)
  const containerRef = useRef(null)
  const [atBottom, setAtBottom] = useState(true)
  const lastCountRef = useRef(messages.length)
  const pendingScrollRestoreRef = useRef(null)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || (typeof window !== 'undefined' && window.location.hash.startsWith('#message-'))) return
    element.scrollTop = element.scrollHeight
  }, [])
  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current
    const element = scrollRef.current
    if (!pending || !element) return
    element.scrollTop = pending.top + (element.scrollHeight - pending.height)
    pendingScrollRestoreRef.current = null
  }, [visibleCount])
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined
    const onScroll = () => setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 80)
    element.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => element.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const grew = messages.length > lastCountRef.current
    const lastMessage = messages[messages.length - 1]
    const streaming = lastMessage?.role === 'assistant' && lastMessage?.meta?.streaming
    if ((grew || streaming) && atBottom) element.scrollTop = element.scrollHeight
    lastCountRef.current = messages.length
  }, [messages, atBottom])
  useEffect(() => {
    if (typeof window === 'undefined' || !window.location.hash.startsWith('#message-')) return undefined
    const targetId = decodeURIComponent(window.location.hash.slice(1))
    const messageId = targetId.slice('message-'.length)
    const targetIndex = messages.findIndex((message) => String(message?.id) === messageId)
    if (targetIndex >= 0 && targetIndex < hiddenCount) {
      const timer = window.setTimeout(() => setVisibleCount(getExpandedWindowCount(messages.length, targetIndex)), 0)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80)
    return () => window.clearTimeout(timer)
  }, [messages, hiddenCount])
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = typeof window !== 'undefined' ? window.getSelection() : null
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return setQuoteBubble(null)
      const text = selection.toString().trim()
      if (!text) return setQuoteBubble(null)
      const range = selection.getRangeAt(0)
      const startElement = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
      const endElement = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement
      const startBlock = startElement?.closest?.('[data-quotable="true"]')
      const endBlock = endElement?.closest?.('[data-quotable="true"]')
      if (!startBlock || startBlock !== endBlock) return setQuoteBubble(null)
      const container = containerRef.current
      if (!container) return
      const rect = range.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      setQuoteBubble({ top: rect.top - containerRect.top + container.scrollTop - 36, left: Math.max(8, rect.left - containerRect.left + rect.width / 2), text })
    }
    document.addEventListener('mouseup', handleSelectionChange)
    document.addEventListener('keyup', handleSelectionChange)
    return () => { document.removeEventListener('mouseup', handleSelectionChange); document.removeEventListener('keyup', handleSelectionChange) }
  }, [])

  const bindContainer = (element) => { scrollRef.current = element; containerRef.current = element }
  const loadEarlierMessages = () => {
    const element = scrollRef.current
    if (element) pendingScrollRestoreRef.current = { height: element.scrollHeight, top: element.scrollTop }
    setVisibleCount((count) => Math.min(messages.length, count + DEFAULT_MESSAGE_WINDOW_SIZE))
  }
  const scrollToBottom = () => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  const quoteSelection = () => {
    if (!quoteBubble?.text) return
    onQuoteSelection?.(quoteBubble.text)
    setQuoteBubble(null)
    if (typeof window !== 'undefined') window.getSelection()?.removeAllRanges()
  }
  return { hiddenCount, visibleMessages, quoteBubble, atBottom, bindContainer, loadEarlierMessages, scrollToBottom, quoteSelection }
}
