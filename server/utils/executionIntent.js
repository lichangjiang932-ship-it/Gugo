export const TURN_INTENT_MODES = Object.freeze(['auto', 'answer', 'execute'])

const TURN_INTENT_MODE_SET = new Set(TURN_INTENT_MODES)
const NUMBERED_STEP_LINE = /^(?:\d+[.)\u3001]|step\s+\d+|\u6b65\u9aa4\s*[0-9\u4e00-\u5341]+)\s*/i
const STEP_EXECUTION_ACTION = /\b(?:implement|integrate|execute|run|apply|fix|create|generate|build|write|save|export|install|enable|open|click|upload|download|delete|rename|move|copy|test|verify|check|update|refactor)\b|(?:\u5b9e\u73b0|\u96c6\u6210|\u63a5\u5165|\u542f\u7528|\u6267\u884c|\u8fd0\u884c|\u4fee\u6539|\u4fee\u590d|\u521b\u5efa|\u751f\u6210|\u6784\u5efa|\u5199\u5165|\u4fdd\u5b58|\u5bfc\u51fa|\u5b89\u88c5|\u6253\u5f00|\u70b9\u51fb|\u4e0a\u4f20|\u4e0b\u8f7d|\u5220\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u590d\u5236|\u6d4b\u8bd5|\u9a8c\u8bc1|\u68c0\u67e5|\u66f4\u65b0|\u91cd\u6784)/i
const DIRECT_EXECUTION_INTENT = /(?:\b(?:implement|execute|run|apply|fix|create|generate|build|write|save|export)\b|(?:\u5b9e\u73b0|\u6267\u884c|\u8fd0\u884c|\u4fee\u590d|\u521b\u5efa|\u751f\u6210|\u6784\u5efa|\u5199\u5165|\u4fdd\u5b58|\u5bfc\u51fa|\u4fee\u6539))(?:[\s\S]{0,160})(?:\b(?:file|page|app|project|script|document|artifact)\b|(?:\u6587\u4ef6|\u7f51\u9875|\u5e94\u7528|\u9879\u76ee|\u811a\u672c|\u6587\u6863|\u4ea7\u7269))/i
const EXTERNAL_ACTION_ORDER = /^(?:\s*(?:please|directly|help\s+(?:me\s+)?|can\s+you|could\s+you|would\s+you|will\s+you)){0,3}\s*(?:send|notify)\b|^\s*(?:(?:\u8bf7|\u76f4\u63a5|\u5e2e\u6211|\u7ed9\u6211|\u4f60\u80fd|\u4f60\u53ef\u4ee5|\u53ef\u4ee5|\u80fd\u5426|\u9ebb\u70e6\u4f60)\s*){0,3}(?:\u53d1\u9001|\u901a\u77e5)/i
const EXTERNAL_MUTATION_INTENT = /\b(?:send|notify|post|publish)\b|(?:\u53d1\u9001|\u901a\u77e5|\u53d1\u5e03)/i
const MUTATION_EXECUTION_INTENT = /\b(?:implement|integrate|enable|apply|fix|handle|resolve|create|generate|build|write|save|export|install|delete|rename|move|copy|update|modify|patch|refactor|improve|optimize|finish|complete)\b|\b(?:wire\s+in|take\s+care\s+of|sort\s+out)\b|(?:\u5b9e\u73b0|\u96c6\u6210|\u63a5\u5165|\u542f\u7528|\u4fee\u6539|\u4fee\u590d|\u521b\u5efa|\u751f\u6210|\u6784\u5efa|\u5199\u5165|\u4fdd\u5b58|\u5bfc\u51fa|\u5b89\u88c5|\u5220\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u590d\u5236|\u66f4\u65b0|\u6253\u8865\u4e01|\u91cd\u6784|\u4f18\u5316|\u5b8c\u5584|\u8865\u5168|\u5904\u7406\u597d|\u641e\u5b9a|\u89e3\u51b3)/i
const NEGATED_MUTATION_CLAUSE = /(?:(?:\b(?:do\s+not|don't|never|without|no\s+need\s+to|must\s+not)\b)|(?:\u4e0d\u8981|\u65e0\u9700|\u4e0d\u5fc5|\u4e0d\u5f97|\u7981\u6b62))[^,.;\uff0c\u3002\uff1b\r\n]{0,120}?(?:\b(?:re-?generate|regenerate|rewrite|implement|integrate|enable|apply|fix|create|generate|build|write|save|export|install|delete|rename|move|copy|update|modify|patch|refactor|improve|optimize)(?:s|d|ed|ing)?\b|(?:\u5b9e\u73b0|\u96c6\u6210|\u63a5\u5165|\u542f\u7528|\u4fee\u6539|\u4fee\u590d|\u521b\u5efa|\u751f\u6210|\u6784\u5efa|\u5199\u5165|\u4fdd\u5b58|\u5bfc\u51fa|\u5b89\u88c5|\u5220\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u590d\u5236|\u66f4\u65b0|\u6253\u8865\u4e01|\u91cd\u6784|\u4f18\u5316|\u505a\u6210|\u6539\u6210|\u6539\u9020(?:\u6210|\u4e3a)?))[^,.;\uff0c\u3002\uff1b\r\n]{0,120}/giu
const FILE_TARGET_REFERENCE = /(?:^|[\s"'`(])(?:[a-z]:[\\/]|\.\.?[\\/]|\/)?(?:[\p{L}\p{N}_@%+.,()[\]{} -]+[\\/])*[\p{L}\p{N}_@%+.,()[\]{} -]+\.[a-z0-9]{1,12}(?=$|[\s"'`),;:，。；：！？])/iu
// 纯文本交付物对象:「生成一份周报/写一段文案」是文字产出,不写文件。
// 生成/创建/写 类动词 + 这些对象 + 没有文件路径时,不该按「文件修改任务」
// 要求工具执行证据 —— 否则纯文本任务永远以 execution_evidence_missing 收尾。
// 注意不要包含「内容/说明/报告」这类可能出现在动作句里的宽泛词
// (如「写入内容」「检查结果」是动作,不是文本交付物)。
const TEXT_DELIVERABLE_TARGET = /(?:\u5468\u62a5|\u65e5\u62a5|\u6708\u62a5|\u603b\u7ed3\u62a5\u544a|\u5de5\u4f5c\u603b\u7ed3|\u603b\u7ed3|\u6982\u8981|\u6587\u6848|\u6587\u7ae0|\u6f14\u8bb2\u7a3f|\u90ae\u4ef6|\u7b80\u5386|\u65b9\u6848|\u8ba1\u5212|\u63d0\u7eb2|\u5927\u7eb2|\u6807\u9898|\u53e3\u53f7|\u6545\u4e8b|\u8bd7\u6b4c|\u8bfb\u4e66\u7b14\u8bb0|\u5fc3\u5f97\u4f53\u4f1a)/i
const IMPERATIVE_EXECUTION_INTENT = /(?:^|[\s,，。；;!！])(?:(?:please\s+|continue\s+|go\s+ahead\s+|help\s+(?:me\s+)?|\u8bf7|\u7ee7\u7eed|\u76f4\u63a5|\u5e2e\u6211|\u628a|\u5c06|\u7ed9\u6211|\u518d)\s*){0,3}(?:implement|integrate|enable|wire\s+in|fix|optimize|improve|finish|complete|update|modify|refactor|build|create|generate|write|save|export|run|execute|apply|install|remove|delete|rename|move|upload|publish|deploy|commit|push|\u5b8c\u5584|\u4f18\u5316|\u4fee\u590d|\u5904\u7406|\u6539\u597d|\u6539\u4e00\u4e0b|\u6539\u6210|\u5b9e\u73b0|\u96c6\u6210|\u63a5\u5165|\u542f\u7528|\u8865\u5168|\u8865\u4e0a|\u89e3\u51b3|\u641e\u5b9a|\u68c0\u67e5|\u6392\u67e5|\u8c03\u6574|\u66f4\u65b0|\u5347\u7ea7|\u91cd\u6784|\u6574\u7406|\u521b\u5efa|\u751f\u6210|\u6784\u5efa|\u5199\u5165|\u4fdd\u5b58|\u5bfc\u51fa|\u6267\u884c|\u8fd0\u884c|\u5b89\u88c5|\u5220\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u4e0a\u4f20|\u53d1\u5e03|\u90e8\u7f72|\u63d0\u4ea4|\u63a8\u9001)/i
const OBJECT_FIRST_EXECUTION_INTENT = /(?:^|[\s,，。；;!！])(?:\u8bf7|\u5e2e\u6211|\u7ee7\u7eed|\u76f4\u63a5)?\s*(?:\u628a|\u5c06).{1,80}(?:\u5904\u7406\u597d|\u6539\u597d|\u6539\u6210|\u5b8c\u5584|\u4f18\u5316|\u4fee\u590d|\u4fee\u6539|\u5b9e\u73b0|\u96c6\u6210|\u63a5\u5165|\u542f\u7528|\u8865\u5168|\u89e3\u51b3|\u641e\u5b9a|\u8c03\u6574|\u66f4\u65b0|\u5347\u7ea7|\u91cd\u6784|\u6574\u7406|\u521b\u5efa|\u751f\u6210|\u6784\u5efa|\u5220\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u4e0a\u4f20|\u53d1\u5e03|\u90e8\u7f72|\u63d0\u4ea4|\u63a8\u9001)/i
const OBJECT_TRANSFORMATION_EXECUTION_INTENT = /(?:^|[\s,，。；;!！])(?:\u8bf7|\u5e2e\u6211|\u7ee7\u7eed|\u76f4\u63a5)?\s*(?:\u628a|\u5c06)[^\u3002\uff01\uff1f!?\n]{1,96}?(?:\u505a\u6210|\u6539\u6210|\u6539\u4e3a|\u6539\u9020(?:\u6210|\u4e3a)|\u53d8\u6210|\u8f6c\u6210|\u8f6c\u4e3a)/i
const ANSWER_ONLY_LEAD = /^\s*(?:(?:\u6211(?:\u53ea\u662f)?\u60f3(?:\u77e5\u9053|\u4e86\u89e3|\u95ee(?:\u4e00\u4e0b)?)|\u53ea\u662f\u60f3(?:\u77e5\u9053|\u4e86\u89e3))\s*[,\uff0c\uff1a:]?\s*|(?:\u8bf7)?(?:\u89e3\u91ca|\u8bf4\u660e|\u4ecb\u7ecd|\u544a\u8bc9\u6211|\u6bd4\u8f83)|(?:\u4ec0\u4e48\u662f|\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u5982\u4f55|\u600e\u4e48|\u80fd\u5426|\u662f\u5426)|(?:what|why|how|explain|describe|compare|tell\s+me|can\s+you|could\s+you)\b)/i
const FOLLOW_UP_EXECUTION = /(?:\u5e76\u4e14|\u5e76|\u7136\u540e|\u540c\u65f6|\u987a\u4fbf|and\s+then|then|also).{0,48}(?:(?:\u8bf7|\u5e2e\u6211|please|help\s+(?:me\s+)?)\s*)?(?:\u5b8c\u5584|\u4f18\u5316|\u4fee\u590d|\u5904\u7406|\u4fee\u6539|\u5b9e\u73b0|\u89e3\u51b3|\u6267\u884c|\u521b\u5efa|\u751f\u6210|fix|implement|apply|update|create|run)/i
const DELEGATED_EXECUTION_INTENT = /^(?:please\s+)?(?:handle|resolve|finish|complete|take\s+care\s+of|sort\s+out)\b|(?:\u4f60\u6765|\u4ea4\u7ed9\u4f60|\u7531\u4f60|\u9ebb\u70e6\u4f60|\u52b3\u70e6\u4f60|\u8bf7\u4f60|\u4f60(?:\u6839\u636e.{0,32})?\u6765(?:\u8fdb\u884c)?|\u4f60(?:\u76f4\u63a5|\u73b0\u5728\u5c31|\u8d1f\u8d23|\u8fdb\u884c)).{0,80}(?:\u5904\u7406\u597d|\u6539\u597d|\u5b8c\u5584|\u4f18\u5316|\u4fee\u590d|\u4fee\u6539|\u5b9e\u73b0|\u8865\u5168|\u89e3\u51b3|\u641e\u5b9a|\u8c03\u6574|\u66f4\u65b0|\u91cd\u6784|\u521b\u5efa|\u751f\u6210|\u6267\u884c)/i

export function normalizeTurnIntentMode(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return TURN_INTENT_MODE_SET.has(normalized) ? normalized : 'auto'
}

export function hasActionableNumberedSteps(text) {
  const steps = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => NUMBERED_STEP_LINE.test(line))
  return steps.length >= 2 && steps.some((line) => STEP_EXECUTION_ACTION.test(line))
}

export function shouldRequireExecution({ intentMode = 'auto', text = '' } = {}) {
  const mode = normalizeTurnIntentMode(intentMode)
  if (mode === 'execute') return true
  if (mode === 'answer') return false

  const prompt = String(text || '').trim()
  if (!prompt) return false
  // Mutation verbs inside an explicit prohibition are constraints, not work
  // orders. Strip only the negated clause so mixed prompts remain executable:
  // "do not edit A; create B" still retains the affirmative second clause.
  const actionablePrompt = prompt.replace(NEGATED_MUTATION_CLAUSE, ' ').trim()
  if (!actionablePrompt) return false
  if (hasActionableNumberedSteps(actionablePrompt)) return true
  if (DIRECT_EXECUTION_INTENT.test(actionablePrompt)) return true
  if (EXTERNAL_ACTION_ORDER.test(actionablePrompt)) return true
  if (MUTATION_EXECUTION_INTENT.test(actionablePrompt) && FILE_TARGET_REFERENCE.test(actionablePrompt)) return true
  if (DELEGATED_EXECUTION_INTENT.test(actionablePrompt)) return true
  // A question may be followed by a separate, explicit work order. Inspect the
  // text after the first sentence boundary so the leading "How/如何" does not
  // downgrade "Please fix it now/直接帮我修复好" to an answer-only request.
  const firstBoundary = actionablePrompt.search(/[?\uff1f.!\u3002;\uff1b\n]/)
  const laterClause = firstBoundary >= 0 ? actionablePrompt.slice(firstBoundary + 1).trim() : ''
  const hasLaterExecutionOrder = Boolean(laterClause) && (
    IMPERATIVE_EXECUTION_INTENT.test(laterClause)
    || OBJECT_FIRST_EXECUTION_INTENT.test(laterClause)
    || OBJECT_TRANSFORMATION_EXECUTION_INTENT.test(laterClause)
    || DELEGATED_EXECUTION_INTENT.test(laterClause)
  )
  const hasFollowUpExecution = FOLLOW_UP_EXECUTION.test(actionablePrompt) || hasLaterExecutionOrder
  if (!IMPERATIVE_EXECUTION_INTENT.test(actionablePrompt)
    && !OBJECT_FIRST_EXECUTION_INTENT.test(actionablePrompt)
    && !OBJECT_TRANSFORMATION_EXECUTION_INTENT.test(actionablePrompt)
    && !hasFollowUpExecution) return false
  if (ANSWER_ONLY_LEAD.test(actionablePrompt) && !hasFollowUpExecution) return false
  return true
}

export function hasMutationExecutionIntent(text = '') {
  // A verification-only follow-up often says "do not regenerate/write". The
  // mutation words inside that prohibition are constraints, not a fresh write
  // order. Clause boundaries keep mixed requests safe: "do not edit A; create
  // B" still retains the affirmative creation clause.
  const prompt = String(text || '').replace(NEGATED_MUTATION_CLAUSE, ' ')
  if (ANSWER_ONLY_LEAD.test(prompt) && !shouldRequireExecution({ text: prompt })) return false
  return MUTATION_EXECUTION_INTENT.test(prompt)
    || EXTERNAL_MUTATION_INTENT.test(prompt)
    || OBJECT_TRANSFORMATION_EXECUTION_INTENT.test(prompt)
}

/** 是否提到带扩展名的文件/路径目标。 */
export function hasFileTargetReference(text = '') {
  return FILE_TARGET_REFERENCE.test(String(text || ''))
}

/**
 * 纯文本交付物:生成/写类动词指向报告、总结、文案等文字对象,
 * 且没有带扩展名的文件路径 —— 文字本身就是交付物,不要求工具执行。
 */
export function isTextDeliverableRequest(text = '') {
  const prompt = String(text || '').trim()
  return Boolean(prompt)
    && TEXT_DELIVERABLE_TARGET.test(prompt)
    && !hasFileTargetReference(prompt)
}
