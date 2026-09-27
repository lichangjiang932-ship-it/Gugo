/**
 * Structured metadata for ReAct steps.
 *
 * The model writes plain text (`path=probe-plan.md bytes=5`); the front end
 * needs typed values to render file cards and badges. Extraction is
 * deliberately conservative: real tool results win over narrative text, and
 * anything unparseable is simply absent — never guessed.
 */

export const FILE_WRITE_TOOL_NAMES = Object.freeze([
  'write_file',
  'edit_file',
  'apply_patch',
  'create_file',
])

const WRITE_NAME_SET = new Set(FILE_WRITE_TOOL_NAMES)

export function isFileWriteToolName(name) {
  return WRITE_NAME_SET.has(String(name || '').trim())
}

export function isFileWriteCall(call) {
  return Boolean(call) && isFileWriteToolName(call.name)
}

function positiveInteger(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null
}

function firstString(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim()
    if (normalized) return normalized
  }
  return null
}

function resultObject(call) {
  const result = call?.result
  return result && typeof result === 'object' && !Array.isArray(result) ? result : {}
}

function resultText(call) {
  const result = call?.result
  if (typeof result === 'string') return result
  return resultObject(call).text ?? resultObject(call).output ?? ''
}

/**
 * `path=probe-plan.md bytes=5` anywhere in free text (result or narration).
 * Only well-known keys are read; unknown keys stay ordinary text.
 */
function textMeta(text) {
  const source = String(text || '')
  const pick = (key) => {
    const match = source.match(new RegExp(`${key}\\s*=\\s*([^\\s,;)]+)`, 'iu'))
    return match ? match[1].trim() : null
  }
  return {
    path: pick('path'),
    bytes: pick('bytes'),
    changes: pick('changes'),
    additions: pick('additions'),
    deletions: pick('deletions'),
    sha256: pick('sha256'),
  }
}

/**
 * The one file a call changed, with its real metrics.
 *
 * Sources in order: tool arguments (the target), the structured tool result
 * (authoritative), then narrative text (`path=… bytes=…`) for output the model
 * wrote about the change. Returns `{ changed: 0 … }` shaped data or null.
 */
export function extractFileOutcome(call) {
  if (!call) return null
  const args = call.args && typeof call.args === 'object' ? call.args : {}
  const result = resultObject(call)
  const fromText = textMeta([resultText(call), call.narration, call.text].filter(Boolean).join('\n'))
  const path = firstString(args.path, args.file_path, args.filePath, result.path, fromText.path)
  if (!path) return null
  const changed = positiveInteger(result.changes)
    ?? positiveInteger(fromText.changes)
    ?? (Array.isArray(result.files) && result.files.length > 0 ? result.files.length : null)
    ?? (isFileWriteToolName(call.name) ? 1 : null)
  const bytes = positiveInteger(result.bytes) ?? positiveInteger(result.written) ?? positiveInteger(fromText.bytes)
  const additions = positiveInteger(result.additions) ?? positiveInteger(fromText.additions)
  const deletions = positiveInteger(result.deletions) ?? positiveInteger(fromText.deletions)
  const sha256 = firstString(result.sha256, result.sha, fromText.sha256)
  return { path, changed, bytes, additions, deletions, sha256, status: String(call.status || '') }
}

/** Every file a call changed — `apply_patch` may touch several at once. */
export function extractFileOutcomes(call) {
  const result = resultObject(call)
  if (Array.isArray(result.files) && result.files.length > 0) {
    const perFile = result.files.map((entry) => (
      entry && typeof entry === 'object' ? extractFileOutcome({ ...call, result: entry }) : null
    )).filter(Boolean)
    if (perFile.length > 0) return perFile
  }
  const single = extractFileOutcome(call)
  return single ? [single] : []
}

/**
 * Compact badges for an observation line: `bytes=5` becomes a `5 B` chip the
 * reader can scan instead of parsing prose.
 */
export function extractStepBadges(text) {
  const meta = textMeta(text)
  const badges = []
  if (meta.changes) badges.push({ key: 'changes', value: meta.changes })
  if (meta.additions) badges.push({ key: 'additions', value: meta.additions })
  if (meta.deletions) badges.push({ key: 'deletions', value: meta.deletions })
  if (meta.bytes) badges.push({ key: 'bytes', value: meta.bytes })
  if (meta.sha256) badges.push({ key: 'sha256', value: String(meta.sha256).slice(0, 12) })
  return badges
}
