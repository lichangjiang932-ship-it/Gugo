import {
  BookOpen,
  ChartColumn,
  CircleDashed,
  CircleUserRound,
  Clapperboard,
  Code,
  CornerUpRight,
  FileSpreadsheet,
  FileText,
  FileType2,
  Gauge,
  Gamepad2,
  Image,
  Languages,
  Lightbulb,
  ListChecks,
  MessageCirclePlus,
  MessageSquare,
  MessagesSquare,
  Package,
  Palette,
  PanelRightOpen,
  Paperclip,
  Plug,
  Presentation,
  Search,
  Sparkles,
  Target,
  Type,
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

/**
 * The marks a skill can be given, keyed by the family the registry worked out
 * for it. Which family that is belongs to the skill vocabulary, not to a menu
 * that only has to draw it — the ids and names it would have to match on are
 * Chinese, and a component that hardcodes Chinese is a component that has not
 * been translated.
 */
const SKILL_ICONS = {
  archive: Package,
  chart: ChartColumn,
  code: Code,
  design: Palette,
  doc: FileText,
  font: Type,
  game: Gamepad2,
  image: Image,
  media: Clapperboard,
  message: MessagesSquare,
  pdf: FileType2,
  plan: ListChecks,
  presentation: Presentation,
  review: Search,
  sheet: FileSpreadsheet,
  translate: Languages,
}

function commandLabel(entry, t) {
  if (entry.meta?.displayName) return entry.meta.displayName
  if (commandGroup(entry) !== 'core') return entry.name
  const label = t(`slash.actionLabels.${entry.name}`)
  return label === entry.name ? entry.name : label
}

/**
 * The commands that take text say so next to their name. The argument was
 * reachable only through the title attribute and a screen-reader-only span, so
 * nothing on screen told `/goals` apart from `/goals <goal>`. Skills are left
 * alone: their hint is the same `<prompt>` on every row and the description
 * already says what they do.
 */
function showsArgumentHint(entry) {
  return commandGroup(entry) === 'core' && Boolean(entry.hint)
}

/**
 * A row is a line of text, not a table: the name, its argument and then the
 * sentence describing it, running on from the left. The description used to be
 * pushed to the right edge in a column of its own, which left a wide empty gap
 * down the middle of every row and made a list of thirty commands look sparse.
 * Claude Code's own menu reads the same way — mark, name, description, left to
 * right — and fits about half again as many rows in the same height.
 */
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
      className="absolute bottom-[calc(100%+10px)] left-0 right-0 z-50 isolate max-h-[min(390px,46vh)] overflow-y-auto overscroll-contain rounded-card border border-ink/10 bg-paper p-1.5 shadow-[0_18px_50px_rgb(var(--color-ink-rgb)/0.14),0_2px_8px_rgb(var(--color-ink-rgb)/0.05)] [scrollbar-width:thin]"
      onMouseDown={(event) => event.preventDefault()}
    >
      {items.length === 0 ? (
        <div className="px-3 py-6 text-center text-[13px] text-ink-fade">{t('slash.noMatches')}</div>
      ) : items.map((entry, index) => {
        const selected = index === selectedIndex
        const hint = showsArgumentHint(entry)
        const group = commandGroup(entry)
        const Glyph = group === 'core'
          ? (CORE_ICONS[entry.name] || WandSparkles)
          : group === 'skill'
            ? (SKILL_ICONS[entry.meta?.iconKey] || Sparkles)
            : (entry.kind === 'prompt-template' ? BookOpen : Plug)
        return (
          <button
            key={`${entry.source}:${entry.kind || 'command'}:${entry.name}`}
            id={`slash-option-${index}`}
            type="button"
            role="option"
            aria-selected={selected}
            data-slash-index={index}
            onMouseEnter={() => onHighlight(index)}
            onClick={() => onSelect(entry)}
            title={[entry.hint, entry.description].filter(Boolean).join('  ') || undefined}
            className={`group flex w-full items-center gap-2 rounded-[9px] px-2.5 py-1.5 text-left transition-colors duration-100 ${selected ? 'bg-ink/[0.07] text-ink' : 'text-ink-soft hover:bg-ink/[0.04] hover:text-ink'}`}
          >
            <span className={`flex w-4 shrink-0 items-center justify-center transition-colors ${selected ? 'text-ink-soft' : 'text-ink-fade group-hover:text-ink-soft'}`}>
              <Glyph aria-hidden="true" strokeWidth={1.7} className="h-4 w-4" />
            </span>
            <span className="max-w-[48%] shrink-0 truncate text-[13px] leading-5">{commandLabel(entry, t)}</span>
            {hint
              ? <span className="shrink-0 font-mono text-[13px] leading-5 text-ink-fade/80">{entry.hint}</span>
              : entry.hint ? <span className="sr-only">{entry.hint}</span> : null}
            <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink-fade/90">{entry.description}</span>
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
