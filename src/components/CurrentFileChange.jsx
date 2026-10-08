import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import DiffLines from './DiffLines.jsx'
import { CURRENT_CONTENT_LINE_LIMIT, isBinaryChangePath, readCurrentFileContent } from '../lib/currentFileContent.js'

/**
 * A changed file the transcript holds no edit for — a script wrote it, or the
 * tool call's arguments were cut for size when they were stored. Rather than a
 * dead end, the review reads the file as it is now. A file the executor reports
 * as wholly added is drawn as additions, like a new file in any diff; anything
 * else is shown as its current content and labelled as such, never as an
 * invented diff. Binary formats say so and point at their preview.
 */
export default function CurrentFileChange({ file, counts, t, wrap = false, className = '' }) {
  const path = String(file?.path || '').trim()
  const binary = isBinaryChangePath(path)
  const [state, setState] = useState({ key: '', lines: null, totalLines: 0, error: '' })
  const current = state.key === path ? state : null
  useEffect(() => {
    if (!path || binary) return undefined
    const controller = new AbortController()
    readCurrentFileContent(path, { signal: controller.signal })
      .then((result) => setState({ key: path, lines: result.lines, totalLines: result.totalLines, error: '' }))
      .catch((error) => {
        if (!controller.signal.aborted) setState({ key: path, lines: null, totalLines: 0, error: error?.code || 'CURRENT_CONTENT_UNAVAILABLE' })
      })
    return () => controller.abort()
  }, [binary, path])

  if (binary) return <p data-testid="current-file-binary" className="text-xs leading-5 text-ink-fade">{t('chat.changes.binaryFile')}</p>
  // No path, nothing to read: the initial state's empty key would otherwise
  // "match" and be drawn as content that was never loaded.
  if (!path || current?.error) return <p data-testid="current-file-unavailable" className="text-xs leading-5 text-ink-fade">{t('chat.changes.currentUnavailable')}</p>
  if (!current) {
    return <p className="flex items-center gap-1.5 text-xs text-ink-fade"><LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t('chat.changes.readingCurrent')}</p>
  }
  const created = Number(counts?.deletions) === 0 && Number(counts?.additions) > 0
  const sign = created ? '+' : ' '
  const edit = { kind: 'current', lines: current.lines.map((line) => ({ sign, line })) }
  const cut = current.totalLines > CURRENT_CONTENT_LINE_LIMIT
  return (
    <div data-testid="current-file-change" data-created={created || undefined}>
      <p className="mb-1 text-xs leading-5 text-ink-fade">{t(created ? 'chat.changes.newFileCurrent' : 'chat.changes.currentContent')}</p>
      <DiffLines edit={edit} t={t} wrap={wrap} fold={false} className={className} testId="current-file-lines" />
      {cut && <p className="mt-1 text-xs text-ink-fade">{t('chat.changes.currentCut', { shown: CURRENT_CONTENT_LINE_LIMIT, total: current.totalLines })}</p>}
    </div>
  )
}
