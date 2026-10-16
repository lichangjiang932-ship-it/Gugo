import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createScrollPinning, preferredScrollBehavior, SCROLL_INPUT_COOLDOWN } from '../../../lib/scrollPinning.js'
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

function scrollElementToBottom(element, behavior = preferredScrollBehavior()) {
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

export default function useChatMessageViewport({ messages, routeHash = '' }) {
  const [windowStart, setWindowStart] = useState(null)
  const { hiddenCount, hiddenAfterCount, visibleMessages } = getMessageWindow(
    messages,
    DEFAULT_MESSAGE_WINDOW_SIZE,
    windowStart,
  )
  const scrollRef = useRef(null)
  const [atBottom, setAtBottom] = useState(true)
  const pinRef = useRef(null)
  if (pinRef.current == null) pinRef.current = createScrollPinning()
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
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
    if (!element) return
    if (routeMessageTarget(routeHash)) { pinRef.current.input(-1); return }
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
        target.scrollIntoView({ block: 'center', behavior: preferredScrollBehavior() })
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
      const observation = pinRef.current.observe(element)
      setAtBottom(observation.pinned)
      setShowJumpToLatest(observation.showJump)
      updateActiveTurn()
    }
    let timer, touchY = null
    const input = direction => {
      pinRef.current.input(direction)
      if (direction < 0) setAtBottom(false)
      clearTimeout(timer)
      timer = setTimeout(onScroll, SCROLL_INPUT_COOLDOWN + 1)
    }
    const wheel = event => { if (event.deltaY) input(Math.sign(event.deltaY)) }
    const touchStart = event => { touchY = event.touches[0]?.clientY ?? null }
    const touchMove = event => {
      const next = event.touches[0]?.clientY
      if (touchY != null && next != null && next !== touchY) input(Math.sign(touchY - next))
      touchY = next ?? null
    }
    const key = event => {
      if (event.target.closest?.('input, textarea, select, [contenteditable=true]')) return
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) input(-1)
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) input(1)
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    element.addEventListener('wheel', wheel, { passive: true })
    element.addEventListener('touchstart', touchStart, { passive: true })
    element.addEventListener('touchmove', touchMove, { passive: true })
    element.addEventListener('keydown', key)
    onScroll()
    return () => {
      clearTimeout(timer)
      for (const [name, handler] of [['scroll', onScroll], ['wheel', wheel], ['touchstart', touchStart], ['touchmove', touchMove], ['keydown', key]]) element.removeEventListener(name, handler)
    }
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
    if ((grew || streaming || directoryRequestAppeared) && hiddenAfterCount === 0 && pinRef.current.shouldPin()) {
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
    const timer = window.setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ block: 'center', behavior: preferredScrollBehavior() }), 80)
    return () => window.clearTimeout(timer)
  }, [hiddenCount, messages, routeHash, visibleMessages.length])
  const onContentResize = useCallback(() => {
    const element = scrollRef.current
    if (element && pinRef.current.shouldPin()) element.scrollTop = element.scrollHeight
    updateActiveTurn()
  }, [updateActiveTurn])
  const bindContainer = (element) => { scrollRef.current = element }
  const loadEarlierMessages = () => {
    pinRef.current.input(-1)
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
    pinRef.current.jump()
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
    pinRef.current.input(-1)
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
      ?.scrollIntoView({ block: 'center', behavior: preferredScrollBehavior() })
  }
  return {
    hiddenCount,
    visibleMessages,
    atBottom: hiddenAfterCount === 0 && atBottom,
    activeTurnIndex,
    showJumpToLatest: hiddenAfterCount > 0 || showJumpToLatest,
    onContentResize,
    bindContainer,
    loadEarlierMessages,
    scrollToBottom,
    scrollToTurn,
  }
}
