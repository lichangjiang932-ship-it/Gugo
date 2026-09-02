import { createHash } from 'node:crypto'

import { normalizeToolResult } from './toolCallErrors.js'
import { isPlainObject, safeStringify, toolError } from './toolCallPrimitives.js'

const NON_SUBSTANTIVE_TOOL_NAMES = new Set([
  'manage_todos',
  'reflect',
  'request_clarification',
  'request_directory',
  'sleep_until',
])

const OBSERVATION_TOOL_NAMES = new Set([
  'archive_list',
  'file_hash_manifest',
  'git_diff',
  'git_status',
  'image_info',
  'list_directory',
  'media_probe',
  'pdf_info',
  'pdf_text',
  'read_file',
  'run_project_check',
])

export function isSubstantiveToolCall(call) {
  const name = String(call?.name || '').trim()
  return Boolean(name) && !NON_SUBSTANTIVE_TOOL_NAMES.has(name)
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function callSignature(call) {
  const args = call?.args ?? call?.argumentsText ?? ''
  // Checkpoints persist the last signature so a process restart cannot reset a
  // repeated-call fuse. Store only a digest: commands and tool arguments may
  // contain credentials or large inline file contents.
  return createHash('sha256')
    .update(`${call?.name || '<missing>'}:${safeStringify(stableValue(args))}`)
    .digest('hex')
}

function observationSignature(call, result) {
  const name = String(call?.name || '').trim()
  if (!OBSERVATION_TOOL_NAMES.has(name) || result?.ok !== true) return null
  const args = call?.args && typeof call.args === 'object' ? call.args : {}
  const target = String(
    result?.path
    || result?.filePath
    || result?.file_path
    || args.path
    || args.filePath
    || args.file_path
    || args.cwd
    || '<default>',
  ).trim().replace(/\\/g, '/').toLowerCase()
  const omitEchoFields = new Set([
    'createdAt', 'durationMs', 'elapsedMs', 'end', 'endLine', 'filePath', 'file_path',
    'limit', 'offset', 'path', 'pattern', 'query', 'start', 'startLine', 'updatedAt',
  ])
  const outcome = (value) => {
    if (Array.isArray(value)) return value.map(outcome)
    if (!isPlainObject(value)) return value
    return Object.fromEntries(Object.keys(value)
      .filter((key) => !omitEchoFields.has(key))
      .sort()
      .map((key) => [key, outcome(value[key])]))
  }
  const serialized = safeStringify(outcome(result))
  const bounded = serialized.length <= 131_072
    ? serialized
    : `${serialized.slice(0, 65_536)}:${serialized.slice(-65_536)}`
  return createHash('sha256')
    .update(`${name}:${target}:${bounded}`)
    .digest('hex')
}

function restoredCounter(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : 0
}

const MODEL_AUTHORING_ERROR_CODES = new Set([
  'tool_arguments_validation_failed',
  'invalid_tool_arguments',
  'unknown_tool',
  'tool_arguments_parse_failed',
])

function isModelAuthoringError(result) {
  const code = String(result?.code || '')
  return MODEL_AUTHORING_ERROR_CODES.has(code)
}

function sameToolFailureAdvisory({ tool, count, level }) {
  const guidance = [
    'Analyze the concrete errors before another attempt. Do not keep guessing arguments; choose a materially different strategy.',
    'Stop varying the same approach. Change executor or workflow, verify a new hypothesis, or identify one specific missing prerequisite.',
    'You are approaching the hard no-progress limit. Use a fundamentally different path, request one concrete missing input, or finish with the verified partial result.',
  ][Math.min(Math.max(level, 1), 3) - 1]
  return {
    code: 'tool_failure_strategy_required',
    tool,
    count,
    level,
    content: 'Tool ' + tool + ' has failed ' + count + ' times without recovering. ' + guidance,
  }
}

/** 无进展熔断：同一调用反复出现，或工具连续失败时停止继续烧 token。 */
export function createToolLoopGuard({
  maxRepeatedCalls = 3,
  maxWindowRepeatedCalls = 6,
  repeatWindowSize = 24,
  maxRepeatedObservations = 6,
  observationWindowSize = 24,
  maxConsecutiveErrors = 6,
  maxAuthoringErrors = 20,
  maxSameToolFailures = 20,
  sameToolFailureAdvisoryThresholds = [4, 8, 12],
  initialState = null,
} = {}) {
  const restored = initialState && typeof initialState === 'object' ? initialState : {}
  const sameToolFailureHardLimit = Number.isFinite(Number(maxSameToolFailures))
    ? Math.max(1, Math.floor(Number(maxSameToolFailures)))
    : 20
  const advisoryThresholds = [...new Set(
    Array.isArray(sameToolFailureAdvisoryThresholds)
      ? sameToolFailureAdvisoryThresholds
      : [],
  )]
    .filter((value) => Number.isInteger(value)
      && value >= 1
      && value < sameToolFailureHardLimit)
    .sort((left, right) => left - right)
  const restoreAdvisoryThresholds = (value) => new Map(
    Object.entries(value && typeof value === 'object' ? value : {})
      .map(([name, threshold]) => [
        String(name || '').trim(),
        restoredCounter(threshold),
      ])
      .filter(([name, threshold]) => (
        name && threshold > 0 && threshold < sameToolFailureHardLimit
      )),
  )
  const seenSignatures = new Set()
  const failedToolCounts = new Map(
    Object.entries(restored.failedTools && typeof restored.failedTools === 'object'
      ? restored.failedTools
      : {})
      .map(([name, count]) => [String(name || '').trim(), restoredCounter(count)])
      .filter(([name, count]) => name && count > 0),
  )
  const firedToolAdvisoryThresholds = restoreAdvisoryThresholds(
    restored.firedToolAdvisoryThresholds,
  )
  const pendingToolAdvisoryThresholds = restoreAdvisoryThresholds(
    restored.pendingToolAdvisoryThresholds,
  )
  for (const [name, threshold] of pendingToolAdvisoryThresholds) {
    if (threshold <= (firedToolAdvisoryThresholds.get(name) || 0)) {
      pendingToolAdvisoryThresholds.delete(name)
    }
  }
  let consecutiveErrors = restoredCounter(restored.consecutiveErrors)
  let consecutiveAuthoringErrors = restoredCounter(restored.consecutiveAuthoringErrors)
  let lastSignature = /^[a-f0-9]{64}$/u.test(String(restored.lastSignature || ''))
    ? String(restored.lastSignature)
    : null
  let repeatedCallStreak = lastSignature ? restoredCounter(restored.repeatedCallStreak) : 0
  const safeWindowSize = Math.max(2, Math.floor(Number(repeatWindowSize) || 24))
  const safeWindowRepeatLimit = Math.max(
    Math.floor(Number(maxRepeatedCalls) || 3) + 1,
    Math.floor(Number(maxWindowRepeatedCalls) || 6),
  )
  const recentSignatures = Array.isArray(restored.recentSignatures)
    ? restored.recentSignatures
        .map((value) => String(value || ''))
        .filter((value) => /^[a-f0-9]{64}$/u.test(value))
        .slice(-safeWindowSize)
    : []
  const safeObservationWindowSize = Math.max(
    2,
    Math.floor(Number(observationWindowSize) || 24),
  )
  const safeObservationRepeatLimit = Math.max(
    2,
    Math.floor(Number(maxRepeatedObservations) || 6),
  )
  const recentObservationSignatures = Array.isArray(restored.recentObservationSignatures)
    ? restored.recentObservationSignatures
        .map((value) => String(value || ''))
        .filter((value) => /^[a-f0-9]{64}$/u.test(value))
        .slice(-safeObservationWindowSize)
    : []

  const resetRepetition = () => {
    lastSignature = null
    repeatedCallStreak = 0
    recentSignatures.length = 0
    recentObservationSignatures.length = 0
  }

  return {
    before(call) {
      const signature = callSignature(call)
      seenSignatures.add(signature)
      recentSignatures.push(signature)
      if (recentSignatures.length > safeWindowSize) recentSignatures.shift()
      const windowOccurrences = recentSignatures.reduce(
        (count, candidate) => count + (candidate === signature ? 1 : 0),
        0,
      )
      if (signature === lastSignature) repeatedCallStreak += 1
      else {
        lastSignature = signature
        repeatedCallStreak = 1
      }
      if (repeatedCallStreak > maxRepeatedCalls) {
        const reason = `同一工具调用已连续重复 ${repeatedCallStreak} 次，未取得新进展`
        return {
          ok: false,
          reason,
          result: toolError('repeated_tool_call', reason, {
            retryable: false,
            hint: '请停止重复调用，改用已有结果收尾或换一种方法。',
          }),
        }
      }
      if (windowOccurrences > safeWindowRepeatLimit) {
        const reason = `同一工具调用在最近 ${recentSignatures.length} 次调用中已重复 ${windowOccurrences} 次，未取得实质进展`
        return {
          ok: false,
          reason,
          result: toolError('repeated_tool_call_window', reason, {
            retryable: false,
            hint: '请停止交替重复读取或搜索，改用已有结果执行修改、完成验证或明确报告一个具体阻塞。',
          }),
        }
      }
      if (consecutiveErrors >= maxConsecutiveErrors) {
        const reason = `工具已连续失败 ${consecutiveErrors} 次`
        return {
          ok: false,
          reason,
          result: toolError('tool_error_streak', reason, { retryable: false }),
        }
      }
      if (consecutiveAuthoringErrors >= maxAuthoringErrors) {
        const reason = `模型已连续 ${consecutiveAuthoringErrors} 次写出不合法的工具参数`
        return {
          ok: false,
          reason,
          result: toolError('tool_error_streak', reason, {
            retryable: false,
            hint: '当前模型可能不擅长 function calling，可在 provider 设置里关闭该模型的工具支持，或换一个更大的模型。',
          }),
        }
      }
      return { ok: true }
    },
    after(result, call = null) {
      const normalized = normalizeToolResult(result)
      const failed = normalized.ok === false
      if (!failed) {
        // Reflection, planning, waiting, and clarification do not prove that
        // a failed execution path made progress. Keep the real error streak.
        if (!call || isSubstantiveToolCall(call)) {
          consecutiveErrors = 0
          consecutiveAuthoringErrors = 0
        }
        return { ok: true }
      }
      if (isModelAuthoringError(normalized)) {
        consecutiveAuthoringErrors += 1
        if (consecutiveAuthoringErrors >= maxAuthoringErrors) {
          const reason = '模型已连续 ' + consecutiveAuthoringErrors + ' 次写出不合法的工具参数'
          return {
            ok: false,
            reason,
            result: toolError('tool_error_streak', reason, { retryable: false }),
          }
        }
        return { ok: true }
      }
      consecutiveErrors += 1
      if (consecutiveErrors >= maxConsecutiveErrors) {
        const reason = '工具已连续失败 ' + consecutiveErrors + ' 次'
        return {
          ok: false,
          reason,
          result: toolError('tool_error_streak', reason, { retryable: false }),
        }
      }
      return { ok: true }
    },
    afterCall(call, result) {
      const name = String(call?.name || '').trim()
      if (!name) return { ok: true }
      const normalized = normalizeToolResult(result)
      const failed = normalized.ok === false
      if (!failed) {
        const observation = observationSignature(call, normalized)
        if (observation) {
          recentObservationSignatures.push(observation)
          if (recentObservationSignatures.length > safeObservationWindowSize) {
            recentObservationSignatures.shift()
          }
          const occurrences = recentObservationSignatures.reduce(
            (count, candidate) => count + (candidate === observation ? 1 : 0),
            0,
          )
          if (occurrences > safeObservationRepeatLimit) {
            const reason = `工具 ${name} 在最近 ${recentObservationSignatures.length} 次观察中重复返回相同状态 ${occurrences} 次，未取得新进展`
            return {
              ok: false,
              reason,
              result: toolError('repeated_tool_observation', reason, {
                retryable: false,
                hint: '停止继续改变无关参数；请使用已有观察结果执行下一步、验证交付，或报告一个具体阻塞。',
              }),
            }
          }
        }
        if (isSubstantiveToolCall(call)) {
          failedToolCounts.delete(name)
          firedToolAdvisoryThresholds.delete(name)
          pendingToolAdvisoryThresholds.delete(name)
        }
        return { ok: true }
      }
      if (isModelAuthoringError(normalized)) return { ok: true }
      const count = (failedToolCounts.get(name) || 0) + 1
      failedToolCounts.set(name, count)
      if (count >= sameToolFailureHardLimit) {
        const reason = '工具 ' + name + ' 已连续失败 ' + count + ' 次，达到无进展硬上限'
        return {
          ok: false,
          reason,
          result: toolError('tool_no_progress_hard_limit', reason, {
            retryable: false,
            hint: '停止继续猜测参数；请基于已有结果简短收尾，或明确说明唯一缺失条件。',
          }),
        }
      }
      let threshold = 0
      let level = 0
      for (let index = 0; index < advisoryThresholds.length; index += 1) {
        if (count < advisoryThresholds[index]) break
        threshold = advisoryThresholds[index]
        level = index + 1
      }
      const knownThreshold = Math.max(
        firedToolAdvisoryThresholds.get(name) || 0,
        pendingToolAdvisoryThresholds.get(name) || 0,
      )
      if (threshold <= knownThreshold) return { ok: true }
      pendingToolAdvisoryThresholds.set(name, threshold)
      return { ok: true, advisory: sameToolFailureAdvisory({ tool: name, count, level }) }
    },
    pendingAdvisories() {
      return [...pendingToolAdvisoryThresholds.entries()].map(([tool, threshold]) => {
        const configuredIndex = advisoryThresholds.indexOf(threshold)
        const level = configuredIndex >= 0
          ? configuredIndex + 1
          : Math.max(1, advisoryThresholds.filter((value) => value <= threshold).length)
        return sameToolFailureAdvisory({
          tool,
          level,
          count: failedToolCounts.get(tool) || threshold,
        })
      })
    },
    commitPendingAdvisories() {
      for (const [tool, threshold] of pendingToolAdvisoryThresholds) {
        firedToolAdvisoryThresholds.set(
          tool,
          Math.max(firedToolAdvisoryThresholds.get(tool) || 0, threshold),
        )
      }
      pendingToolAdvisoryThresholds.clear()
    },
    markProgress(call = null) {
      if (!call) {
        resetRepetition()
        return
      }
      const signature = callSignature(call)
      const currentStreak = signature === lastSignature
        ? Math.max(1, repeatedCallStreak)
        : 1
      lastSignature = signature
      repeatedCallStreak = currentStreak
      recentSignatures.splice(
        0,
        recentSignatures.length,
        ...Array(currentStreak).fill(signature).slice(-safeWindowSize),
      )
      recentObservationSignatures.length = 0
    },
    resetRepetition,
    snapshot() {
      return {
        consecutiveErrors,
        consecutiveAuthoringErrors,
        uniqueCalls: seenSignatures.size,
        repeatedCallStreak,
        lastSignature,
        recentSignatures: [...recentSignatures],
        recentObservationSignatures: [...recentObservationSignatures],
        failedTools: Object.fromEntries(failedToolCounts),
        firedToolAdvisoryThresholds: Object.fromEntries(firedToolAdvisoryThresholds),
        pendingToolAdvisoryThresholds: Object.fromEntries(pendingToolAdvisoryThresholds),
      }
    },
  }
}
