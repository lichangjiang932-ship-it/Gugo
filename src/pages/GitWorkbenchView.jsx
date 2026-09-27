import { GitBranch } from 'lucide-react'
import AppLayout from '../components/AppLayout.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import WorkbenchGit from './ChatSplit/rightWorkbench/WorkbenchGit.jsx'

/**
 * The Git workbench as a full destination page.
 *
 * Branch status, changed files and per-file diffs belong to one bounded view the
 * reader can leave open beside the chat — not a tool-panel tab that disappears
 * whenever another tool is picked. The panel still exists for a quick glance;
 * this page is where the reader actually works through the changes.
 */
export default function GitWorkbenchView() {
  const { t } = useT()
  return (
    <AppLayout>
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 px-4 py-4">
        <header className="flex items-center gap-2" data-testid="git-workbench-header">
          <GitBranch className="h-4 w-4 shrink-0 text-ink-fade" aria-hidden="true" />
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{t('workbench.gitPageTitle')}</h1>
          <p className="hidden truncate text-xs text-ink-fade sm:block">{t('workbench.gitFullViewHint')}</p>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-ink/10 bg-paper">
          <WorkbenchGit t={t} />
        </div>
      </div>
    </AppLayout>
  )
}
