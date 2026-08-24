import { useEffect, useMemo, useRef, useState } from 'react'
import { buildChatTurnMarkers } from './chatMiniTimeline.js'

export default function ChatMiniTimeline({ activeTurnIndex, messages, onSelectTurn, t }) {
  const turns = useMemo(
    () => buildChatTurnMarkers(messages, t('chatTimeline.attachmentFallback')),
    [messages, t],
  )
  const markerListRef = useRef(null)
  const markerRefs = useRef(new Map())
  const timelineRef = useRef(null)
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    const list = markerListRef.current
    const marker = markerRefs.current.get(activeTurnIndex)
    if (!list || !marker) return
    const markerTop = marker.offsetTop
    const markerBottom = markerTop + marker.offsetHeight
    if (markerTop < list.scrollTop) list.scrollTop = markerTop
    else if (markerBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = markerBottom - list.clientHeight
    }
  }, [activeTurnIndex, turns.length])

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
    >
      <div
        ref={markerListRef}
        className="chat-mini-timeline-list relative flex max-h-[min(42vh,18rem)] w-8 flex-col items-center gap-0.5 overflow-y-auto py-1.5"
      >
        {turns.map((turn) => {
          const active = turn.messageIndex === activeTurnIndex
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
              className="chat-mini-timeline-marker group relative z-10 flex h-3.5 w-8 shrink-0 items-center justify-start rounded-control pl-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/35 focus-visible:ring-offset-1 focus-visible:ring-offset-paper"
              data-turn-index={turn.messageIndex}
              data-testid="chat-timeline-marker"
              onClick={() => onSelectTurn(turn.messageIndex)}
              onFocus={(event) => showPreview(turn, event.currentTarget)}
              onBlur={() => setPreview(null)}
              onMouseEnter={(event) => showPreview(turn, event.currentTarget)}
              onMouseLeave={() => setPreview(null)}
            >
              <span
                aria-hidden="true"
                className={`block h-[3px] rounded-pill transition-[width,background-color,transform] duration-200 ease-out motion-reduce:transition-none ${active ? 'w-4 bg-ink/80' : 'w-2.5 bg-ink/25 group-hover:w-4 group-hover:bg-ink/65 group-hover:translate-x-0.5 group-focus-visible:w-4 group-focus-visible:bg-ink/70'}`}
              />
            </button>
          )
        })}
      </div>
      {preview && (
        <div
          className="pointer-events-none absolute left-7 w-52 -translate-y-1/2 rounded-control border border-ink/10 bg-paper/95 px-2.5 py-2 text-left shadow-sm backdrop-blur-sm"
          style={{ top: preview.top }}
          data-testid="chat-timeline-preview"
        >
          <div className="line-clamp-3 text-ui leading-5 text-ink-soft">{preview.summary}</div>
        </div>
      )}
    </nav>
  )
}
