import { Archive } from 'lucide-react'

export default function CompactionPill({ count = 0, archiveId, onExpand }) {
  return (
    <button
      type="button"
      onClick={() => archiveId && onExpand?.(archiveId)}
      className="inline-flex items-center gap-2 rounded-full border border-dashed border-ink-fade/50 bg-paper px-3 py-1.5 text-[11px] text-ink-soft hover:border-ember/60 hover:text-ember transition-colors"
      title={archiveId ? 'Load archived context' : 'Compacted context'}
    >
      <Archive className="w-3.5 h-3.5" />
      Compacted {count || 0} earlier messages
    </button>
  )
}
