/**
 * Split one assistant message into its top-level completion report and its
 * intermediate ReAct trajectory.
 *
 * Contract decided with the product owner: the model emits **plain text
 * sections only** (`【任务完成报告】` / `【Thought】` / `【Action】` /
 * `【Observation】`), optionally wrapping the intermediate steps in a
 * `<collapsible title="…">…</collapsible>` container. The front end owns every
 * piece of markup.
 *
 * The `<collapsible>` wrapper is treated strictly as a **container marker**: the
 * opening line is consumed like a section marker and the closing line is dropped,
 * so neither ever reaches the rendered text. Nothing the model writes is rendered
 * as HTML — the front end supplies its own disclosure element — so the property
 * that there is nothing to sanitize and nothing that can be injected still holds.
 *
 * Tolerant by design:
 *   - No markers at all (older turns, models that ignore the format, other
 *     flows) ⇒ the whole text is the report and the trajectory is empty, which
 *     keeps every existing rendering path working unchanged.
 *   - Marker-looking text — including `<collapsible>` — inside a fenced code
 *     block stays literal, so a code sample is never eaten.
 *   - Prose before the first marker is preserved in the trajectory rather than
 *     dropped, so nothing the user was shown can silently disappear.
 *   - An unclosed `<collapsible>` still routes everything after it to the
 *     trajectory instead of leaking the rest of the message.
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
// The trajectory container. Occupies its own line; the model may put the title in
// an attribute (rendered by the front end, never taken as markup).
const COLLAPSIBLE_OPEN = /^\s{0,3}<collapsible(?:\s+title\s*=\s*"([^"]*)")?\s*>\s*/iu
const COLLAPSIBLE_CLOSE = /^\s{0,3}<\/collapsible>\s*$/iu

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
    hasMarkers: false,
    report: source,
    reportFound: false,
    trajectory: Object.freeze([]),
    kinds: Object.freeze([]),
    collapsibleTitle: '',
  })
  if (!source.trim()) return empty

  const lines = source.split(/\r?\n/u)
  const sections = []
  let current = null
  let fence = null
  let sawMarker = false
  let sawCollapsible = false
  let collapsibleTitle = ''
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
    // Inside a fence everything above is literal, so a documented
    // `<collapsible>` example is never mistaken for the real container.
    if (fence === null) {
      const opening = COLLAPSIBLE_OPEN.exec(line)
      if (opening) {
        // The wrapper is a container: the opening line becomes a trajectory
        // section (so its body is never mixed into the report) and the closing
        // line is dropped. Neither is ever rendered as markup.
        sawMarker = true
        sawCollapsible = true
        if (!collapsibleTitle && opening[1]) collapsibleTitle = opening[1].trim()
        const remainder = line.replace(COLLAPSIBLE_OPEN, '').trim()
        current = { kind: AGENT_SECTION_KINDS.THOUGHT, lines: remainder ? [remainder] : [] }
        sections.push(current)
        continue
      }
      if (COLLAPSIBLE_CLOSE.test(line)) {
        // Drop the closing line but keep the section open: prose the model
        // appends after the container stays in the trajectory, in order, rather
        // than being moved to the front of it.
        continue
      }
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
  // A container the model emitted is itself a boundary: when it wrapped its
  // steps but never marked the summary, the text outside the container is the
  // user-facing report. Measured against a real turn, models do this — they
  // follow the container instruction and forget the report marker — and without
  // this the interface would hide the whole answer behind the collapsed area.
  const reportOutsideContainer = reportSections.length === 0 && sawCollapsible && leadingProse
    ? leadingProse
    : ''
  if (leadingProse && !reportOutsideContainer) {
    // Keep it, but in the collapsed area: the report must stay free of the
    // model's small talk and of anything it wrote before its own summary.
    trajectory.unshift({ kind: AGENT_SECTION_KINDS.THOUGHT, text: leadingProse })
  }

  return Object.freeze({
    hasMarkers: true,
    report: reportSections.length > 0
      ? reportSections.map((section) => trimmed(section.lines)).filter(Boolean).join('\n\n')
      : reportOutsideContainer,
    reportFound: reportSections.length > 0 || Boolean(reportOutsideContainer),
    trajectory: Object.freeze(trajectory.map((section) => Object.freeze(section))),
    kinds: Object.freeze([...new Set(sections.map((section) => section.kind))]),
    // Plain text from the model, for a caller that wants to label the collapsed
    // area. Never markup.
    collapsibleTitle,
  })
}

/** True when a report marker labels the text, even if the body is empty. */
export function hasCompletionReport(text = '') {
  return parseAgentReportSections(text).reportFound
}
