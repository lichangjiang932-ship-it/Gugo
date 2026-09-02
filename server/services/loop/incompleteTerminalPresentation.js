import { normalizeTurnLocale } from '../../../shared/turnLocale.js'

const HAN_TEXT = /[\u3400-\u9fff]/u
const HAN_CHARACTER = /[\u3400-\u9fff]/gu
const EAST_ASIAN_TERMINAL_MARKER = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u
const LATIN_WORD = /[A-Za-z]+(?:'[A-Za-z]+)?/gu
const ENGLISH_PROSE_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'if', 'in', 'is',
  'it', 'not', 'of', 'on', 'or', 'please', 'retry', 'should', 'still', 'than',
  'that', 'the', 'then', 'this', 'to', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'will', 'with', 'you', 'your',
])

function containsEnglishProseSegment(text) {
  return String(text || '').split(/[\n\u3002\uff01\uff1f!?]+/u).some((segment) => {
    const words = segment.match(LATIN_WORD) || []
    if (words.length < 4) return false
    const proseWords = words.reduce((count, word) => (
      count + (ENGLISH_PROSE_WORDS.has(word.toLowerCase()) ? 1 : 0)
    ), 0)
    if (proseWords < 2) return false
    const latinLetters = words.join('').length
    const hanCharacters = (segment.match(HAN_CHARACTER) || []).length
    return latinLetters > Math.max(12, hanCharacters * 2)
  })
}

function localizedReason(locale, reason, fallback) {
  const value = String(reason || '').trim()
  if (normalizeTurnLocale(locale) === 'zh') {
    return HAN_TEXT.test(value) ? value : fallback.zh
  }
  return value && !EAST_ASIAN_TERMINAL_MARKER.test(value) ? value : fallback.en
}

export function localizedTerminalModelText(locale, value, { strictLocale = false } = {}) {
  const text = String(value || '').trim()
  if (!text) return text
  if (normalizeTurnLocale(locale) === 'zh') {
    return strictLocale && (!HAN_TEXT.test(text) || containsEnglishProseSegment(text)) ? '' : text
  }
  return EAST_ASIAN_TERMINAL_MARKER.test(text) ? '' : text
}

const COPY = Object.freeze({
  zh: Object.freeze({
    artifact_delivery_not_converged: '任务尚未完成：所需文件未能成功生成并通过验证，因此未作为最终交付。请重试以继续。',
    deliverable_selection_missing: '文件已生成，但最终交付文件的选择未能收敛。未验证文件和中间文件均未附加到回答中。请重试以继续。',
    directory_resume_not_converged: '目录权限已经授予，但模型恢复后仍重复请求同一授权，且没有执行原任务。本轮未标记为完成。请重试以继续。',
    empty_model_response: '模型未返回可显示内容，本次任务未完成。请重试，或检查当前模型配置。',
    execution_evidence_missing: '任务尚未完成：还没有取得符合本次修改目标的实际执行证据。请重试，或切换到支持工具调用的模型。',
    final_answer_evidence_review_missing: '最终回答尚未通过执行证据一致性检查，因此本轮未标记为完成。请重试以继续。',
    iteration_limit_reached: ({ maxIterations }) => `已达到 ${maxIterations} 轮工具调用上限，任务尚未完成。请重试以继续。`,
    local_html_delivery_validation_failed: '网页文件已写入并保留，但尚未通过资源完整性验证，因此未作为已完成文件交付。请重试以继续自动修复。',
    pdf_layout_verification_missing: '文件已生成，但尚未通过目标页、非目标页、文本边界和逐页渲染的 PDF 布局验证，因此未标记为完成。请重试以继续。',
    reasoning_runaway: '模型推理超过安全上限，任务已停止。请重试，或换用更适合执行工具任务的模型。',
    post_mutation_verification_missing: Object.freeze({
      available: '修改已成功写入并保留，可在文件栏查看；但尚未通过读回、差异检查或项目检查，因此仍标记为待验证。请重试以继续验证。',
      unavailable: '修改已成功写入并保留，可在文件栏查看；当前没有可用的验证工具，因此仍无法确认验证通过。',
    }),
  }),
  en: Object.freeze({
    artifact_delivery_not_converged: 'The task is incomplete because the required file was not successfully generated and verified, so it was not delivered. Retry to continue.',
    deliverable_selection_missing: 'Files were created, but final deliverable selection did not converge. No unverified or intermediate files were attached to the answer. Retry to continue.',
    directory_resume_not_converged: 'Directory access was granted, but after resuming the model requested the same authorization again without executing the original task. This turn was not marked complete. Retry to continue.',
    empty_model_response: 'The model returned no displayable content, so this task is incomplete. Retry, or check the current model configuration.',
    execution_evidence_missing: 'The task is incomplete because there is no execution evidence for the requested change. Retry, or switch to a model that supports tool calls.',
    final_answer_evidence_review_missing: 'The final answer did not pass the execution-evidence consistency review, so this turn was not marked complete. Retry to continue.',
    iteration_limit_reached: ({ maxIterations }) => `The ${maxIterations}-round tool-call limit was reached before the task completed. Retry to continue.`,
    local_html_delivery_validation_failed: 'The web files were written and preserved, but they did not pass resource-integrity validation and were not delivered as completed files. Retry to continue automatic repair.',
    pdf_layout_verification_missing: 'The file was generated, but its PDF layout has not passed target-page, non-target-page, text-boundary, and per-page rendering validation, so it was not marked complete. Retry to continue.',
    reasoning_runaway: 'Model reasoning exceeded the safe limit, so the task was stopped. Retry, or use a model better suited to tool execution.',
    post_mutation_verification_missing: Object.freeze({
      available: 'The changes were written and preserved and are visible in the file panel, but readback, diff, or project checks have not passed, so they remain unverified. Retry to continue verification.',
      unavailable: 'The changes were written and preserved and are visible in the file panel, but no verification tool is currently available, so completion cannot be confirmed.',
    }),
  }),
})

export function formatIncompleteTerminalText(reason, {
  locale,
  fallbackText = '',
  hasVerificationTools = false,
  maxIterations = 0,
  preserveFallbackText = false,
} = {}) {
  const normalizedReason = String(reason || '').trim().toLowerCase()
  const normalizedFallback = String(fallbackText || '').trim()
  if (preserveFallbackText && normalizedFallback) return normalizedFallback
  const localized = COPY[normalizeTurnLocale(locale)][normalizedReason]
  if (typeof localized === 'string') return localized
  if (typeof localized === 'function') {
    return localized({ maxIterations: Math.max(1, Number(maxIterations) || 1) })
  }
  if (localized && typeof localized === 'object') {
    return localized[hasVerificationTools ? 'available' : 'unavailable']
  }
  return localizedTerminalModelText(locale, normalizedFallback, { strictLocale: true })
}

export function partialResultCopy(locale) {
  return normalizeTurnLocale(locale) === 'zh'
    ? Object.freeze({
        heading: '任务中断',
        resultLabel: '已经完成的部分',
        fileLabel: '文件',
        pathLabel: '路径',
        countLabel: '数量',
        defaultToolName: '工具',
        credentialPlaceholder: '[已隐藏凭据]',
        completedSuffix: '已成功完成。',
        labelSeparator: '：',
        itemSeparator: '；',
        listSeparator: '、',
        interruptedText: '后续模型请求未能继续，任务尚未完成。请重试以继续。',
        incompleteText: '任务尚未完成。请重试以继续。',
      })
    : Object.freeze({
        heading: 'Task interrupted',
        resultLabel: 'Completed work',
        fileLabel: 'Files',
        pathLabel: 'Path',
        countLabel: 'Counts',
        defaultToolName: 'tool',
        credentialPlaceholder: '[credential redacted]',
        completedSuffix: 'completed successfully.',
        labelSeparator: ': ',
        itemSeparator: '; ',
        listSeparator: ', ',
        interruptedText: 'A later model request could not continue, so the task is incomplete. Retry to continue.',
        incompleteText: 'The task is incomplete. Retry to continue.',
      })
}

export function priorOutcomeStatusCopy(locale, { blocker = '', verifiedFiles = [] } = {}) {
  const normalizedLocale = normalizeTurnLocale(locale)
  const localizedBlocker = localizedReason(locale, blocker, {
    zh: '上一轮执行未完成',
    en: 'the prior execution did not complete',
  })
  const files = [...new Set((Array.isArray(verifiedFiles) ? verifiedFiles : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
  return normalizedLocale === 'zh'
    ? [
        `上一轮仍未完成：${localizedBlocker}。`,
        files.length > 0
          ? `已确认存在的文件：${files.join('、')}；文件存在不代表整项任务已经完成。`
          : '',
        '在取得新的执行与验证证据前，不能标记为完成。',
      ].filter(Boolean).join('\n')
    : [
        `The prior turn is still incomplete: ${localizedBlocker}.`,
        files.length > 0
          ? `Verified files: ${files.join(', ')}; a file's existence does not mean the entire task is complete.`
          : '',
        'The task cannot be marked complete until new execution and verification evidence is available.',
      ].filter(Boolean).join('\n')
}

export function terminalProtectionCopy(locale) {
  return normalizeTurnLocale(locale) === 'zh'
    ? Object.freeze({
        incompleteTaskText: '任务尚未完成。请重试以继续；若仍失败，请检查模型和工具调用支持。',
        unverifiedFileText: '任务尚未通过最终验收。已提交到本地的文件仍会保留并显示其验证状态；未通过验证的受管理产物不会作为最终交付。请重试以继续。',
        filteredClarificationText: '需要你补充信息后才能继续。已隐藏模型异常收尾时返回的代码内容。',
        filteredCompletedFileText: '文件已通过工具生成并完成交付。已隐藏模型返回的代码内容。',
        filteredCompletedTaskText: '任务已通过工具执行并完成必要验证。已隐藏模型返回的代码内容。',
        clarificationText: '需要你补充信息后才能继续。',
      })
    : Object.freeze({
        incompleteTaskText: 'The task is incomplete. Retry to continue; if it still fails, check model and tool-call support.',
        unverifiedFileText: 'The task has not passed final acceptance. Files written locally are preserved with their verification status, but unverified managed artifacts are not delivered as final output. Retry to continue.',
        filteredClarificationText: 'More information is required before the task can continue. Code returned during an invalid model wrap-up was hidden.',
        filteredCompletedFileText: 'The file was generated and delivered through tools. Code returned by the model was hidden.',
        filteredCompletedTaskText: 'The task was executed through tools and the required verification completed. Code returned by the model was hidden.',
        clarificationText: 'More information is required before the task can continue.',
      })
}

export function budgetExceededCopy(locale, reason) {
  const normalizedReason = localizedReason(locale, reason, {
    zh: '模型调用预算已用尽',
    en: 'the model-call budget was exhausted',
  })
  if (normalizeTurnLocale(locale) === 'zh') {
    return {
      completedModelResponse: '已执行模型返回的最后一批工具调用，但模型 token 预算已用尽。已保存检查点；重试后可从当前进度继续，不会重复已完成的工具调用。',
      wrapUpPrompt: `任务预算已用尽(${normalizedReason})。请基于目前已经取得的进展给出总结：做完了什么、还差什么、建议用户下一步怎么做。不要再调用任何工具。`,
      fallbackText: `(任务预算已用尽：${normalizedReason}。可以点「重试」从断点继续。)`,
    }
  }
  return {
    completedModelResponse: 'The final batch of tool calls returned by the model was executed, but the model token budget is exhausted. A checkpoint was saved; retry to continue from the current progress without repeating completed tool calls.',
    wrapUpPrompt: `The task budget is exhausted (${normalizedReason}). Summarize the progress so far: what was completed, what remains, and what the user should do next. Do not call any tools.`,
    fallbackText: `(Task budget exhausted: ${normalizedReason}. Select “Retry” to continue from the checkpoint.)`,
  }
}
