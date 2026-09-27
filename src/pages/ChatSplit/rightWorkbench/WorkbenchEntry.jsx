import { useNavigate } from '../../../lib/router.jsx'
import { GitBranch } from 'lucide-react'
import { WORKBENCH_TOOLS, shortcutLabelFor } from '../../../lib/workbenchShortcuts.js'
import ToolIconTile from './ToolIconTile.jsx'
import { TOOL_GLYPHS } from './workbenchToolGlyphs.js'

/**
 * The panel's front door: one row per tool, with the key that reaches it.
 *
 * What the reader sees when the panel opens before any tool was chosen. Each
 * row says both what the tool is and how to reach it again — the shortcut text
 * comes from the same definitions the rail tooltip and the key handler use, so
 * a chip never promises a key nobody bound.
 *
 * The panel can be squeezed by a narrow window, so the rows give way in a fixed
 * order: the tool name ellipsizes before the key chip is clipped, because the
 * name is recoverable from the icon and the tooltip while the key is not.
 *
 * Git is the one tool that is not a panel tab: branch status and per-file diffs
 * need width and a persistent place, so its row navigates to the full Git
 * workbench page instead of switching a tab.
 */
export default function WorkbenchEntry({ onTabChange, t }) {
  const navigate = useNavigate()
  return (
    <section className="flex min-h-0 flex-1 flex-col justify-center gap-1 px-4" data-testid="workbench-entry">
      {WORKBENCH_TOOLS.map((tool) => {
        const Icon = TOOL_GLYPHS[tool.id]
        const shortcut = shortcutLabelFor(tool)
        return (
          <button
            key={tool.id}
            type="button"
            data-testid="workbench-entry-row"
            data-tool={tool.id}
            onClick={() => onTabChange?.(tool.id)}
            className="group flex items-center gap-3 rounded-card px-3 py-3 text-left text-sm text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
          >
            <ToolIconTile icon={Icon} toolId={tool.id} />
            <span className="min-w-0 flex-1 truncate">{t(tool.labelKey)}</span>
            {shortcut && (
              <kbd className="workbench-entry-key shrink-0 rounded-md border border-ink/10 bg-paper-2/70 px-1.5 py-0.5 font-mono text-xs text-ink-fade shadow-sm" data-testid="workbench-entry-shortcut">
                {shortcut}
              </kbd>
            )}
          </button>
        )
      })}
      <button
        type="button"
        data-testid="workbench-entry-git"
        onClick={() => navigate('/git')}
        className="group flex items-center gap-3 rounded-card px-3 py-3 text-left text-sm text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
      >
        <ToolIconTile icon={GitBranch} toolId="git" />
        <span className="min-w-0 flex-1 truncate">{t('workbench.gitFullView')}</span>
      </button>
    </section>
  )
}
