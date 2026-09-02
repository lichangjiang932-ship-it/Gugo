import { partialResultCopy } from './loop/incompleteTerminalPresentation.js'

const INTERNAL_FAILURE_PATTERNS = [
  /Model call failed\s*:/i,
  /This reply could not be completed/i,
  /The requested (?:file|artifact|mutation).*?(?:was not|could not|failed)/i,
  /ARTIFACT_NOT_CREATED/i,
  /(?:^|\n)\s*(?:Error|Exception|TypeError|RangeError|AbortError)\s*:/i,
  /任务未完全完成[^\n]*(?:保留|保存)/,
  /(?:已保留|保存当前)[^\n]*(?:残缺|文件|进展|工具结果)/,
]

const SOURCE_OR_CONFIG_PATTERNS = [
  /```[\s\S]*```/,
  /<(?:!doctype\s+html|html\b|head\b|body\b|script\b|style\b)/i,
  /(?:^|\n)\s*(?:import|export|const|let|var|function|class)\s+[\w$]/m,
  /(?:^|\n)\s*(?:def|class)\s+\w+\s*(?:\(|:)/m,
  /^\s*(?:\[|\{)[\s\S]*(?:\]|\})\s*$/,
]

const CREDENTIAL_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^\s,;"'}]{4,}/gi,
]

const PATH_ARGUMENT_KEYS = [
  'path',
  'file',
  'filePath',
  'file_path',
  'filename',
  'outputPath',
  'output_path',
  'destination',
  'directory',
  'target',
]

const RESULT_PATH_KEYS = [
  'outputPath',
  'output_path',
  'filePath',
  'file_path',
  'path',
  'filename',
]

const COUNT_FIELD_PATTERN = /(?:^|_)(?:count|total|size|bytes|files?|items?|rows?|pages?|slides?|images?|records?|matches?|changed|additions|deletions)(?:$|_)/i

const HIGH_VALUE_TOOL_PATTERN = /^(?:create_|generate_|render_|write_|edit_|patch_|apply_patch$|file_(?:upload|download|copy|move)|copy_|move_|mkdir|git_(?:write|commit|push)|media_transform$)/i
const VERIFICATION_TOOL_PATTERN = /^(?:run_project_check$|git_diff$|git_status$|media_probe$|browser_(?:snapshot|screenshot)|verify_|validate_|inspect_)/i

function safeToolName(value) {
  const name = String(value || '').trim()
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) ? name : '工具'
}

function redactCredentials(value) {
  let text = String(value || '')
  for (const pattern of CREDENTIAL_PATTERNS) text = text.replace(pattern, '[已隐藏凭据]')
  text = text.replace(/([?&](?:token|key|signature|sig|credential|auth)=)[^&#\s]+/gi, '$1[已隐藏凭据]')
  return text
}

function sanitizeText(value, { maxLength = 500, rejectSource = true } = {}) {
  const raw = String(value ?? '').replace(/\0/g, '').trim()
  if (!raw || INTERNAL_FAILURE_PATTERNS.some((pattern) => pattern.test(raw))) return ''
  if (rejectSource && SOURCE_OR_CONFIG_PATTERNS.some((pattern) => pattern.test(raw))) return ''
  return redactCredentials(raw).replace(/\s+/g, ' ').slice(0, maxLength)
}

function sanitizePath(value) {
  const text = sanitizeText(value, { maxLength: 500, rejectSource: true })
  if (!text || /[\r\n]/.test(String(value ?? ''))) return ''
  return text
}

function normalizeCall(callOrName) {
  if (callOrName && typeof callOrName === 'object') {
    return {
      name: safeToolName(callOrName.name || callOrName.function?.name),
      args: callOrName.args && typeof callOrName.args === 'object'
        ? callOrName.args
        : callOrName.arguments && typeof callOrName.arguments === 'object'
          ? callOrName.arguments
          : {},
    }
  }
  return { name: safeToolName(callOrName), args: {} }
}

function firstSafePath(source, keys) {
  if (!source || typeof source !== 'object') return ''
  for (const key of keys) {
    if (!Object.hasOwn(source, key)) continue
    const value = source[key]
    if (Array.isArray(value)) {
      const paths = value.map(sanitizePath).filter(Boolean)
      if (paths.length) return paths.slice(0, 3).join('、')
      continue
    }
    const path = sanitizePath(value)
    if (path) return path
  }
  return ''
}

function resultPaths(result) {
  if (!result || typeof result !== 'object') return []
  const paths = []
  const direct = firstSafePath(result, RESULT_PATH_KEYS)
  if (direct) paths.push(direct)
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : []
  for (const artifact of artifacts.slice(0, 3)) {
    const path = firstSafePath(artifact, [...RESULT_PATH_KEYS, 'url'])
    if (path) paths.push(path)
  }
  return [...new Set(paths)].slice(0, 3)
}

function resultCounts(result) {
  if (!result || typeof result !== 'object') return []
  const counts = []
  for (const [key, value] of Object.entries(result)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    if (!COUNT_FIELD_PATTERN.test(normalizedKey) || typeof value !== 'number' || !Number.isFinite(value)) continue
    counts.push(`${sanitizeText(key, { maxLength: 60, rejectSource: false })}=${value}`)
    if (counts.length >= 4) break
  }
  return counts
}

function buildEntry(callOrName, result, copy) {
  if (!result || result.ok === false) return ''
  const call = normalizeCall(callOrName)
  const callPath = firstSafePath(call.args, PATH_ARGUMENT_KEYS)
  const paths = resultPaths(result)
  const counts = resultCounts(result)

  // read_file output is deliberately opaque. Its data/content/text/value/
  // message fields may contain source, configuration or credentials. Only
  // the requested path and numeric metadata can be retained.
  const summary = call.name === 'read_file'
    ? ''
    : sanitizeText(result.summary, { maxLength: 500, rejectSource: true })

  const details = []
  if (summary) details.push(summary)
  if (paths.length) details.push(`${copy.fileLabel}${copy.labelSeparator}${paths.join(copy.listSeparator)}`)
  else if (callPath) details.push(`${copy.pathLabel}${copy.labelSeparator}${callPath}`)
  if (counts.length) details.push(`${copy.countLabel}${copy.labelSeparator}${counts.join(copy.listSeparator)}`)
  return details.length
    ? `${call.name}${copy.labelSeparator}${details.join(copy.itemSeparator)}`
    : `${call.name} ${copy.completedSuffix}`
}

function sanitizeRestoredEntry(entry) {
  if (typeof entry !== 'string') return ''
  return sanitizeText(entry, { maxLength: 800, rejectSource: true })
}

function entryPriority(toolName) {
  const name = safeToolName(toolName)
  if (HIGH_VALUE_TOOL_PATTERN.test(name)) return 3
  if (VERIFICATION_TOOL_PATTERN.test(name)) return 2
  if (/^(?:read_|list_|search_|find_|glob|grep|rg$)/i.test(name)) return 1
  return 2
}

function restoredEntryPriority(entry) {
  const name = String(entry || '').split(/[：\s]/, 1)[0]
  return entryPriority(name)
}

export function createPartialResultFallback({
  heading,
  resultLabel,
  locale = 'zh',
  maxEntries = 8,
  entries: restoredEntries = [],
} = {}) {
  const copy = partialResultCopy(locale)
  const safeHeading = sanitizeText(heading, { maxLength: 80, rejectSource: true }) || copy.heading
  const safeResultLabel = sanitizeText(resultLabel, { maxLength: 80, rejectSource: true }) || copy.resultLabel
  const entryLimit = Math.min(32, Math.max(1, Number(maxEntries) || 8))
  const entries = []

  const addEntry = (text, priority) => {
    if (!text || entries.some((entry) => entry.text === text)) return false
    const item = { text, priority }
    if (entries.length < entryLimit) {
      entries.push(item)
      return true
    }

    // Long jobs often start with many reads and only produce writes or
    // verification evidence near the end. Keep the most recent evidence at
    // the same priority and always let a higher-value result replace a lower
    // value discovery entry.
    const lowest = Math.min(...entries.map((entry) => entry.priority))
    if (priority < lowest) return false
    const replaceAt = entries.findIndex((entry) => entry.priority === lowest)
    if (replaceAt < 0) return false
    entries.splice(replaceAt, 1)
    entries.push(item)
    return true
  }

  for (const entry of Array.isArray(restoredEntries) ? restoredEntries : []) {
    const safeEntry = sanitizeRestoredEntry(entry)
    addEntry(safeEntry, restoredEntryPriority(safeEntry))
  }

  return {
    record(callOrName, result) {
      const entry = buildEntry(callOrName, result, copy)
      const call = normalizeCall(callOrName)
      addEntry(entry, entryPriority(call.name))
      return entry
    },

    snapshot() {
      return entries.map((entry) => sanitizeRestoredEntry(entry.text)).filter(Boolean)
    },

    apply(result) {
      const shouldApply = result?.interrupted === true
        || result?.incomplete === true
        || result?.budgetExceeded === true
        || result?.noProgress === true
      if (!shouldApply) return result
      const progress = entries.length > 0
        ? `\n\n${safeResultLabel}${copy.labelSeparator}\n${entries.map((entry) => `- ${entry.text}`).join('\n')}`
        : ''
      const existingText = String(result?.text || '').trim()
      const alreadyHasProgress = existingText.includes(`${safeResultLabel}${copy.labelSeparator}`)
      const baseText = result?.interrupted === true && !alreadyHasProgress
        ? `${safeHeading}${copy.labelSeparator}${copy.interruptedText}`
        : existingText || `${safeHeading}${copy.labelSeparator}${copy.incompleteText}`
      return {
        ...result,
        text: `${baseText}${alreadyHasProgress ? '' : progress}`,
      }
    },
  }
}
