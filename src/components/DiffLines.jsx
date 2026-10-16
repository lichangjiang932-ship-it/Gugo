import { useState } from 'react'
import { interleaveEditLines } from '../lib/sessionChanges.js'

// A diff reads like a code review: the row is tinted by its sign and the code
// stays dark, so the eye lands on the change rather than on a coloured line.
// The sign keeps its accent; the tint carries the rest.
const ROW_CLASS = Object.freeze({
  '+': 'bg-success/10',
  '-': 'bg-danger/10',
  ' ': '',
})

const SIGN_CLASS = Object.freeze({
  '+': 'text-success',
  '-': 'text-danger',
  ' ': '',
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
 * One recorded edit drawn as a unified diff: a sign column and rows tinted by
 * their sign with the code kept dark — the way a review tool draws a change.
 * Long stretches of unchanged lines fold into a row that opens them.
 *
 * Shared by the change panel and the main-area diff so the two can never draw
 * the same edit differently.
 */
export default function DiffLines({ edit, t, wrap = false, fold = true, className = '', testId = 'session-change-edit' }) {
  const [opened, setOpened] = useState(() => new Set())
  const lines = interleaveEditLines(edit)
  // A file shown as its plain current content has no change to fold around.
  const blocks = fold ? foldContext(lines) : lines.map((entry) => ({ entry }))
  const text = wrap ? 'whitespace-pre-wrap break-all' : 'min-w-max whitespace-pre'
  return (
    <div className={`overflow-auto rounded-control border border-ink/10 bg-[var(--code-bg)] font-mono text-[0.8125rem] leading-6 ${className}`} data-testid={testId}>
      {blocks.map((block, index) => {
        if (block.fold) {
          if (opened.has(index)) {
            return block.fold.map((entry, foldIndex) => (
              <Row key={`${index}:${foldIndex}`} entry={entry} text={text} />
            ))
          }
          return (
            <button
              key={index}
              type="button"
              data-testid="diff-fold"
              onClick={() => setOpened((current) => new Set(current).add(index))}
              className="flex w-full items-center gap-2 bg-ink/[0.03] px-3 py-1 text-left text-xs text-ink-fade transition-colors hover:bg-ink/[0.06] hover:text-ink-soft"
            >
              <span aria-hidden="true">⋯</span>
              {t('chat.changes.unchangedLines', { count: block.fold.length })}
            </button>
          )
        }
        return <Row key={index} entry={block.entry} text={text} />
      })}
    </div>
  )
}

function Row({ entry, text }) {
  const sign = entry.sign
  return (
    <pre data-sign={sign} className={`flex ${text} ${ROW_CLASS[sign] || ''} text-ink`}>
      <span className={`w-5 shrink-0 select-none text-center ${SIGN_CLASS[sign] || ''}`} aria-hidden="true">{sign === ' ' ? '' : sign}</span>
      <span className="pr-4">{entry.line || ' '}</span>
    </pre>
  )
}
