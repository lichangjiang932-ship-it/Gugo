import {
  hasMutationExecutionIntent,
  isExecutionCapabilityChallenge,
  normalizeTurnIntentMode,
  shouldRequireExecution,
} from '../utils/executionIntent.js'
import { getToolMetadata } from './toolRegistry.js'

const ORCHESTRATION_TOOL_NAMES = new Set(['Agent', 'manage_todos'])
const ANSWER_RECOVERY_TOOL_NAMES = new Set(['request_clarification', 'request_directory'])

// Keep the authorized local editing harness model-visible on every chat round.
// This is a visibility contract, not an execution obligation: answer/read-only
// turns may ignore these tools, and the normal permission/approval gates still
// govern every call. The selector only retains specs that survived upstream
// configuration and permission filtering; it never restores a disabled tool.
const ALWAYS_VISIBLE_LOCAL_EXECUTION_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'patch_file',
  'bash_exec',
  'run_command',
  'run_project_check',
  'run_test',
])

const EXPLICIT_READ_ONLY = /\b(?:read[- ]only|no[- ]write)\b|\b(?:do not|don't|never|without)\b.{0,24}\b(?:change|modify|edit|write|delete|remove|rename|move|patch|mutate)\b|\u53ea\u8bfb|\u4ec5(?:\u67e5\u770b|\u5206\u6790|\u68c0\u67e5)|\u4e0d\u8981.{0,16}(?:\u4fee\u6539|\u7f16\u8f91|\u5199\u5165|\u5220\u9664|\u79fb\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u6253\u8865\u4e01|\u6539\u52a8|\u53d8\u66f4|\u4fee\u590d)/i
const ANALYSIS_ONLY_REQUEST = /^\s*(?:\u8bf7)?\s*(?:\u5206\u6790|\u89e3\u91ca|\u8bf4\u660e|\u8bc4\u4f30|\u5ba1\u67e5|\u8ba8\u8bba|\u68b3\u7406|\u603b\u7ed3|\u5217\u51fa|\u8bc6\u522b)/i
const LOCAL_FILE_TARGET_REFERENCE = /(?:^|[\s"'`(])(?:[a-z]:[\\/]|\.\.?[\\/]|\/)(?:[^\r\n"'`]+[\\/])*[^\r\n"'`]+\.[a-z0-9]{1,12}(?=$|[\s"'`),;:\uff0c\u3002\uff1b\uff1a\uff01\uff1f])/iu
const LOCAL_LAYOUT_WRITE_BOUNDARY = /\b(?:do not|don't|never)\s+write\s+(?:below|above|outside|past|beyond|within|inside|in|on)\b[^\r\n.!?]{0,80}\b(?:line|margin|box|area|region|field|space|page|section)\b[^\r\n.!?]*/gi
const SCOPED_READ_ONLY_VERIFIER = /(?:\b(?:separate|independent)\s+)?\bread[- ]only\b(?=\s+(?:(?:verification|validation|checker|validator|script|tool)\b|[\w.-]*(?:verify|validat|check)[\w.-]*\.(?:py|js|ts|mjs|cjs|sh|ps1)\b))|(?:\u53e6\u5199|\u53e6\u5efa|\u5355\u72ec|\u72ec\u7acb|\u53e6\u5916)?\s*\u53ea\u8bfb(?=\s*(?:(?:\u9a8c\u8bc1|\u6821\u9a8c|\u68c0\u67e5)(?:\u811a\u672c|\u5668|\u7a0b\u5e8f|\u5de5\u5177)?|[\w.-]*(?:verify|validat|check)[\w.-]*\.(?:py|js|ts|mjs|cjs|sh|ps1)\b))/gi
const GLOBAL_READ_ONLY = /\b(?:do not|don't|never)\b[^\r\n.!?;]{0,48}\b(?:change|modify|edit|write|delete|remove|rename|move|patch|mutate)\b[^\r\n.!?;]{0,32}\b(?:any|all)\s+(?:files?|documents?|artifacts?)\b|\b(?:read[- ]only|no[- ]write)\b[^\r\n.!?;]{0,32}\b(?:entire|whole|all)\s+(?:project|repository|repo|workspace)\b|\b(?:entire|whole)\s+(?:project|repository|repo|workspace)\b[^\r\n.!?;]{0,32}\b(?:read[- ]only|no[- ]write)\b|(?:\u4e0d\u8981|\u4e0d\u5f97|\u7981\u6b62)[^\r\n\u3002\uff1b]{0,32}(?:\u4fee\u6539|\u7f16\u8f91|\u5199\u5165|\u5220\u9664|\u79fb\u52a8|\u91cd\u547d\u540d)[^\r\n\u3002\uff1b]{0,24}(?:\u4efb\u4f55|\u6240\u6709)(?:\u6587\u4ef6|\u6587\u6863|\u4ea7\u7269)|(?:\u6574\u4e2a|\u5168\u90e8)(?:\u9879\u76ee|\u4ed3\u5e93|\u5de5\u4f5c\u533a)[^\r\n\u3002\uff1b]{0,24}(?:\u53ea\u8bfb|\u4ec5\u67e5\u770b|\u4ec5\u5206\u6790|\u4e0d\u8981\u4fee\u6539)/i
const SCOPED_SOURCE_READ_ONLY_BOUNDARY = /\b(?:do not|don't|never)\b[^\r\n.!?;]{0,40}\b(?:change|modify|edit|write|delete|remove|rename|move|patch|mutate)\b[^\r\n.!?;]{0,24}\b(?:the\s+|this\s+)?(?:source|input|original)\s+(?:pdf|file|document|image)\b|(?:\u4e0d\u8981|\u4e0d\u5f97|\u7981\u6b62)[^\r\n\u3002\uff1b]{0,32}(?:\u4fee\u6539|\u7f16\u8f91|\u5199\u5165|\u8986\u76d6|\u5220\u9664|\u79fb\u52a8|\u91cd\u547d\u540d)[^\r\n\u3002\uff1b]{0,24}(?:\u6e90|\u8f93\u5165|\u539f\u59cb)(?:\s*PDF|\u6587\u4ef6|\u6587\u6863|\u56fe\u7247)/i
const SCOPED_CONTENT_PRESERVATION_BOUNDARY = /\b(?:do not|don't|never)\b[^\r\n.!?;]{0,40}\b(?:change|modify|edit|rewrite|alter)\b[^\r\n.!?;]{0,24}\b(?:the\s+|this\s+)?(?:article(?:'s)?(?:\s+(?:content|text|wording))?|body(?:\s+(?:content|text))?|copy|wording|text\s+content)\b|(?:\u4e0d\u8981|\u4e0d\u5f97|\u7981\u6b62)[^\r\n\u3002\uff1b]{0,24}(?:\u4fee\u6539|\u7f16\u8f91|\u6539\u52a8|\u53d8\u66f4|\u6539\u5199)[^\r\n\u3002\uff1b]{0,20}(?:(?:\u8fd9\u7bc7|\u8be5\u7bc7|\u539f\u59cb|\u6e90)?\u6587\u7ae0(?:\u7684)?(?:\u5185\u5bb9|\u6587\u5b57|\u63aa\u8f9e)?|\u6b63\u6587(?:\u7684)?(?:\u5185\u5bb9|\u6587\u5b57|\u63aa\u8f9e)?|\u539f\u6587(?:\u7684)?(?:\u5185\u5bb9|\u6587\u5b57|\u63aa\u8f9e)?|\u6587\u672c\u5185\u5bb9|\u6587\u5b57\u5185\u5bb9|\u6587\u6848|\u63aa\u8f9e)/i
const SCOPED_CONTENT_FIDELITY_BOUNDARY = /\b(?:preserve|keep|retain)\b[^\r\n.!?;]{0,80}\b(?:article|body|text|wording|content)\b[^\r\n.!?;]{0,80}\b(?:do not|don't|never)\b[^\r\n.!?;]{0,32}\b(?:change|modify|edit|polish|delete|remove|add|rewrite|alter)\b[^\r\n.!?;]{0,32}\b(?:content|text|wording|paragraphs?|spelling|grammar|punctuation)\b|(?:\u4fdd\u7559|\u4fdd\u6301)[^\r\n\u3002\uff1b]{0,80}(?:\u6587\u7ae0|\u6b63\u6587|\u539f\u6587)[^\r\n\u3002\uff1b]{0,80}(?:\u4e0d\u8981|\u4e0d\u5f97|\u7981\u6b62)[^\r\n\u3002\uff1b]{0,32}(?:\u4fee\u6539|\u7f16\u8f91|\u6da6\u8272|\u5220\u51cf|\u589e\u52a0|\u6539\u5199)[^\r\n\u3002\uff1b]{0,24}(?:\u5185\u5bb9|\u6587\u5b57|\u6bb5\u843d|\u62fc\u5199|\u8bed\u6cd5|\u6807\u70b9)/i
const READ_ONLY_EXPLANATION_QUESTION = /^(?:(?:\u8bf7)?(?:\u89e3\u91ca|\u8bf4\u660e)?\s*(?:\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u600e\u4e48)|(?:can\s+you\s+)?(?:explain\s+)?(?:why|how)).*(?:\u53ea\u8bfb|read[- ]only).*[?\uff1f]\s*$/iu
const EXECUTION_CONTINUATION = /^(?:continue(?:\s+(?:with\s+)?(?:it|this|the\s+(?:work|changes?|implementation)))?|go\s+ahead|proceed|approved?|i\s+(?:approve|authorize\s+you)(?:\s+to\s+(?:continue|proceed|execute|make\s+the\s+changes?))?|\u7ee7\u7eed(?:\u6267\u884c|\u5904\u7406|\u4fee\u6539|\u5b8c\u6210|\u505a|\u4e0b\u53bb)?(?:\u5427)?|\u6211(?:\u540c\u610f|\u6279\u51c6|\u6388\u6743\u7ed9\u4f60)(?:[\s,\uff0c]*(?:\u7ee7\u7eed|\u6267\u884c|\u4fee\u6539|\u5904\u7406|\u64cd\u4f5c))?|\u6388\u6743\u7ed9\u4f60(?:[\s,\uff0c]*(?:\u7ee7\u7eed|\u6267\u884c|\u4fee\u6539|\u5904\u7406|\u64cd\u4f5c))?)[.!?\u3002\uff01\uff1f\s]*$/i
const EXECUTION_REVISION = /^(?:(?:(?:\u628a|\u5c06)?(?:\u5b83|\u8fd9\u4e2a|\u8be5)?(?:\u9875\u9762|\u7f51\u7ad9|\u7f51\u9875|\u6587\u4ef6|\u56fe\u7247|\u80cc\u666f|\u989c\u8272|\u5b57\u4f53|\u5e03\u5c40|\u52a8\u753b|\u6548\u679c|\u5361\u7247)?\s*(?:\u518d|\u7a0d\u5fae|\u66f4|\u6709\u70b9)(?:\u6df1|\u6d45|\u5927|\u5c0f|\u4eae|\u6697|\u5feb|\u6162|\u7acb\u4f53|\u5706\u6da6|\u7d27\u51d1|\u6e05\u6670|\u660e\u663e|\u7a81\u51fa|\u73b0\u4ee3|\u7b80\u6d01)(?:\u4e00\u70b9|\u4e00\u4e9b|\u70b9|\u4e9b)?|(?:\u628a|\u5c06)?(?:\u5b83|\u8fd9\u4e2a|\u8be5)?(?:\u9875\u9762|\u7f51\u7ad9|\u7f51\u9875|\u6587\u4ef6|\u56fe\u7247|\u80cc\u666f|\u989c\u8272|\u5b57\u4f53|\u5e03\u5c40|\u52a8\u753b|\u6548\u679c|\u5361\u7247)?\s*(?:\u6362\u6210|\u6539\u6210|\u8c03\u6210|\u505a\u6210|\u52a0\u6df1|\u8c03\u6697|\u589e\u52a0|\u6dfb\u52a0|\u52a0\u4e0a|\u53bb\u6389|\u5220\u9664|\u79fb\u9664|\u8c03\u6574|\u4f18\u5316|\u5b8c\u5584|\u4fee\u6539|\u4fee\u590d|\u66ff\u6362).{0,100})|(?:(?:make|change|turn|set)\s+(?:it|this|the\s+(?:page|site|file|image|background|color|layout))\b.{0,100}|(?:a\s+(?:little|bit)\s+)?(?:darker|lighter|bigger|smaller|faster|slower|clearer|rounder|more\s+(?:dynamic|compact|modern|prominent|three-dimensional))|(?:add|remove|delete|replace|adjust|tweak|revise|update)\b.{0,100}))[.!?\u3002\uff01\uff1f\s]*$/iu
// Follow-up revisions are often phrased as an invariant instead of an edit
// command (for example, "no matter how I rotate it, every image must keep
// facing me"). This pattern is deliberately usable only through
// shouldInheritExecutionIntent, where a real preceding execution request is
// required and explicit answer/read-only modes still win.
const EXECUTION_REVISION_REQUIREMENT = /^(?:(?:\u65e0\u8bba|\u4e0d\u7ba1).{1,120}(?:\u56fe\u7247|\u56fe\u50cf|\u5361\u7247|\u9875\u9762|\u7f51\u9875|\u52a8\u753b|\u5143\u7d20|\u6587\u5b57|\u6807\u9898|\u80cc\u666f|\u6309\u94ae|\u6587\u4ef6|\u4ee3\u7801|\u5e03\u5c40|\u6548\u679c).{0,100}(?:\u8981|\u5fc5\u987b|\u59cb\u7ec8|\u4e00\u76f4|\u4fdd\u6301).{0,100}|(?:\u8ba9|\u786e\u4fdd|\u4fdd\u8bc1|\u4fdd\u6301)(?=.{0,140}(?:\u56fe\u7247|\u56fe\u50cf|\u5361\u7247|\u9875\u9762|\u7f51\u9875|\u52a8\u753b|\u5143\u7d20|\u6587\u5b57|\u6807\u9898|\u80cc\u666f|\u6309\u94ae|\u6587\u4ef6|\u4ee3\u7801|\u5e03\u5c40|\u6548\u679c)).{1,140}|(?:\u56fe\u7247|\u56fe\u50cf|\u5361\u7247|\u9875\u9762|\u7f51\u9875|\u52a8\u753b|\u5143\u7d20|\u6587\u5b57|\u6807\u9898|\u80cc\u666f|\u6309\u94ae|\u6587\u4ef6|\u4ee3\u7801|\u5e03\u5c40|\u6548\u679c)\s*(?:\u8981|\u5fc5\u987b|\u5e94\u8be5|\u9700\u8981)\s*(?:\u59cb\u7ec8|\u4e00\u76f4|\u4fdd\u6301|\u6c38\u8fdc).{0,100}|(?:ensure|keep|make\s+sure)\b(?=.{0,140}\b(?:image|card|page|element|title|background|button|file|code|layout|effect)\b).{1,140}|(?:(?:the|each|every)\s+)?(?:image|card|page|element|title|background|button|file|code|layout|effect)\b.{0,48}\b(?:must|should|needs?\s+to|always)\b.{0,100})[.!?\u3002\uff01\uff1f\s]*$/iu
const RESPONSE_ONLY_REQUIREMENT = /\b(?:explain|describe|answer|reply|respond)\b|\bin\s+(?:your|the)\s+(?:answer|response|reply)\b|(?:\u89e3\u91ca|\u8bf4\u660e|\u56de\u7b54|\u7b54\u590d|\u56de\u590d|\u544a\u77e5)/iu

// Code generation and execution requests get the execution toolset even when
// no file target is named. Otherwise the model receives read-only tools only
// and tells the user "this environment has no code execution tools" although
// bash_exec / run_command are available and approval-gated.
const CODE_EXECUTION_INTENT = new RegExp(
  [
    // 中文:写/生成/实现/创建/修复 + 代码/脚本/函数/程序/工具/接口/爬虫 或语言名
    '(?:(?:\u5199|\u7f16\u5199|\u751f\u6210|\u5b9e\u73b0|\u521b\u5efa|\u4fee\u590d|\u5e2e\u6211\u5199|\u505a\u4e00\u4e2a?)[^\r\n\u3002\uff01\uff1f!?,\uff0c;\uff1b]{0,12}(?:\u4ee3\u7801|\u811a\u672c|\u51fd\u6570|\u7a0b\u5e8f|\u5de5\u5177|\u63a5\u53e3|\u722c\u866b|python|javascript|bash|shell))',
    // 中文:运行/执行/测试/跑 + 代码/脚本/命令/程序
    '(?:(?:\u8fd0\u884c|\u6267\u884c|\u6d4b\u8bd5|\u8dd1\u4e00\u4e0b|\u8dd1|\u8bd5\u8bd5|\u9a8c\u8bc1)[^\r\n\u3002\uff01\uff1f!?,\uff0c;\uff1b]{0,8}(?:\u4ee3\u7801|\u811a\u672c|\u547d\u4ee4|\u7a0b\u5e8f|python|script|code))',
    // 英文:write/create/generate/implement/build + code/script/function/program
    '(?:\\b(?:write|create|generate|implement|build|code)\\b[^\r\n.!?]{0,30}\\b(?:code|script|function|program|python|javascript|bash|shell)\\b)',
    // 英文:run/execute/test/try + code/script/command/program
    '(?:\\b(?:run|execute|test|try)\\b[^\r\n.!?]{0,12}\\b(?:code|script|command|program|python)\\b)',
  ].join('|'),
  'i',
)

// A local mutation is one capability contract, not a collection of unrelated
// switches for the model to discover by chance. Keep the group deliberately
// small and stable: inspect, change, and verify. Upstream permission/config
// filtering still wins, so this selector never recreates an explicitly
// disabled tool.
const LOCAL_MUTATION_REQUIRED_TOOL_NAMES = new Set([
  'list_directory',
  'read_file',
  'read_artifact_source',
  'grep_code',
  'find_symbol',
  'list_imports',
  'write_file',
  'edit_file',
  'apply_patch',
  'patch_file',
  'bash_exec',
  'run_command',
  'run_project_check',
  'run_test',
  'git_status',
  'git_diff',
  'request_directory',
  'request_clarification',
  'reflect',
  'set_deliverables',
])
const REMOTE_MUTATION_INTENT = /(?:^|[\s,\uff0c\u3002\uff1b;!\uff01])(?:(?:please|directly|now|help\s+(?:me\s+)?|\u8bf7|\u76f4\u63a5|\u73b0\u5728|\u7acb\u5373|\u5e2e\u6211|\u7ed9\u6211)\s*){0,3}(?:send|notify|post|publish|email)\b|(?:^|[\s,\uff0c\u3002\uff1b;!\uff01])(?:(?:\u8bf7|\u76f4\u63a5|\u73b0\u5728|\u7acb\u5373|\u5e2e\u6211|\u7ed9\u6211)\s*){0,3}(?:\u53d1\u9001|\u901a\u77e5(?!\s*(?:\u9875\u9762|\u8bbe\u7f6e|\u914d\u7f6e|\u9762\u677f|\u6837\u5f0f|\u7ec4\u4ef6))|\u53d1\u5e03(?=[^\uff0c\u3002\uff1b\r\n]{0,20}(?:\u901a\u77e5|\u6d88\u606f|\u516c\u544a|\u5e16\u5b50|\u5230|\u81f3)))|\b(?:create|update|delete|add)\b[^.!?\r\n]{0,48}\b(?:slack|notion|airtable|jira|salesforce|asana|trello|discord|calendar)\b|(?:slack|notion|airtable|jira|salesforce|asana|trello|discord|\u90ae\u7bb1|\u65e5\u5386)[^\uff0c\u3002\uff1b\r\n]{0,32}(?:\u53d1\u9001|\u53d1\u5e03|\u521b\u5efa|\u65b0\u5efa|\u66f4\u65b0|\u5220\u9664|\u6dfb\u52a0)/i
const GIT_MUTATION_INTENT = /\bgit\s+(?:commit|push|revert|rollback)\b|\b(?:commit|push)\b|(?:\u63d0\u4ea4|\u63a8\u9001|\u56de\u6eda).{0,12}(?:\u4ee3\u7801|\u4ed3\u5e93|\u5206\u652f|git)/i
const FILE_REWIND_INTENT = /\b(?:revert|undo|rollback)\b|\brestore\b[^.!?\r\n]{0,40}\b(?:file|change|edit|original|previous|state)\b|(?:\u56de\u6eda|\u64a4\u9500|\u6062\u590d\u539f\u72b6|\u8fd8\u539f(?:\u6587\u4ef6|\u6539\u52a8|\u4fee\u6539|\u66f4\u6539|\u539f\u72b6)?)/i
const BROWSER_EXECUTION_INTENT = /\b(?:use|open|launch)\s+(?:the\s+)?browser\b|\b(?:navigate|visit)\s+(?:to\s+)?(?:https?:\/\/|(?:the\s+)?(?:page|site|website)\b)|\b(?:click|press|select)\s+(?:on\s+)?(?:the\s+)?(?:button|link|tab|menu|element)\b|\b(?:take|capture)\s+(?:a\s+)?screenshot\b|\bbrowser\s+automation\b|(?:\u4f7f\u7528|\u7528|\u6253\u5f00|\u542f\u52a8)\s*\u6d4f\u89c8\u5668|(?:\u8bbf\u95ee|\u8fdb\u5165)(?:\u7f51\u9875|\u7f51\u7ad9|\u7f51\u5740|\u9875\u9762)|(?:\u70b9\u51fb|\u6309\u4e0b|\u9009\u62e9)(?:\u6309\u94ae|\u94fe\u63a5|\u6807\u7b7e|\u83dc\u5355|\u5143\u7d20)|(?:\u7f51\u9875|\u9875\u9762)\u622a\u56fe|\u622a\u56fe(?:\u7f51\u9875|\u9875\u9762)/i
const WEB_LOOKUP_INTENT = /\b(?:search|research)\s+(?:the\s+)?(?:web|internet|online)\b|\blook\s+up\b[^.!?\r\n]{0,48}\bonline\b|\b(?:use|run|do)\s+(?:a\s+)?web\s+search\b|\bweb\s+search\b(?![^.!?\r\n]{0,32}\b(?:page|panel|settings?|configuration|option|feature|button|ui|style)\b)|\b(?:fetch|open|read|inspect|visit)\s+https?:\/\/|(?:\u8054\u7f51\u641c\u7d22|\u7f51\u7edc\u641c\u7d22)(?![^\uff0c\u3002\uff1b\r\n]{0,24}(?:\u9875\u9762|\u9762\u677f|\u8bbe\u7f6e|\u914d\u7f6e|\u9009\u9879|\u529f\u80fd|\u6309\u94ae|\u754c\u9762|\u6837\u5f0f))|(?:\u5728\u7f51\u4e0a|\u5230\u7f51\u4e0a|\u4ece\u7f51\u4e0a|\u5728\u7ebf)(?:\u641c\u7d22|\u67e5\u627e|\u67e5\u8be2|\u68c0\u7d22|\u8c03\u7814)|(?:\u641c\u7d22|\u67e5\u627e|\u67e5\u8be2|\u68c0\u7d22|\u8c03\u7814)(?:\u4e00\u4e0b|\u4e0b)?(?:\u4e92\u8054\u7f51|\u7f51\u7edc|\u7f51\u9875|\u7f51\u4e0a|\u5728\u7ebf)/i

function toolName(spec) {
  return String(spec?.function?.name || '').trim()
}

function emitSelectionDecision(onDecision, decision) {
  if (typeof onDecision !== 'function') return
  try {
    onDecision(decision)
  } catch {
    // Selection diagnostics are advisory and must never block a chat turn.
  }
}

function readOnlyBoundaryText(userPrompt) {
  // Printed forms commonly contain local layout instructions such as
  // "Do not write below this line". They constrain where generated content
  // may be placed; they are not a request to keep the entire file read-only.
  // Likewise, a "read-only verifier" describes one validation component in
  // an otherwise mutating workflow. It must not downgrade the whole turn.
  // A separate whole-request boundary such as "do not modify the file" is
  // intentionally left intact and still wins below.
  return String(userPrompt || '')
    .replace(LOCAL_LAYOUT_WRITE_BOUNDARY, ' ')
    .replace(SCOPED_READ_ONLY_VERIFIER, ' ')
}

export function isExplicitReadOnlyRequest(userPrompt) {
  const promptWithoutLayoutBoundaries = readOnlyBoundaryText(userPrompt)
  if (READ_ONLY_EXPLANATION_QUESTION.test(promptWithoutLayoutBoundaries.trim())) return false
  if (!EXPLICIT_READ_ONLY.test(promptWithoutLayoutBoundaries)) return false
  if (GLOBAL_READ_ONLY.test(promptWithoutLayoutBoundaries)) return true

  // Only a boundary explicitly scoped to a single source/input/original may
  // coexist with a separate output mutation. Other explicit read-only wording
  // remains a whole-request boundary, even when a proposed fix is discussed.
  if (SCOPED_SOURCE_READ_ONLY_BOUNDARY.test(promptWithoutLayoutBoundaries)
    || SCOPED_CONTENT_PRESERVATION_BOUNDARY.test(promptWithoutLayoutBoundaries)
    || SCOPED_CONTENT_FIDELITY_BOUNDARY.test(promptWithoutLayoutBoundaries)) {
    return !hasMutationExecutionIntent(promptWithoutLayoutBoundaries)
  }
  return true
}

function isReadOnlyRequest(userPrompt) {
  const promptWithoutLayoutBoundaries = readOnlyBoundaryText(userPrompt)
  if (ANALYSIS_ONLY_REQUEST.test(promptWithoutLayoutBoundaries)
    && !hasMutationExecutionIntent(promptWithoutLayoutBoundaries)) return true
  return isExplicitReadOnlyRequest(promptWithoutLayoutBoundaries)
}

export function hasEffectiveReadOnlyBoundary(userPrompt, previousUserPrompt) {
  if (isExplicitReadOnlyRequest(userPrompt)) return true
  // A question about why execution was unavailable is not itself permission to
  // discard the immediately preceding read-only instruction. A later concrete
  // mutation request is evaluated normally and can start a new execution turn.
  return isExecutionCapabilityChallenge(String(userPrompt || '').trim())
    && isExplicitReadOnlyRequest(previousUserPrompt)
}

export function shouldInheritExecutionIntent(userPrompt, previousUserPrompt, { intentMode = 'auto' } = {}) {
  const current = String(userPrompt || '').trim()
  const previous = String(previousUserPrompt || '').trim()
  const revisionRequirement = EXECUTION_REVISION_REQUIREMENT.test(current)
  if (normalizeTurnIntentMode(intentMode) === 'answer') return false
  if (!current || !previous || current.length > 160
    || (!EXECUTION_CONTINUATION.test(current)
      && !EXECUTION_REVISION.test(current)
      && !revisionRequirement
      && !isExecutionCapabilityChallenge(current))) return false
  if (revisionRequirement
    && RESPONSE_ONLY_REQUIREMENT.test(current)
    && !hasMutationExecutionIntent(current)) return false
  // A prior global/read-only instruction remains authoritative. A short reply
  // can confirm an existing user-authored work order, but cannot create one.
  if (isReadOnlyRequest(current) || isReadOnlyRequest(previous)) return false
  return shouldRequireExecution({ intentMode: 'auto', text: previous })
}

function localMutationIntentSource({ userPrompt, previousUserPrompt, intentMode }) {
  const current = String(userPrompt || '').trim()
  const previous = String(previousUserPrompt || '').trim()
  if (current && !isExecutionCapabilityChallenge(current)
    && hasMutationExecutionIntent(current)) return current
  if (shouldInheritExecutionIntent(current, previous, { intentMode })
    && hasMutationExecutionIntent(previous)) return previous
  return ''
}

/**
 * Resolve the deterministic model-visible group for a concrete local change.
 * A null result means the request is either answer-only, an artifact contract,
 * an external mutation, or too ambiguous to narrow safely; callers then keep
 * the already-authorized catalog selected by the upstream context policy.
 */
export function resolveRequiredChatToolNames({
  userPrompt = '',
  previousUserPrompt = '',
  intentMode = 'auto',
  executionRequired = false,
  specs = [],
} = {}) {
  const source = localMutationIntentSource({ userPrompt, previousUserPrompt, intentMode })
  if (executionRequired && !LOCAL_FILE_TARGET_REFERENCE.test(source)) return null
  if (!source || REMOTE_MUTATION_INTENT.test(source)) return null

  const required = new Set(LOCAL_MUTATION_REQUIRED_TOOL_NAMES)
  if (GIT_MUTATION_INTENT.test(source)) {
    for (const name of ['git_write', 'git_commit', 'git_push', 'git_rollback']) required.add(name)
  }
  if (FILE_REWIND_INTENT.test(source)) required.add('rewind_files')
  if (BROWSER_EXECUTION_INTENT.test(source)) {
    for (const spec of Array.isArray(specs) ? specs : []) {
      const name = toolName(spec)
      if (name.startsWith('browser_')) required.add(name)
    }
  }
  if (WEB_LOOKUP_INTENT.test(source)) {
    required.add('web_search')
    required.add('fetch_url')
  }
  return required
}

function canonicalizeSpecValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeSpecValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalizeSpecValue(value[key])]),
  )
}

function canonicalSpecKey(spec) {
  try {
    return JSON.stringify(canonicalizeSpecValue(spec))
  } catch {
    return String(spec?.function?.description || '')
  }
}

function stableUniqueSpecs(specs) {
  const candidates = (Array.isArray(specs) ? specs : [])
    .map((spec) => ({ spec, name: toolName(spec), key: canonicalSpecKey(spec) }))
    .filter((entry) => entry.name)
    .sort((left, right) => left.name.localeCompare(right.name, 'en')
      || left.key.localeCompare(right.key, 'en'))
  const byName = new Map()
  for (const entry of candidates) {
    // Duplicate registrations resolve to the lexicographically smallest
    // canonical schema, so provider-visible tools do not depend on load order.
    if (!byName.has(entry.name)) byName.set(entry.name, entry.spec)
  }
  return [...byName.values()]
}

function readOnlyMetadata(name, { userId, metadataResolver }) {
  try {
    return metadataResolver(name, { args: {}, userId })?.isReadOnly === true
  } catch {
    // Unknown or malformed dynamic tools fail closed in answer/read-only mode.
    return false
  }
}

/**
 * Choose one of two stable capability sets, then let the model select the
 * concrete tool. This avoids brittle per-capability keyword routing while
 * keeping write/exec/external schemas out of answer-only requests.
 */
export function resolveChatCapabilityMode({
  prompt = '',
  userPrompt = prompt,
  previousUserPrompt = '',
  intentMode = 'auto',
  executionRequired = false,
} = {}) {
  if (isReadOnlyRequest(userPrompt)) return 'answer'
  const normalized = normalizeTurnIntentMode(intentMode)
  if (normalized === 'answer') return 'answer'
  if (normalized === 'execute') return 'execute'
  if (executionRequired) return 'execute'
  if (shouldInheritExecutionIntent(userPrompt, previousUserPrompt, { intentMode: normalized })) return 'execute'
  // "Why is there no write tool?" contains the lexical sequence "write ...
  // tool", but it is a capability challenge rather than a fresh code-writing
  // order. It inherits execution only from a real preceding work request via
  // shouldInheritExecutionIntent above.
  if (CODE_EXECUTION_INTENT.test(String(userPrompt || ''))
    && !isExecutionCapabilityChallenge(userPrompt)) return 'execute'
  return shouldRequireExecution({ intentMode: normalized, text: userPrompt }) ? 'execute' : 'answer'
}

/**
 * Permissions/configuration are applied before this function. It only removes
 * capabilities; it never recreates a disabled tool. Every chat round retains
 * the already-authorized local editing harness so the model can decide whether
 * to use it. Answer mode also retains genuinely read-only and recovery tools,
 * excluding orchestration because delegated agents may mutate outside this
 * local filter.
 */
export function selectChatToolSpecs({
  prompt = '',
  userPrompt = prompt,
  previousUserPrompt = '',
  specs = [],
  intentMode = 'auto',
  executionRequired = false,
  userId = null,
  metadataResolver = getToolMetadata,
  onDecision = null,
} = {}) {
  const explicitReadOnly = hasEffectiveReadOnlyBoundary(userPrompt, previousUserPrompt)
  const capabilityMode = resolveChatCapabilityMode({
    prompt,
    userPrompt,
    previousUserPrompt,
    intentMode,
    executionRequired,
  })
  const stableSpecs = stableUniqueSpecs(specs)
  const hasLocalFileTarget = LOCAL_FILE_TARGET_REFERENCE.test(String(userPrompt || ''))
  const routedSpecs = hasLocalFileTarget
    ? stableSpecs.filter((spec) => toolName(spec) !== 'read_artifact_source')
    : stableSpecs
  const excludedTools = hasLocalFileTarget
    && stableSpecs.some((spec) => toolName(spec) === 'read_artifact_source')
    ? [{
        name: 'read_artifact_source',
        stage: 'chat_capability',
        reason: 'local_file_target_not_managed_artifact',
      }]
    : []
  let selectedSpecs
  let intentToolNames = []
  if (capabilityMode === 'execute') {
    const requiredNames = resolveRequiredChatToolNames({
      userPrompt,
      previousUserPrompt,
      intentMode,
      executionRequired,
      specs: routedSpecs,
    })
    intentToolNames = requiredNames ? [...requiredNames].sort().slice(0, 256) : []
    selectedSpecs = requiredNames
      ? routedSpecs.filter((spec) => requiredNames.has(toolName(spec)))
      : routedSpecs
    if (requiredNames) {
      const selectedNames = new Set(selectedSpecs.map(toolName))
      for (const spec of routedSpecs) {
        const name = toolName(spec)
        if (name && !selectedNames.has(name)) {
          excludedTools.push({ name, stage: 'chat_capability', reason: 'intent_policy_not_needed' })
        }
      }
    }
  } else {
    selectedSpecs = routedSpecs.filter((spec) => {
      const name = toolName(spec)
      return !ORCHESTRATION_TOOL_NAMES.has(name)
        && (ALWAYS_VISIBLE_LOCAL_EXECUTION_TOOL_NAMES.has(name)
          || ANSWER_RECOVERY_TOOL_NAMES.has(name)
          || readOnlyMetadata(name, { userId, metadataResolver }))
    })
    const selectedNames = new Set(selectedSpecs.map(toolName))
    for (const spec of routedSpecs) {
      const name = toolName(spec)
      if (!name || selectedNames.has(name)) continue
      excludedTools.push({
        name,
        stage: 'chat_capability',
        reason: ORCHESTRATION_TOOL_NAMES.has(name)
          ? 'answer_mode_orchestration_hidden'
          : 'intent_answer_mode',
      })
    }
  }
  emitSelectionDecision(onDecision, {
    version: 1,
    capabilityMode,
    explicitReadOnly,
    intentToolNames,
    eligibleToolNames: routedSpecs.map(toolName).filter(Boolean).sort().slice(0, 256),
    selectedToolNames: selectedSpecs.map(toolName).filter(Boolean).sort().slice(0, 256),
    excludedTools: excludedTools
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      .slice(0, 256),
  })
  return selectedSpecs
}
