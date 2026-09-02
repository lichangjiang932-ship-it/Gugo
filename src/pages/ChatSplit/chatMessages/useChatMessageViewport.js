import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_MESSAGE_WINDOW_SIZE, getAnchoredWindowStart, getMessageWindow } from '../../../lib/messageWindow.js'

function directoryRequestKey(messages) {
  const message = messages[messages.length - 1]
  const request = message?.meta?.serverClarification
  const requestType = request?.request_type || request?.requestType
  if (message?.role !== 'assistant' || requestType !== 'directory') return ''
  return [
    message.id || '',
    message.meta?.serverTurnId || '',
    message.meta?.serverLastSequence ?? '',
    request.timestamp ?? '',
    request.suggested_path || request.suggestedPath || '',
    request.access_mode || request.accessMode || '',
  ].join(':')
}

function scrollElementToBottom(element, behavior = 'smooth') {
  if (typeof element?.scrollTo === 'function') {
    element.scrollTo({ top: element.scrollHeight, behavior })
    return
  }
  if (element) element.scrollTop = element.scrollHeight
}

function routeMessageTarget(routeHash) {
  if (!String(routeHash || '').startsWith('#message-')) return null
  try {
    const messageId = decodeURIComponent(String(routeHash).slice('#message-'.length))
    return messageId ? { messageId, targetId: `message-${messageId}` } : null
  } catch {
    return null
  }
}

export default function useChatMessageViewport({ messages, onQuoteSelection, routeHash = '' }) {
  const [windowStart, setWindowStart] = useState(null)
  const { hiddenCount, hiddenAfterCount, visibleMessages } = getMessageWindow(
    messages,
    DEFAULT_MESSAGE_WINDOW_SIZE,
    windowStart,
  )
  const [quoteBubble, setQuoteBubble] = useState(null)
  const scrollRef = useRef(null)
  const containerRef = useRef(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const lastCountRef = useRef(messages.length)
  const lastDirectoryRequestKeyRef = useRef(directoryRequestKey(messages))
  const pendingScrollRestoreRef = useRef(null)
  const pendingScrollBottomRef = useRef(false)
  const pendingTurnIndexRef = useRef(null)
  const [activeTurnIndex, setActiveTurnIndex] = useState(null)

  const updateActiveTurn = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const anchors = [...element.querySelectorAll('[data-chat-turn-index]')]
    if (anchors.length === 0) return
    const containerRect = element.getBoundingClientRect()
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 16
    let active = Number(anchors[0].dataset.chatTurnIndex)
    if (nearBottom) {
      active = Number(anchors[anchors.length - 1].dataset.chatTurnIndex)
    } else {
      const focusY = containerRect.top + Math.min(element.clientHeight * 0.32, 240)
      for (const anchor of anchors) {
        if (anchor.getBoundingClientRect().top > focusY) break
        active = Number(anchor.dataset.chatTurnIndex)
      }
    }
    if (Number.isFinite(active)) {
      setActiveTurnIndex((current) => (current === active ? current : active))
    }
  }, [])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || routeMessageTarget(routeHash)) return
    element.scrollTop = element.scrollHeight
  }, [routeHash])
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    if (pendingScrollBottomRef.current) {
      pendingScrollBottomRef.current = false
      scrollElementToBottom(element)
      updateActiveTurn()
      return
    }
    const pendingTurnIndex = pendingTurnIndexRef.current
    if (pendingTurnIndex != null) {
      const target = element.querySelector(`[data-chat-turn-index="${pendingTurnIndex}"]`)
      if (target) {
        pendingTurnIndexRef.current = null
        target.scrollIntoView({ block: 'center', behavior: 'smooth' })
        updateActiveTurn()
      }
      return
    }
    const pending = pendingScrollRestoreRef.current
    if (!pending) return
    const anchor = element.querySelector(`[data-chat-message-index="${pending.index}"]`)
    if (anchor) {
      const nextOffset = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
      element.scrollTop += nextOffset - pending.offset
    }
    pendingScrollRestoreRef.current = null
  }, [hiddenCount, updateActiveTurn])
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined
    const onScroll = () => {
      const nextAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      atBottomRef.current = nextAtBottom
      setAtBottom(nextAtBottom)
      updateActiveTurn()
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => element.removeEventListener('scroll', onScroll)
  }, [updateActiveTurn])
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const grew = messages.length > lastCountRef.current
    const lastMessage = messages[messages.length - 1]
    const streaming = lastMessage?.role === 'assistant' && lastMessage?.meta?.streaming
    const nextDirectoryRequestKey = directoryRequestKey(messages)
    const directoryRequestAppeared = !!nextDirectoryRequestKey
      && nextDirectoryRequestKey !== lastDirectoryRequestKeyRef.current
    if ((grew || streaming || directoryRequestAppeared) && hiddenAfterCount === 0 && atBottomRef.current) {
      element.scrollTop = element.scrollHeight
    }
    lastCountRef.current = messages.length
    lastDirectoryRequestKeyRef.current = nextDirectoryRequestKey
  }, [hiddenAfterCount, messages])
  useLayoutEffect(() => {
    updateActiveTurn()
  }, [hiddenCount, messages, updateActiveTurn])
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const target = routeMessageTarget(routeHash)
    if (!target) return undefined
    const { messageId, targetId } = target
    const targetIndex = messages.findIndex((message) => String(message?.id) === messageId)
    const visibleEnd = hiddenCount + visibleMessages.length
    if (targetIndex >= 0 && (targetIndex < hiddenCount || targetIndex >= visibleEnd)) {
      const timer = window.setTimeout(() => {
        setWindowStart(getAnchoredWindowStart(messages.length, targetIndex))
      }, 0)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80)
    return () => window.clearTimeout(timer)
  }, [hiddenCount, messages, routeHash, visibleMessages.length])
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
    const anchor = element?.querySelector(`[data-chat-message-index="${hiddenCount}"]`)
    if (element && anchor) {
      pendingScrollRestoreRef.current = {
        index: hiddenCount,
        offset: anchor.getBoundingClientRect().top - element.getBoundingClientRect().top,
      }
    }
    setWindowStart(Math.max(0, hiddenCount - Math.floor(DEFAULT_MESSAGE_WINDOW_SIZE / 2)))
  }
  const scrollToBottom = () => {
    const element = scrollRef.current
    if (!element) return
    if (hiddenAfterCount > 0) {
      pendingScrollBottomRef.current = true
      setWindowStart(null)
      return
    }
    scrollElementToBottom(element)
  }
  const scrollToTurn = (messageIndex) => {
    const element = scrollRef.current
    if (!element || !Number.isInteger(messageIndex)) return
    setActiveTurnIndex(messageIndex)
    const visibleEnd = hiddenCount + visibleMessages.length
    if (messageIndex < hiddenCount || messageIndex >= visibleEnd) {
      pendingTurnIndexRef.current = messageIndex
      setWindowStart(getAnchoredWindowStart(messages.length, messageIndex))
      return
    }
    element.querySelector(`[data-chat-turn-index="${messageIndex}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  const quoteSelection = () => {
    if (!quoteBubble?.text) return
    onQuoteSelection?.(quoteBubble.text)
    setQuoteBubble(null)
    if (typeof window !== 'undefined') window.getSelection()?.removeAllRanges()
  }
  return {
    hiddenCount,
    visibleMessages,
    quoteBubble,
    atBottom: hiddenAfterCount === 0 && atBottom,
    activeTurnIndex,
    bindContainer,
    loadEarlierMessages,
    scrollToBottom,
    scrollToTurn,
    quoteSelection,
  }
}
