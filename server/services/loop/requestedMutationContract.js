import { createHash } from 'node:crypto'
import { normalizeMutationTarget, targetsMatch } from './heuristics/mutationClassification.js'

const FILE_REFERENCE = /(?:[`"']([^`"'\r\n]+\.(?:[a-z0-9]{1,12}))|((?:[a-z]:[\\/])?(?:\.{1,2}[\\/]|[\\/])?(?:[^\s`"'<>|?*，。；：！？()[\]{}\\/]+[\\/])*[^\s`"'<>|?*，。；：！？()[\]{}\\/]+\.(?:[a-z0-9]{1,12})))/giu
const WRITE_LEAD = /^(?:(?:please|also|then|and|first|next|finally|only|just|help\s+me|can\s+you|could\s+you|would\s+you)\s+|(?:请|帮我|麻烦你|直接|继续|同时|然后|并且|再|把|将|只|仅|改为|换成)\s*)*(?:(?:update|edit|modify|change|rewrite|write|create|fix|repair|refactor)\b|修改|编辑|更新|改写|写入|创建|新建|修复|重构)/iu
const OBJECT_WRITE = /^(?:(?:请|帮我|麻烦你|直接)\s*)*(?:把|将)([\s\S]+?)(?:都|全部)?(?:修改|更新|修复|重构|改好|改成|改为|覆盖|完善)/u
const STOP_WRITE_TARGETS = /\b(?:from|using|with|based\s+on|according\s+to|instead\s+of)\b|(?:根据|基于|参考|使用)|\b(?:and|then|but)\s+(?:(?:only|just)\s+)?(?:read|inspect|verify|test|check|report|explain|do\s+not|don't)\b|(?:并|然后|但是|但)(?:只|仅)?(?:读取|检查|验证|测试|不要)/iu
const CANCEL_WRITE = /^(?:(?:please|also|then)\s+|(?:请|同时|然后)\s*)*(?:(?:do\s+not|don't|no\s+longer|stop|cancel)\s+(?:edit|update|write|modify|create)\b|(?:不要|别|不再|停止|取消)(?:修改|编辑|更新|写入|创建))/iu
const MAX_TARGETS = 512

function instructionClauses(text) {
  return String(text || '').replace(/```[\s\S]*?```|(?:https?|attachment):\/\/[^\s]+/giu,
    (value) => ' '.repeat(value.length)).split(/[;\r\n。！？!?]+/u).map((value) => value.trim())
}

function references(text) {
  return [...String(text).matchAll(FILE_REFERENCE)].map((match) => (
    normalizeMutationTarget((match[1] || match[2]).replace(/[.,:]+$/u, ''))
  )).filter(Boolean)
}

function boundedTargets(values) {
  const targets = [...new Set(values)]
  if (targets.length > MAX_TARGETS || targets.some((value) => value.length > 4096)) {
    throw Object.assign(new RangeError('Requested-file contract exceeds its evidence storage limits.'), {
      code: 'REQUESTED_MUTATION_CONTRACT_LIMIT', retryable: false,
    })
  }
  return targets
}

function writeBody(clause) {
  const lead = clause.match(WRITE_LEAD)
  const object = !lead && clause.match(OBJECT_WRITE)
  return lead ? clause.slice(lead[0].length).split(STOP_WRITE_TARGETS)[0]
    : object?.[1] || null
}

function exclusiveWrite(content) {
  return instructionClauses(content).some((clause) => {
    const lead = clause.match(WRITE_LEAD)
    if (!lead) return false
    const remainder = clause.slice(lead[0].length)
    const boundary = remainder.search(STOP_WRITE_TARGETS)
    return /^(?:\s*(?:please|also|then)\s+)*(?:only|just)\s+/iu.test(clause)
      || /(?:只|仅|改为|换成)/u.test(lead[0])
      || /^\s*(?:only|just)\b/iu.test(remainder)
      || boundary >= 0 && /^instead\s+of\b/iu.test(remainder.slice(boundary))
      || /\s+instead[.,]?\s*$/iu.test(writeBody(clause) || '')
  })
}

/**
 * Only explicit write clauses establish obligations. Input files following
 * from/using/with and later inspection clauses are not output requirements.
 * General natural-language acceptance remains in goalPlanEvidence.
 */
export function requestedFileMutations(text) {
  const paths = []
  for (const clause of instructionClauses(text)) {
    const body = writeBody(clause)
    if (body !== null) paths.push(...references(body))
  }
  return boundedTargets(paths)
}

function contractHash(text, scope) {
  return createHash('sha256').update(JSON.stringify([
    scope?.userId, scope?.sessionId, scope?.jobId, scope?.projectDirectory, String(text || ''),
  ])).digest('hex')
}

function validPaths(values) {
  return Array.isArray(values) && values.length <= MAX_TARGETS
    && values.every((value) => typeof value === 'string'
      && value.length > 0 && value.length <= 4096 && !value.includes('\0')
      && normalizeMutationTarget(value) === value)
}

/** Host-owned required-file evidence; never activated by a model tool result. */
export function createRequestedMutationContract({
  text = '', scope = {}, enabled = false, restored = null,
} = {}) {
  const hash = contractHash(text, scope)
  const initial = enabled ? requestedFileMutations(text) : []
  let required = initial.length > 1 ? initial : []
  let observed = new Set()
  if (enabled && restored?.sourceHash === hash) {
    if (restored.version !== 1 || !validPaths(restored.required) || !validPaths(restored.observed)
      || restored.observed.some((value) => !restored.required.includes(value))) {
      throw Object.assign(new TypeError('Requested-file evidence checkpoint is invalid.'), {
        code: 'REQUESTED_MUTATION_CONTRACT_INVALID', retryable: false,
      })
    }
    required = [...new Set(restored.required)]
    observed = new Set(restored.observed)
  }
  return Object.freeze({
    missing: () => required.filter((value) => !observed.has(value)),
    satisfied: () => required.every((value) => observed.has(value)),
    record(paths) {
      let matched = false
      for (const target of required) {
        if ((paths || []).some((candidate) => targetsMatch(candidate, target, scope))) {
          observed.add(target)
          matched = true
        }
      }
      return matched
    },
    steer(content) {
      if (!enabled) return
      const added = requestedFileMutations(content)
      const cancelled = instructionClauses(content)
        .filter((clause) => CANCEL_WRITE.test(clause)).flatMap(references)
      required = exclusiveWrite(content) && added.length
        ? added
        : boundedTargets([...required, ...added])
      required = required.filter((target) => !cancelled.some((value) => targetsMatch(value, target, scope)))
      for (const target of [...observed]) {
        if (!required.includes(target)
          || added.some((value) => targetsMatch(value, target, scope))) observed.delete(target)
      }
    },
    snapshot: () => ({
      version: 1, sourceHash: hash, required: [...required], observed: [...observed],
    }),
  })
}
