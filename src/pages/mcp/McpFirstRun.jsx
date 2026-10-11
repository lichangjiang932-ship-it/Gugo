import { Plus } from 'lucide-react'
import { MCP_SERVER_PRESETS } from '../../lib/mcpPresets.js'

/**
 * What the page shows before there is any server to manage.
 *
 * It used to show the two management panels anyway — an empty list and an empty
 * editor, a few hundred pixels of bordered nothing each, with the presets
 * reachable only through a `<select>` in the header that named them and nothing
 * else. A preset is the whole point of a first run: it is the one path that needs
 * no knowledge of commands or transports. So the presets are the page here, as
 * buttons that carry the name and the publisher, and the empty panels wait until
 * there is something to put in them.
 */
export default function McpFirstRun({ onPickPreset, onAddManual, t }) {
  return (
    <section className="rounded-lg border border-ink/10 bg-paper p-5 sm:p-6">
      <h2 className="text-sm font-semibold text-ink">{t('mcp.firstRunTitle')}</h2>
      <p className="mt-1 text-xs leading-5 text-ink-fade">{t('mcp.firstRunHint')}</p>
      {/* As many 240px columns as the panel holds, rather than a breakpoint on
          the window: the rail and the window width both move, so a viewport
          breakpoint left eleven presets in a single column well past the width
          where two of them would fit. */}
      <div className="mt-5 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
        {MCP_SERVER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-preset={preset.id}
            onClick={() => onPickPreset(preset.id)}
            className="flex min-w-0 items-center gap-3 rounded-lg border border-ink/10 bg-paper px-3 py-2.5 text-left transition-colors hover:border-ink/25 hover:bg-paper-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-ink/10 bg-paper-2 text-xs font-semibold text-ink-soft">{preset.label.slice(0, 1)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-ink">{preset.label}</span>
              <span className="block truncate text-xs text-ink-fade">{preset.publisher}</span>
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onAddManual}
        className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink bg-ink px-3 text-xs font-medium text-paper transition-colors hover:bg-ink/90"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('mcp.firstRunManual')}
      </button>
    </section>
  )
}
