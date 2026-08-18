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
        className="chat-mini-timeline-list relative flex max-h-[min(52vh,28rem)] w-7 flex-col items-center gap-1.5 overflow-y-auto py-2"
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
              className="chat-mini-timeline-marker group relative z-10 flex h-3 w-7 shrink-0 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/45"
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
                className={`block h-0.5 rounded-pill transition-[width,background-color] duration-150 ${active ? 'w-4 bg-ember' : 'w-2 bg-ink-fade/55 group-hover:w-3.5 group-hover:bg-ink-soft'}`}
              />
            </button>
          )
        })}
      </div>
      {preview && (
        <div
          className="pointer-events-none absolute left-8 w-56 -translate-y-1/2 rounded-card border border-ink/10 bg-paper px-3 py-2 text-left shadow-sm"
          style={{ top: preview.top }}
          data-testid="chat-timeline-preview"
        >
          <div className="mb-0.5 text-xs font-medium text-ink-fade">
            {t('chatTimeline.turn')} {preview.number}
          </div>
          <div className="line-clamp-3 text-xs leading-5 text-ink-soft">{preview.summary}</div>
        </div>
      )}
    </nav>
  )
}
