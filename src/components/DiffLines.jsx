import { useState } from 'react'
import { interleaveEditLines } from '../lib/sessionChanges.js'

const ROW_CLASS = Object.freeze({
  '+': 'bg-success/10 text-success',
  '-': 'bg-danger/10 text-danger',
  ' ': 'text-ink-soft',
})

/** Unchanged lines kept on each side of a change before a long run is folded. */
const CONTEXT = 3

function foldContext(lines) {
  const blocks = []
  let run = []
  const flush = (atEdge) => {
    if (run.length === 0) return
    const keepBefore = blocks.length === 0 ? 0 : CONTEXT
    const keepAfter = atEdge ? 0 : CONTEXT
    if (run.length > keepBefore + keepAfter + 1) {
      blocks.push(...run.slice(0, keepBefore).map((entry) => ({ entry })))
      blocks.push({ fold: run.slice(keepBefore, run.length - keepAfter) })
      blocks.push(...run.slice(run.length - keepAfter).map((entry) => ({ entry })))
    } else {
      blocks.push(...run.map((entry) => ({ entry })))
    }
    run = []
  }
  for (const entry of lines) {
    if (entry.sign === ' ') { run.push(entry); continue }
    flush(false)
    blocks.push({ entry })
  }
  flush(true)
  return blocks
}

/**
 * One recorded edit drawn as a unified diff: a sign gutter, tinted rows, and
 * long stretches of unchanged lines folded into a row that opens them.
 *
 * Shared by the change panel and the main-area diff so the two can never draw
 * the same edit differently.
 */
export default function DiffLines({ edit, t, wrap = false, className = '', testId = 'session-change-edit' }) {
  const [opened, setOpened] = useState(() => new Set())
  const blocks = foldContext(interleaveEditLines(edit))
  const text = wrap ? 'whitespace-pre-wrap break-all' : 'min-w-max whitespace-pre'
  return (
    <div className={`overflow-auto rounded-control border border-ink/10 bg-[var(--code-bg)] py-1 font-mono text-xs leading-5 ${className}`} data-testid={testId}>
      {blocks.map((block, index) => {
        if (block.fold) {
          if (opened.has(index)) {
            return block.fold.map((entry, foldIndex) => (
              <pre key={`${index}:${foldIndex}`} data-sign=" " className={`flex ${text} ${ROW_CLASS[' ']}`}>
                <span className="w-5 shrink-0 select-none text-center text-ink-fade/70" aria-hidden="true"> </span>
                <span className="pr-3">{entry.line || ' '}</span>
              </pre>
            ))
          }
          return (
            <button
              key={index}
              type="button"
              data-testid="diff-fold"
              onClick={() => setOpened((current) => new Set(current).add(index))}
              className="my-0.5 flex w-full items-center gap-2 bg-ink/[0.03] px-2 py-0.5 text-left text-ink-fade transition-colors hover:bg-ink/[0.06] hover:text-ink-soft"
            >
              <span aria-hidden="true">⋯</span>
              {t('chat.changes.unchangedLines', { count: block.fold.length })}
            </button>
          )
        }
        const { entry } = block
        return (
          <pre key={index} data-sign={entry.sign} className={`flex ${text} ${ROW_CLASS[entry.sign] || ROW_CLASS[' ']}`}>
            <span className="w-5 shrink-0 select-none text-center opacity-70" aria-hidden="true">{entry.sign === ' ' ? '' : entry.sign}</span>
            <span className="pr-3">{entry.line || ' '}</span>
          </pre>
        )
      })}
    </div>
  )
}
