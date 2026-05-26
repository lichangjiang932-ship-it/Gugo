import { AtSign } from 'lucide-react'
import { getMentionQuery } from './mentionsAutocompleteLogic.js'

export default function MentionsAutocomplete({
  value,
  cursor,
  agents = [],
  selectedIndex = 0,
  setSelectedIndex,
  onPick,
}) {
  const mentionState = getMentionQuery(value, cursor)
  if (!mentionState) return null
  const query = mentionState.query.toLocaleLowerCase()
  const items = agents
    .filter((agent) => {
      const haystack = `${agent.name || ''} ${agent.handle || ''} ${agent.id || ''}`.toLocaleLowerCase()
      return haystack.includes(query)
    })
    .slice(0, 8)
  if (!items.length) return null

  const safeIndex = Math.max(0, Math.min(selectedIndex, items.length - 1))

  return (
    <div className="absolute left-3 right-3 bottom-[calc(100%+0.5rem)] z-30 rounded-md border border-ink-fade/40 bg-paper shadow-xl p-1.5">
      <div className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-ink-fade">mentions</div>
      {items.map((agent, index) => {
        const selected = index === safeIndex
        return (
          <button
            key={agent.id}
            type="button"
            onMouseEnter={() => setSelectedIndex?.(index)}
            onClick={() => onPick?.(agent, mentionState)}
            className={`w-full min-w-0 flex items-center gap-2 px-2 py-2 rounded-md text-left ${
              selected ? 'bg-ember-soft text-ember' : 'text-ink-soft hover:bg-paper-2'
            }`}
          >
            <span className="w-7 h-7 rounded-md border border-ink-fade/40 bg-paper-2 flex items-center justify-center shrink-0 overflow-hidden">
              {agent.avatarUrl ? (
                <img src={agent.avatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <AtSign className="w-3.5 h-3.5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium truncate">@{agent.name || agent.id}</span>
              <span className="block text-[11px] text-ink-fade truncate">{agent.id}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
