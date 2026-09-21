/**
 * Split one assistant message into its top-level completion report and its
 * intermediate ReAct trajectory.
 *
 * Contract decided with the product owner: the model emits **plain text
 * sections only** (`【任务完成报告】` / `【Thought】` / `【Action】` /
 * `【Observation】`) and the front end owns every piece of markup. No custom
 * tags are ever produced by the model, so there is nothing to sanitize into an
 * accordion and nothing that can be injected.
 *
 * Tolerant by design:
 *   - No markers at all (older turns, models that ignore the format, other
 *     flows) ⇒ the whole text is the report and the trajectory is empty, which
 *     keeps every existing rendering path working unchanged.
 *   - Marker-looking text inside a fenced code block stays literal, so a code
 *     sample that contains `【Action】` is never eaten.
 *   - Prose before the first marker is preserved in the trajectory rather than
 *     dropped, so nothing the user was shown can silently disappear.
 */
export const AGENT_SECTION_KINDS = Object.freeze({
  REPORT: 'report', THOUGHT: 'thought', ACTION: 'action', OBSERVATION: 'observation',
})

export const AGENT_REPORT_LABELS = Object.freeze(['任务完成报告', '任務完成報告'])

const SECTION_LABELS = Object.freeze([
  [AGENT_SECTION_KINDS.REPORT, ['任务完成报告', '任務完成報告', 'task completion report', 'completion report']],
  [AGENT_SECTION_KINDS.THOUGHT, ['thought', '思考', '推理']],
  [AGENT_SECTION_KINDS.ACTION, ['action', '行动', '動作', '操作']],
  [AGENT_SECTION_KINDS.OBSERVATION, ['observation', '观察', '觀察', '结果', '結果']],
])

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u
// Optional list bullet / ordered number, then a bracketed label, then an
// optional separator. Both 【】 (what the product spec uses) and [] are accepted.
const MARKER = /^\s{0,3}(?:[-*+]\s+|\d{1,3}[.)]\s+)?[【[]\s*([^】\]]{1,40}?)\s*[】\]]\s*[:：\-—]?\s*/u

function kindForLabel(label) {
  const normalized = String(label || '').trim().toLowerCase().replace(/\s+/gu, ' ')
  if (!normalized) return null
  for (const [kind, labels] of SECTION_LABELS) {
    for (const candidate of labels) {
      const target = candidate.toLowerCase()
      // Full-width labels come from the spec with a trailing "报告"; allow an
      // exact match plus a "报告"-suffixed and "report"-suffixed variant.
      if (normalized === target || normalized === `${target}报告`) return kind
    }
  }
  return null
}

/**
 * @param {string} text
 * @returns {{hasMarkers: boolean, report: string, reportFound: boolean, trajectory: Array<{kind: string, text: string}>, kinds: string[]}}
 */
export function parseAgentReportSections(text = '') {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const empty = Object.freeze({
    hasMarkers: false, report: source, reportFound: false, trajectory: Object.freeze([]), kinds: Object.freeze([]),
  })
  if (!source.trim()) return empty

  const lines = source.split(/\r?\n/u)
  const sections = []
  let current = null
  let fence = null
  let sawMarker = false
  const preamble = []

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      if (current) current.lines.push(line)
      else preamble.push(line)
      continue
    }
    const kind = fence === null ? kindForLabel(MARKER.exec(line)?.[1]) : null
    if (kind) {
      sawMarker = true
      const remainder = line.replace(MARKER, '')
      current = { kind, lines: remainder ? [remainder] : [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }

  if (!sawMarker) return empty

  const trimmed = (values) => values.join('\n').trim()
  const reportSections = sections.filter((section) => section.kind === AGENT_SECTION_KINDS.REPORT)
  const trajectory = sections
    .filter((section) => section.kind !== AGENT_SECTION_KINDS.REPORT)
    .map((section) => ({ kind: section.kind, text: trimmed(section.lines) }))
    .filter((section) => section.text)

  const leadingProse = trimmed(preamble)
  if (leadingProse) {
    // Keep it, but in the collapsed area: the report must stay free of the
    // model's small talk and of anything it wrote before its own summary.
    trajectory.unshift({ kind: AGENT_SECTION_KINDS.THOUGHT, text: leadingProse })
  }

  return Object.freeze({
    hasMarkers: true,
    report: reportSections.map((section) => trimmed(section.lines)).filter(Boolean).join('\n\n'),
    reportFound: reportSections.length > 0,
    trajectory: Object.freeze(trajectory.map((section) => Object.freeze(section))),
    kinds: Object.freeze([...new Set(sections.map((section) => section.kind))]),
  })
}

/** True when a report marker labels the text, even if the body is empty. */
export function hasCompletionReport(text = '') {
  return parseAgentReportSections(text).reportFound
}
