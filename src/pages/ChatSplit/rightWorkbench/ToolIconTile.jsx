/**
 * One icon, one tinted tile — the same tile on the entry page and in the
 * header switch, so a tool is recognisable by colour before it is read by
 * label. Tints live here so the two surfaces can never drift apart.
 */
const TINT = Object.freeze({
  chat: 'bg-accent/10 text-accent-ink',
  browser: 'bg-running/10 text-running',
  terminal: 'bg-ink/[0.07] text-ink-soft',
  fallback: 'bg-paper-2 text-ink-fade',
})

export default function ToolIconTile({ icon: Icon, size = 'md', toolId }) {
  if (!Icon) return null
  const small = size === 'sm'
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center ${small ? 'h-7 w-7 rounded-lg' : 'h-9 w-9 rounded-xl'} ${TINT[toolId] || TINT.fallback}`}
    >
      <Icon className={small ? 'h-4 w-4' : 'h-[18px] w-[18px]'} strokeWidth={1.8} />
    </span>
  )
}
