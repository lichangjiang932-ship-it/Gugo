import { useEffect, useMemo, useRef, useState } from 'react'
import { buildChatTurnMarkers, resolveChatTimeline } from './chatMiniTimeline.js'

function moveTimelineFocus(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const buttons = [...event.currentTarget.querySelectorAll('button')]
  const current = buttons.indexOf(event.target.closest?.('button'))
  if (current < 0) return
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
  event.preventDefault()
  buttons[next]?.focus()
}

/**
 * The conversation's turn strip.
 *
 * One bar per user turn, every turn present, and a preview that shows the request
 * in full. It is deliberately unbounded in both directions: an earlier version kept
 * a fixed number of bars and folded the rest into "…" controls, and shortened each
 * summary to a fixed width, which left the strip unable to answer the two things it
 * exists for — where am I, and which turn is this. The strip scrolls and tracks the
 * active turn, so showing all of them costs no extra room.
 */
export default function ChatMiniTimeline({ activeTurnIndex, messages, onSelectTurn, t }) {
  const turns = useMemo(
    () => buildChatTurnMarkers(messages, t('chatTimeline.attachmentFallback')),
    [messages, t],
  )
  const markerListRef = useRef(null)
  const markerRefs = useRef(new Map())
  const timelineRef = useRef(null)
  const [preview, setPreview] = useState(null)
  const { activeMessageIndex, turns: visibleTurns } = useMemo(
    () => resolveChatTimeline(turns, activeTurnIndex),
    [activeTurnIndex, turns],
  )

  useEffect(() => {
    const list = markerListRef.current
    const marker = markerRefs.current.get(activeMessageIndex)
    if (!list || !marker) return
    const markerTop = marker.offsetTop
    const markerBottom = markerTop + marker.offsetHeight
    if (markerTop < list.scrollTop) list.scrollTop = markerTop
    else if (markerBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = markerBottom - list.clientHeight
    }
  }, [activeMessageIndex, turns.length])

  if (turns.length < 2) return null

  const showPreview = (turn, marker) => {
    const timelineRect = timelineRef.current?.getBoundingClientRect()
    const markerRect = marker?.getBoundingClientRect()
    if (!timelineRect || !markerRect) return
    setPreview({
      ...turn,
      top: markerRect.top - timelineRect.top + markerRect.height / 2,
    })
  }

  return (
    <nav
      ref={timelineRef}
      className="chat-mini-timeline absolute top-1/2 z-20 hidden -translate-y-1/2 md:flex"
      aria-label={t('chatTimeline.label')}
      data-testid="chat-mini-timeline"
      onKeyDown={moveTimelineFocus}
    >
      <div
        ref={markerListRef}
        className="chat-mini-timeline-list relative flex max-h-[min(42vh,18rem)] w-8 flex-col items-center gap-1 overflow-y-auto py-1.5"
      >
        {visibleTurns.map((turn) => {
          const active = turn.messageIndex === activeMessageIndex
          const label = `${t('chatTimeline.jumpTo')} ${turn.number}: ${turn.summary}`
          return (
            <button
              key={turn.key}
              ref={(node) => {
                if (node) markerRefs.current.set(turn.messageIndex, node)
                else markerRefs.current.delete(turn.messageIndex)
              }}
              type="button"
              aria-current={active ? 'step' : undefined}
              aria-label={label}
              className="chat-mini-timeline-marker group relative z-10 flex h-3 shrink-0 items-center justify-start rounded-pill pl-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/35 focus-visible:ring-offset-1 focus-visible:ring-offset-paper"
              data-turn-index={turn.messageIndex}
              data-testid="chat-timeline-marker"
              onClick={() => onSelectTurn(turn.messageIndex)}
              onFocus={(event) => showPreview(turn, event.currentTarget)}
              onBlur={() => setPreview(null)}
              onMouseEnter={(event) => showPreview(turn, event.currentTarget)}
              onMouseLeave={() => setPreview(null)}
            >
              {/* A bar rather than a hairline — one pixel reads as texture, not as
                  a target — but only just: the strip should stay quiet beside the
                  conversation it indexes. */}
              <span
                aria-hidden="true"
                className={`block h-1 rounded-pill transition-[width,background-color] duration-200 ease-out motion-reduce:transition-none ${active ? 'w-5 bg-ink/70' : 'w-3.5 bg-ink/30 group-hover:w-5 group-hover:bg-ink/60 group-focus-visible:w-5 group-focus-visible:bg-ink/70'}`}
              />
            </button>
          )
        })}
      </div>
      {preview && (
        <div
          className="pointer-events-none absolute left-12 w-64 -translate-y-1/2 rounded-control border border-ink/10 bg-paper/95 px-2.5 py-2 text-left shadow-sm backdrop-blur-sm"
          style={{ top: preview.top }}
          data-testid="chat-timeline-preview"
        >
          <div className="whitespace-pre-wrap break-words text-ui leading-5 text-ink-soft">{preview.summary}</div>
        </div>
      )}
    </nav>
  )
}
