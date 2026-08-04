import {
  CircleDashed,
  CircleUserRound,
  CornerUpRight,
  FileText,
  Gauge,
  Lightbulb,
  MessageCirclePlus,
  MessageSquare,
  Paperclip,
  PanelRightOpen,
  Target,
  WandSparkles,
} from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'

const CORE_ICONS = {
  mcp: Paperclip,
  side: PanelRightOpen,
  init: FileText,
  compact: CircleDashed,
  feedback: MessageSquare,
  continue: CornerUpRight,
  pet: CircleUserRound,
  new: MessageCirclePlus,
  status: Gauge,
  goals: Target,
  plan: Lightbulb,
}

function commandGroup(entry) {
  if (entry.kind === 'skill') return 'skill'
  if (entry.source === 'plugin' || entry.kind === 'prompt-template') return 'plugin'
  return 'core'
}

function CommandIcon({ entry }) {
  const group = commandGroup(entry)
  if (group !== 'core') return null
  const Icon = CORE_ICONS[entry.name] || WandSparkles
  return <Icon aria-hidden="true" strokeWidth={1.8} className="h-[19px] w-[19px]" />
}

function commandLabel(entry, t) {
  if (entry.meta?.displayName) return entry.meta.displayName
  if (commandGroup(entry) !== 'core') return entry.name
  const label = t(`slash.actionLabels.${entry.name}`)
  return label === entry.name ? entry.name : label
}

export default function SlashCommandMenu({
  items,
  selectedIndex,
  listRef,
  onSelect,
  onHighlight,
}) {
  const { t } = useT()

  return (
    <div
      ref={listRef}
      id="slash-command-menu"
      data-testid="slash-command-menu"
      role="listbox"
      aria-label={t('slash.menuLabel')}
      className="absolute bottom-[calc(100%+10px)] left-0 right-0 z-50 isolate max-h-[min(390px,46vh)] overflow-y-auto rounded-[22px] border border-ink/10 bg-paper px-2 py-2 shadow-[0_18px_50px_rgb(var(--color-ink-rgb)/0.14),0_2px_8px_rgb(var(--color-ink-rgb)/0.05)] [scrollbar-width:thin]"
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.length === 0 ? (
        <div className="px-4 py-7 text-center text-[13px] text-ink-fade">{t('slash.noMatches')}</div>
      ) : items.map((entry, index) => {
        const selected = index === selectedIndex
        const showIcon = commandGroup(entry) === 'core'
        return (
          <button
            key={`${entry.source}:${entry.kind || 'command'}:${entry.name}`}
            type="button"
            role="option"
            aria-selected={selected}
            data-slash-index={index}
            onMouseEnter={() => onHighlight(index)}
            onClick={() => onSelect(entry)}
            title={[entry.hint, entry.description].filter(Boolean).join('  ') || undefined}
            className={`group flex min-h-10 w-full items-center gap-3 rounded-[11px] px-3 py-[7px] text-left transition-colors duration-100 ${selected ? 'bg-ink/[0.065] text-ink' : 'text-ink-soft hover:bg-ink/[0.035] hover:text-ink'}`}
          >
            {showIcon && (
              <span className={`flex w-5 shrink-0 items-center justify-center transition-colors ${selected ? 'text-ink-soft' : 'text-ink-fade group-hover:text-ink-soft'}`}>
                <CommandIcon entry={entry} />
              </span>
            )}
            <span className="min-w-[7rem] flex-1 truncate text-[14px] font-normal leading-5">{commandLabel(entry, t)}</span>
            {entry.hint && <span className="sr-only">{entry.hint}</span>}
            <span className="max-w-[58%] shrink truncate text-right text-[13px] font-normal leading-5 text-ink-fade/90">{entry.description}</span>
          </button>
        )
      })}
      {items.length > 0 && (
        <div className="sr-only">
          <span>↑↓ {t('slash.navigate')}</span>
          <span>Enter {t('slash.select')}</span>
          <span>Esc {t('slash.close')}</span>
        </div>
      )}
    </div>
  )
}
