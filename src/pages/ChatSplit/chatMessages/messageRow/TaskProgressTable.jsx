import { useT } from '../../../../i18n/I18nProvider.jsx'
import { hasStructuredProgress } from './taskProgressPresentation.js'

function finite(value) {
  return Number.isFinite(value)
}

function buildRows(progress, t) {
  const rows = []
  if (progress.phase) {
    rows.push({ key: 'phase', value: t('chatMessages.progressPhase', { phase: progress.phase }) })
  }
  const hasCompleted = finite(progress.completed)
  const hasTotal = finite(progress.total)
  if (hasCompleted && hasTotal && progress.total > 0) {
    rows.push({ key: 'steps', value: t('chatMessages.progressSteps', { completed: progress.completed, total: progress.total }) })
  } else if (hasCompleted) {
    rows.push({ key: 'completed', value: t('chatMessages.progressCompleted', { completed: progress.completed }) })
  } else if (hasTotal) {
    rows.push({ key: 'total', value: t('chatMessages.progressTotal', { total: progress.total }) })
  }
  if (finite(progress.iteration)) {
    rows.push({ key: 'iteration', value: t('chatMessages.progressIteration', { iteration: progress.iteration }) })
  }
  if (finite(progress.filesChanged)) {
    rows.push({ key: 'files', value: t('chatMessages.progressFiles', { count: progress.filesChanged }) })
  }
  if (finite(progress.additions) || finite(progress.deletions)) {
    rows.push({
      key: 'changes',
      value: t('chatMessages.progressChanges', { additions: progress.additions ?? 0, deletions: progress.deletions ?? 0 }),
    })
  }
  return rows
}

export default function TaskProgressTable({ progress }) {
  const { t } = useT()
  if (!hasStructuredProgress(progress)) return null
  const rows = buildRows(progress, t)
  if (!rows.length) return null
  return (
    <div
      className="mt-1.5 rounded-md border border-ink/15 bg-paper-2 px-3 py-2"
      data-testid="task-progress-table"
    >
      <div className="text-xs font-medium tracking-wide text-ink-fade mb-1">{t('chatMessages.progressLabel')}</div>
      <table className="w-full text-xs text-ink-soft" aria-label={t('chatMessages.progressLabel')}>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-testid={`task-progress-row-${row.key}`}>
              <td className="py-0.5 pr-3 font-mono tabular-nums">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
