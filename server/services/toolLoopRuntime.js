/**
 * 服务端工具回调循环(server-side tools loop)。
 * 让后台任务的模型像 ChatSplit 前端一样会"自主调用"工具生成 pptx/docx/xlsx/html。
 *
 * 设计:
 *   - tool spec 与前端 src/lib/tools/index.js 对齐,但 executor 在服务端跑
 *   - 直接调 server/artifactGen.js 的 createPptx/Docx/Xlsx 生成 buffer + url
 *   - 每次工具调用产物立刻 appendJobArtifact 进 jobStore(归属 job.userId)
 *   - 循环最多 maxIters 轮,防失控
 */
import fs from 'node:fs'
import path from 'node:path'
import { appendJobArtifact } from './jobStore.js'
import { appendTurnArtifact } from './turnArtifactStore.js'
import { createDocx, createHtmlArtifact, createImageArtifact, createLocalFileArtifact, createLocalFileArtifactAsync, createPptx, createXlsx } from './artifactGen.js'
import { FS_SHELL_TOOL_SPECS, dispatchFsShellTool, resolveInWorkspace } from '../adapters/fsShellTools.js'
import { IMAGE_TOOL_SPECS, dispatchImageTool } from '../adapters/imageTools.js'
import { MEDIA_TOOL_SPECS, dispatchMediaTool } from '../adapters/mediaTools.js'
import { PDF_TOOL_SPECS, dispatchPdfTool } from '../adapters/pdfTools.js'
import { BATCH_FILE_TOOL_SPECS, dispatchBatchFileTool } from '../adapters/batchFileTools.js'
import { dispatchGitTool } from '../adapters/gitWorkbench.js'
import { dispatchCodeSearchTool } from '../utils/codeSearch.js'
import { dispatchApplyPatchTool } from '../utils/applyPatch.js'
import { dispatchAgenticTool, isLoopPauseResult } from '../utils/agenticTools.js'
import { getToolMetadata, listBuiltinSpecs } from './toolRegistry.js'
import { createToolAbortScope } from '../utils/toolCancellation.js'
import { CONNECTOR_TOOL_NAMES, CONNECTOR_TOOL_SPECS, CONNECTOR_WRITE_TOOL_NAMES, executeConnectorTool } from './connectorTools.js'
import { dispatchMemoryTool } from '../utils/memoryTools.js'
import { attachJobBudget, getJobBudget, createJobBudget, runWithModelBudget } from '../utils/jobBudget.js'
import { formatDeniedToolResult, requestApproval, resumePersistedApproval } from './approvalGate.js'
import { writeToolAudit } from '../utils/audit.js'
import { isContextLengthError } from '../adapters/modelProxy.js'
import { callModelWithContextRecovery } from './contextCompactionRuntime.js'
import { ensureSafetySystemMessages } from './promptCompiler.js'
import { allowedArtifactTools, isFileArtifactTool, parseSkillIdFromPrompt } from './artifactIntent.js'
import { selectChatToolSpecs } from './chatToolSelection.js'
import { restoreDirectoryAuthorizationToolSpecs } from './turnToolSpecs.js'
import {
  createSubagentApprovalContext,
  rememberApprovedSubagentCall,
  runSubagentBatch,
} from './subagentRuntime.js'
import {
  buildAssistantToolCallsMessage,
  buildToolResultMessage,
  buildToolResultMessages,
  createToolLoopGuard,
  executeToolWithRetry,
  isSubstantiveToolCall,
  mapWithConcurrency,
  normalizeToolError,
  normalizeToolResult,
  normalizeToolCalls,
  resolveToolResultMaxChars,
  validateToolCall,
} from '../utils/toolCallHarness.js'
import { extractTextToolCalls } from '../utils/textToolCalls.js'
import { callTool as callMcpTool } from '../mcp/mcpManager.js'
import { executeBrowserTool } from './browserToolExecutor.js'
import { fetchAndExtract } from '../adapters/toolProxy.js'
import { searchWeb } from './webSearchService.js'
import { dispatchHooks } from './hooksService.js'
import { generateImage } from './mediaModelService.js'
import { replaceRuntimeCapabilityBlock } from './runtimeCapabilities.js'
import { hasMutationExecutionIntent, shouldRequireExecution } from '../utils/executionIntent.js'
import {
  observeToolCalls,
  recordToolProgress,
  restoreToolProgress,
  serializeToolProgress,
  toolProgressPayload,
} from '../utils/toolProgress.js'

const FS_SHELL_TOOL_NAMES = new Set(
  FS_SHELL_TOOL_SPECS.map((spec) => String(spec?.function?.name || '')).filter(Boolean),
)
const IMAGE_TOOL_NAMES = new Set(IMAGE_TOOL_SPECS.map((spec) => spec.function.name))
const MEDIA_TOOL_NAMES = new Set(MEDIA_TOOL_SPECS.map((spec) => spec.function.name))
const PDF_TOOL_NAMES = new Set(PDF_TOOL_SPECS.map((spec) => spec.function.name))
const BATCH_FILE_TOOL_NAMES = new Set(BATCH_FILE_TOOL_SPECS.map((spec) => spec.function.name))

// 死循环护栏,不是工作预算。后台任务无人盯着,不能真的无限跑 ——
// 但真正的收敛是 jobBudget(累积调用数 + 挂钟时间),那个和成本线性相关。
//
// ★ 从 200 提到 2000 并可配。200 轮对「读完一个中型项目再逐个文件改」
// 是够不到的:光探索就可能几十轮,真正动手改又是几十轮,
// 中间还要穿插验证。碰到上限时用户看到的是「做到一半停了」。
// 2000 是任何正常任务都碰不到、但仍能兜住死循环的量级。
const MAX_ITERS = (() => {
  const raw = Number(process.env.JOB_MAX_ITERS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000
})()
const JOB_READ_CONCURRENCY = 4
const ARTIFACT_DELIVERY_GUARD_MARKER = '[PERSISTED ARTIFACT DELIVERY REQUIRED]'
const MAX_ARTIFACT_DELIVERY_RETRIES = 1
const EXECUTION_EVIDENCE_GUARD_MARKER = '[EXECUTION EVIDENCE REQUIRED]'
const EXECUTION_REASONING_RECOVERY_MARKER = '[EXECUTION REASONING RECOVERY REQUIRED]'
const DIRECTORY_RESUME_GUARD_MARKER = '[VERIFIED DIRECTORY RESUME REQUIRED]'
const AVAILABLE_TOOL_CAPABILITIES_MARKER = '[AVAILABLE TOOL CAPABILITIES]'
const POST_MUTATION_VERIFICATION_GUARD_MARKER = '[POST-MUTATION VERIFICATION REQUIRED]'
const PDF_LAYOUT_EXECUTION_CONTRACT_MARKER = '[PDF LAYOUT EXECUTION CONTRACT]'
const PDF_LAYOUT_VERIFICATION_GUARD_MARKER = '[PDF LAYOUT VERIFICATION REQUIRED]'
const PDF_LAYOUT_VERIFICATION_OK = 'PDF_LAYOUT_VERIFICATION_OK'
const MAX_EXECUTION_EVIDENCE_RETRIES = 1
const MAX_EXECUTION_REASONING_RETRIES = 2
const MAX_DIRECTORY_RESUME_RETRIES = 2
const MAX_MUTATION_VERIFICATION_RETRIES = 2
const MAX_PDF_LAYOUT_VERIFICATION_RETRIES = 2
const VERIFIED_DIRECTORY_RESOLUTION = /\[(?:TURN|JOB_DIRECTORY)_RESOLUTION:[^\]]+\][^\r\n]*local directory authorization is already persisted and verified\./i
const DIRECTORY_AUTHORIZATION_WAIT_CLAIM = /(?:please\s+(?:choose|select|authorize|grant)[\s\S]{0,100}(?:directory|folder)|(?:i(?:'m| am)?\s+)?wait(?:ing)?[\s\S]{0,100}(?:authori[sz]ation|permission|directory|folder)|(?:directory|folder)[\s\S]{0,100}(?:authorization|permission)[\s\S]{0,100}(?:required|pending|choose|select|grant)|\u8bf7[\s\S]{0,40}(?:\u9009\u62e9|\u6388\u6743)[\s\S]{0,40}(?:\u76ee\u5f55|\u6587\u4ef6\u5939)|(?:\u76ee\u5f55|\u6587\u4ef6\u5939)[\s\S]{0,40}(?:\u6388\u6743|\u6743\u9650)[\s\S]{0,40}(?:\u8bf7\u6c42|\u7b49\u5f85|\u9009\u62e9|\u786e\u8ba4|\u9700\u8981|\u672a\u6388\u6743)|\u7b49\u5f85[\s\S]{0,40}(?:\u9009\u62e9|\u6388\u6743|\u76ee\u5f55|\u6587\u4ef6\u5939))/i
const EXPLICIT_LOCAL_DIRECTORY_CONTEXT = /\[LOCAL PATH (?:ACCESS|REFERENCE)|\[VERIFIED LOCAL FILESYSTEM ACCESS\]|(?:^|[\s"'`])(?:[a-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|\/(?:home|users|workspace|mnt|tmp)\/)|(?:save|write|export).{0,40}(?:folder|directory|desktop)|(?:\u4fdd\u5b58|\u5199\u5165|\u5bfc\u51fa).{0,20}(?:\u76ee\u5f55|\u6587\u4ef6\u5939|\u684c\u9762)/im
const MANAGED_ATTACHMENT_MARKER = /\[GUGO_MANAGED_ATTACHMENT\b|\[\u9644\u4ef6\s*:|attachment:\/\//i
const LOCAL_MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'multi_edit',
  'image_transform',
  'media_transform',
  'pdf_transform',
  'archive_create',
  'archive_extract',
  'batch_rename',
])
const PROJECT_SCOPE_TARGET = '<workspace>'
const VERIFICATION_TOOLS = new Set([
  'read_file',
  'list_directory',
  'grep_code',
  'find_symbol',
  'list_imports',
  'git_status',
  'git_diff',
  'run_project_check',
  'image_info',
  'media_probe',
  'pdf_info',
  'pdf_text',
  'archive_list',
])
const SHELL_VERIFICATION_COMMAND = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check|typecheck)\b|(?:^|\s)(?:pytest|vitest|jest|eslint|tsc|cargo\s+(?:test|check)|go\s+test|dotnet\s+test)\b|(?:^|\s)git\s+(?:status|diff)\b/i
const SHELL_PROJECT_CHECK_COMMAND = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check|typecheck)\b|(?:^|\s)(?:pytest|vitest|jest|eslint|tsc|cargo\s+(?:test|check)|go\s+test|dotnet\s+test)\b/i
const PYTHON_INLINE_READ_EVIDENCE = /(?:\b(?:fitz|pymupdf)\.open\s*\(|\bImage\.open\s*\(|\bopen\s*\(|\bos\.path\.(?:exists|isfile|getsize)\s*\(|\bPath\s*\([^)]*\)\.(?:exists|is_file|stat|read_text|read_bytes)\s*\(|\.read\s*\(|\.verify\s*\()/i
const PYTHON_INLINE_MUTATION = /(?:\bopen\s*\([^)]*(?:,\s*['"][^'"]*[wax+]|\bmode\s*=\s*['"][^'"]*[wax+])|\bos\.open\s*\(|\.(?:write|writelines|truncate|write_text|write_bytes|save|saveIncr|insert_text|insert_image|new_page|delete_page|touch|mkdir|unlink|rename|replace|chmod)\s*\(|\b(?:os\.(?:remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|chmod|utime|symlink|link)|shutil\.(?:copy|copy2|copyfile|move|rmtree|make_archive|unpack_archive)|subprocess\.|eval\s*\(|exec\s*\()|(?:^|[;\s])(?:remove|unlink|rename|replace)\s*\()/i
const PYTHON_PATH_OPEN_MUTATION = /\.\s*open\s*\(\s*(?:mode\s*=\s*)?(['"])(?=[rwaxtb+u]*[wax+])[rwaxtb+u]+\1/i
const PYTHON_PRINT_FILE_MUTATION = /\bprint\s*\([^;\r\n]{0,1000}\bfile\s*=/i
const SCHEDULED_WAIT_INTENT = /\b(?:sleep|wait|wake|schedule|delay|follow[- ]?up|remind)\b|(?:\u7b49\u5f85|\u5ef6\u8fdf|\u5b9a\u65f6|\u5230\u65f6|\u5524\u9192|\u63d0\u9192|\u7a0d\u540e\u7ee7\u7eed)/i
const CLARIFICATION_CAPABILITY_CONTEXT = /(?:tool(?:set|s)?|capabilit(?:y|ies)|runtime|environment|\u5de5\u5177(?:\u96c6|\u5217\u8868|\u80fd\u529b)?|\u8fd0\u884c\u65f6|\u73af\u5883)/i
const EXPLICIT_TOOLSET_CONTEXT = /(?:tool(?:set|s)?|capabilit(?:y|ies)|\u5de5\u5177(?:\u96c6|\u5217\u8868|\u80fd\u529b)?)/i
const CLARIFICATION_CAPABILITY_DENIAL = /(?:do(?:es)?\s+not\s+have|cannot|can't|lack(?:s|ing)?|missing|unavailable|not\s+available|limited|limitation|\u6ca1\u6709|\u7f3a\u5c11|\u4e0d\u5177\u5907|\u4e0d\u53ef\u7528|\u672a\u63d0\u4f9b|\u65e0\u6cd5|\u53d7\u9650|\u9650\u5236)/i
const CODE_EXECUTION_CAPABILITY = /(?:code\s+execution|execute\s+code|run\s+(?:code|scripts?)|shell|terminal|command\s+execution|python|node\.?(?:js)?|\u4ee3\u7801\u6267\u884c|\u6267\u884c\u4ee3\u7801|\u8fd0\u884c\u4ee3\u7801|\u8fd0\u884c\u811a\u672c|\u547d\u4ee4\u884c|\u7ec8\u7aef|\u811a\u672c)/i
const FILE_WRITE_CAPABILITY = /(?:file\s+(?:write|edit|modif|generat)|(?:write|edit|modify|generate|create).{0,24}(?:files?|documents?|images?|pdf|png|jpe?g)|document\s+generation|filesystem\s+write|\u6587\u4ef6\u5199\u5165|\u5199\u5165\u6587\u4ef6|\u5199\u6587\u4ef6|\u7f16\u8f91\u6587\u4ef6|\u4fee\u6539\u6587\u4ef6|\u6587\u4ef6\u751f\u6210|\u751f\u6210\u6587\u4ef6|\u4ea7\u7269\u751f\u6210|(?:\u7f16\u8f91|\u4fee\u6539|\u751f\u6210|\u521b\u5efa|\u5199\u5165).{0,16}(?:pdf|png|jpe?g|\u56fe\u50cf|\u56fe\u7247|\u6587\u6863|\u6587\u4ef6))/i
const FILE_WRITE_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'multi_edit',
  'image_transform',
  'media_transform',
  'pdf_transform',
])
const PDF_DOCUMENT_REFERENCE = /(?:\.pdf\b|\bpdf\b|application\/pdf)/i
const PDF_LAYOUT_MUTATION_INTENT = /(?:write|fill|insert|overlay|edit|modify|create|generate|render|export|save|\u5199\u5165|\u586b\u5199|\u586b\u5165|\u53e0\u52a0|\u7f16\u8f91|\u4fee\u6539|\u751f\u6210|\u6e32\u67d3|\u5bfc\u51fa|\u4fdd\u5b58)/i
const PDF_LAYOUT_VALIDATOR_COMMAND = /(?:^|[\s&|])(?:(?:"[^"]*(?:python(?:3)?|py)(?:\.exe)?")|(?:[^\s"]*[\\/])?(?:python(?:3)?|py)(?:\.exe)?)\s+(?:"[^"]*verify[_-]?pdf[_-]?layout[^"\r\n]*\.py"|'[^']*verify[_-]?pdf[_-]?layout[^'\r\n]*\.py'|[^\s;&|]*verify[_-]?pdf[_-]?layout[^\s;&|]*\.py)(?=$|[\s;&|])/i
const PATH_AUTHORIZATION_FAILURE_CODES = new Set([
  'ABSOLUTE_PATH_REQUIRED',
  'PATH_NOT_AUTHORIZED',
  'PATH_NOT_WRITABLE',
  'FILESYSTEM_WRITE_DENIED',
  'ATTACHMENT_READ_ONLY',
])
const PERMISSION_CLARIFICATION = /(?:permission|authori[sz](?:e|ation)|access\s+(?:was\s+)?denied|grant\s+(?:write\s+)?access|\u6743\u9650|\u6388\u6743|\u8bbf\u95ee\u88ab\u62d2\u7edd|\u5f00\u653e\u8bbf\u95ee)/i
const TOOL_AUTHORING_FAILURE_CODES = new Set([
  'missing_tool_name',
  'unknown_tool',
  'tool_arguments_invalid',
  'tool_arguments_validation_failed',
  'tool_call_parse_error',
])
const FAILURE_RECOVERY_MARKER = '[TOOL FAILURE RECOVERY REQUIRED]'
const FAILURE_RECOVERY_THRESHOLD = 2
const EXECUTION_CONVERGENCE_MARKER = '[EXECUTION CONVERGENCE REQUIRED]'
const EXECUTION_CONVERGENCE_ROUND_THRESHOLD = 3
const MAX_INSTALL_ATTEMPT_SIGNATURES = 24
const PROBE_SCRIPT_PATH = /(?:^|[\\/])(?:[._-]?(?:inspect|probe|diagnos(?:e|tic)|debug[-_]?env|check[-_]?env|env[-_]?check|test[-_]?(?:import|dependency)))(?:[-_.0-9][^\\/]*)?\.(?:py|m?js|cjs|ts|ps1|sh|cmd|bat)$/i
const PROBE_SCRIPT_REFERENCE = /(?:^|[\s"'`])(?:[^\s"'`;|&]*[\\/])?(?:[._-]?(?:inspect|probe|diagnos(?:e|tic)|debug[-_]?env|check[-_]?env|env[-_]?check|test[-_]?(?:import|dependency)))(?:[-_.0-9][^\s"'`;|&]*)?\.(?:py|m?js|cjs|ts|ps1|sh|cmd|bat)(?=$|[\s"'`;|&])/i
const ENVIRONMENT_PROBE_COMMAND = /(?:\b(?:python(?:3)?|py|node)\b[^\r\n;&|]{0,80}(?:--version|-V\b|\s-c\s+)[^\r\n;&|]{0,240}(?:\bimport\b|find_spec|__version__|version)|\b(?:pip(?:3)?|python(?:3)?\s+-m\s+pip|py\s+-m\s+pip)\s+(?:show|list|check)\b|\b(?:npm|pnpm|yarn)\s+(?:list|ls|why)\b|\b(?:where(?:\.exe)?|which|Get-Command)\s+[^\r\n;&|]+)/i
const NON_REFLECTIVE_FAILURE_CODES = new Set([
  'tool_execution_skipped',
  'tool_budget_exceeded',
  'tool_execution_outcome_unknown',
  'approval_denied',
  'hook_denied',
  'turn_cancelled',
  'execution_convergence_probe_blocked',
  'execution_convergence_install_blocked',
])

function toolNameFromSpec(spec) {
  return String(spec?.function?.name || '').trim()
}

function parseToolResultMessage(message) {
  if (message?.role !== 'tool') return null
  try {
    const result = JSON.parse(String(message.content || '{}'))
    return result && typeof result === 'object' ? result : null
  } catch {
    return null
  }
}

function isPathAuthorizationFailure(result) {
  const code = String(result?.code || '').trim().toUpperCase()
  return PATH_AUTHORIZATION_FAILURE_CODES.has(code)
    || Boolean(result?.suggestGrantPath)
    || ['read_only', 'read_write'].includes(String(result?.requiredAccessMode || ''))
}

function findPathAuthorizationFailures(messages) {
  const failures = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const result = parseToolResultMessage(message)
    if (result?.ok !== false || !isPathAuthorizationFailure(result)) continue
    failures.push({
      tool: String(message?.name || ''),
      code: String(result.code || 'PATH_NOT_AUTHORIZED'),
      path: result.path || null,
      suggestGrantPath: result.suggestGrantPath || null,
      requiredAccessMode: result.requiredAccessMode || null,
    })
  }
  return failures
}

function hasConcreteToolFailure(messages, names) {
  const relevant = new Set(names)
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (message?.role !== 'tool' || !relevant.has(String(message?.name || ''))) return false
    const result = parseToolResultMessage(message)
    return result?.ok === false
      && !TOOL_AUTHORING_FAILURE_CODES.has(String(result?.code || ''))
      && !isPathAuthorizationFailure(result)
  })
}

function contradictedCapabilityClarification(args, toolSpecs, messages = []) {
  const text = [args?.question, args?.why].filter(Boolean).join('\n')
  if (!text
    || !CLARIFICATION_CAPABILITY_CONTEXT.test(text)
    || !CLARIFICATION_CAPABILITY_DENIAL.test(text)) return null

  const availableNames = new Set((Array.isArray(toolSpecs) ? toolSpecs : []).map(toolNameFromSpec).filter(Boolean))
  const contradicted = []
  if (CODE_EXECUTION_CAPABILITY.test(text) && availableNames.has('bash_exec')) contradicted.push('bash_exec')
  if (FILE_WRITE_CAPABILITY.test(text)) {
    if (availableNames.has('bash_exec')) contradicted.push('bash_exec')
    for (const name of availableNames) {
      if (FILE_WRITE_TOOL_NAMES.has(name) || isFileArtifactTool(name)) contradicted.push(name)
    }
  }
  if (contradicted.length === 0) return null

  const names = [...new Set(contradicted)]
  const pathAuthorizationFailures = findPathAuthorizationFailures(messages)
  const permissionClarification = args?.blocker_kind === 'permission' || PERMISSION_CLARIFICATION.test(text)
  if (permissionClarification
    && !EXPLICIT_TOOLSET_CONTEXT.test(text)
    && pathAuthorizationFailures.length > 0) return null
  if (hasConcreteToolFailure(messages, names)) return null
  const latestPathFailure = pathAuthorizationFailures.at(-1) || null
  const suggestedPathFailure = pathAuthorizationFailures.findLast((failure) => failure.suggestGrantPath)
    || latestPathFailure
  const suggestedPath = suggestedPathFailure?.suggestGrantPath
    || (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(String(suggestedPathFailure?.path || ''))
      ? suggestedPathFailure.path
      : null)
  const shouldRequestWritableDirectory = FILE_WRITE_CAPABILITY.test(text)
    && latestPathFailure
    && availableNames.has('request_directory')
  const pathRecoveryHint = shouldRequestWritableDirectory
    ? 'The preceding failure is a path authorization problem, not a missing capability. Call request_directory with access_mode "read_write" and suggested_path set to the intended output directory, then resume the original operation.'
    : latestPathFailure
      ? 'The preceding failure is a path or permission problem, not evidence that the listed tools are unavailable. Report the concrete permission error and request the exact authorization needed.'
      : null
  return {
    ok: false,
    code: 'clarification_capability_contradicted',
    error: `\u6f84\u6e05\u8bf7\u6c42\u672a\u6682\u505c\u4efb\u52a1\uff1a\u5f53\u524d\u8f6e\u6b21\u5df2\u63d0\u4f9b ${names.join(', ')}\uff0c\u4e0e\u6240\u8ff0\u201c\u5de5\u5177\u7f3a\u5931\u201d\u77db\u76fe\u3002`,
    retryable: false,
    availableTools: names,
    hint: pathRecoveryHint || '\u7ee7\u7eed\u4f7f\u7528\u4e0a\u8ff0\u5de5\u5177\u5b8c\u6210\u4efb\u52a1\u3002\u5982\u679c\u4e0a\u4e00\u6b21\u8c03\u7528\u662f\u53c2\u6570\u6821\u9a8c\u5931\u8d25\uff0c\u5e94\u4fee\u6b63\u5fc5\u586b\u53c2\u6570\u540e\u91cd\u8bd5\uff0c\u4e0d\u8981\u5c06\u5176\u89e3\u8bfb\u4e3a\u5de5\u5177\u4e0d\u5b58\u5728\u3002',
    ...(shouldRequestWritableDirectory ? {
      requiredAction: {
        tool: 'request_directory',
        access_mode: 'read_write',
        suggested_path: suggestedPath,
      },
    } : {}),
  }
}

function isSuccessfulToolResult(result) {
  return result?.ok === true
}

function requestedPdfSectionLabel(text) {
  const input = String(text || '')
  const match = input.match(/\b(?:ielts\s+)?(?:writing\s+)?task\s*([12])\b/i)
  if (match) return `Writing Task ${match[1]}`
  const chinese = input.match(/(?:\u5199\u4f5c)?\u4efb\u52a1\s*([\u4e00\u4e8c12])/u)
  if (!chinese) return ''
  const number = chinese[1] === '\u4e00' ? '1' : chinese[1] === '\u4e8c' ? '2' : chinese[1]
  return `Writing Task ${number}`
}

function shouldRequirePdfLayoutVerification(text) {
  const input = String(text || '')
  return PDF_DOCUMENT_REFERENCE.test(input) && PDF_LAYOUT_MUTATION_INTENT.test(input)
}

function buildPdfLayoutExecutionContract(text) {
  const targetLabel = requestedPdfSectionLabel(text)
  return [
    PDF_LAYOUT_EXECUTION_CONTRACT_MARKER,
    targetLabel
      ? `The user explicitly selected ${targetLabel}. That label is authoritative: never switch to another task, section, or page because the supplied prose seems more suitable there.`
      : 'If the user names a page, section, form field, or document label, that target is authoritative; never infer a different target from the content.',
    'Before writing, inspect the source PDF with code, extract each page heading, determine the exact target page indices, writable rectangles, ruled-line positions, and forbidden/red-line boundaries. Do not guess page numbers.',
    'Generate the requested PDF and every requested page preview with real code. Preserve the original paragraph text and structure exactly, and keep non-target pages unchanged.',
    'After generation, create a separate read-only validator named verify_pdf_layout.py and run it after the write. It must reopen both source and output and assert: the requested heading maps to the written pages; the full requested text appears in order on target pages; non-target pages remain unchanged; every inserted glyph bbox stays inside the writable rectangle and above forbidden boundaries; continuation and indentation rules hold; and all requested PNG previews are present, non-empty, and match freshly rendered output pages.',
    'Do not call browser_open_url with a local file:// PDF or PNG; browser tools accept only http/https URLs. Inspect local PDF and image files through bash_exec and the read-only validator.',
    `Only after every assertion passes may the validator print the exact standalone marker ${PDF_LAYOUT_VERIFICATION_OK}. A read_file or directory listing proves existence only and is not layout verification. Do not claim completion without a successful validator result containing that marker.`,
  ].join(' ')
}

function isSuccessfulPdfLayoutVerification(call, result) {
  if (call?.name !== 'bash_exec' || !isSuccessfulToolResult(result)) return false
  if (Array.isArray(call?.args?.expected_outputs) && call.args.expected_outputs.length > 0) return false
  const command = String(call?.args?.command || '')
  if (command.includes(PDF_LAYOUT_VERIFICATION_OK)) return false
  const output = `${String(result?.stdout || '')}\n${String(result?.stderr || '')}`
  if (!new RegExp(`(?:^|\\r?\\n)${PDF_LAYOUT_VERIFICATION_OK}(?:\\r?\\n|$)`).test(output)) return false
  return PDF_LAYOUT_VALIDATOR_COMMAND.test(command) || isReadOnlyPythonVerificationCall(call)
}

function restoreFailureRecovery(value = {}) {
  const attempts = Array.isArray(value?.attempts)
    ? value.attempts.slice(-FAILURE_RECOVERY_THRESHOLD).map((attempt) => ({
        tool: String(attempt?.tool || '').slice(0, 120),
        code: String(attempt?.code || 'tool_execution_failed').slice(0, 160),
        message: String(attempt?.message || 'Tool execution failed.').slice(0, 800),
      })).filter((attempt) => attempt.tool)
    : []
  return {
    tool: String(value?.tool || '').slice(0, 120),
    count: Math.max(0, Number(value?.count) || 0),
    reflected: value?.reflected === true,
    attempts,
  }
}

function serializeFailureRecovery(value) {
  return {
    tool: value.tool,
    count: value.count,
    reflected: value.reflected,
    attempts: value.attempts,
  }
}

function normalizeProbePath(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/')
}

function probePathsFromCall(call) {
  const paths = []
  const add = (value) => {
    const path = normalizeProbePath(value)
    if (path) paths.push(path)
  }
  add(call?.args?.path || call?.args?.file_path || call?.args?.filePath)
  if (call?.name === 'multi_edit') {
    for (const edit of Array.isArray(call?.args?.edits) ? call.args.edits : []) {
      add(edit?.path || edit?.file_path || edit?.filePath)
    }
  }
  if (call?.name === 'apply_patch') {
    for (const match of String(call?.args?.patch || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
      add(match[1])
    }
  }
  return paths
}

function installAttemptSignature(call) {
  if (call?.name !== 'bash_exec') return ''
  const command = String(call?.args?.command || '')
  const patterns = [
    { family: 'pip', regex: /(?:^|[;&|]\s*)(?:(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+)?pip(?:3)?(?:\.exe)?\s+install\b([^;&|\r\n]*)/i },
    { family: 'npm', regex: /(?:^|[;&|]\s*)(npm|pnpm|yarn)\s+(?:install|add|i)\b([^;&|\r\n]*)/i },
  ]
  for (const { family, regex } of patterns) {
    const match = command.match(regex)
    if (!match) continue
    const manager = family === 'npm' ? String(match[1] || family).toLowerCase() : family
    const tail = String(match[family === 'npm' ? 2 : 1] || '')
    const packages = tail
      .match(/"[^"]+"|'[^']+'|[^\s]+/g)
      ?.map((token) => token.replace(/^['"]|['"]$/g, ''))
      .filter((token) => token && !token.startsWith('-') && !/^(?:true|false)$/i.test(token))
      .map((token) => token.replace(/[<>=!~].*$/, '').replace(/@(?:latest|next|\d.*)$/i, ''))
      .filter(Boolean)
      .sort() || []
    return `${manager}:${packages.join(',') || '<project>'}`
  }
  return ''
}

function hasInlinePythonMutation(code) {
  return PYTHON_INLINE_MUTATION.test(code)
    || PYTHON_PATH_OPEN_MUTATION.test(code)
    || PYTHON_PRINT_FILE_MUTATION.test(code)
}

function isProbeLikeCall(call) {
  if (probePathsFromCall(call).some((path) => PROBE_SCRIPT_PATH.test(path))) return true
  if (call?.name !== 'bash_exec') return false
  // An explicit output contract or a statically visible file write is real
  // production work even when inline Python imports a library. The broad
  // environment-probe heuristic below intentionally recognizes `import`, so
  // these stronger mutation signals must win first.
  if (Array.isArray(call?.args?.expected_outputs) && call.args.expected_outputs.length > 0) {
    return false
  }
  const inlineCode = inlinePythonCode(call)
  if (inlineCode && hasInlinePythonMutation(inlineCode)) return false
  const command = String(call?.args?.command || '')
  return PROBE_SCRIPT_REFERENCE.test(command) || ENVIRONMENT_PROBE_COMMAND.test(command)
}

function isExplorationOnlyCall(call, userId = null) {
  if (isProbeLikeCall(call) || installAttemptSignature(call)) return true
  return getToolMetadata(call?.name, { args: call?.args, userId }).isReadOnly === true
}

function restoreExecutionConvergence(value = {}) {
  return {
    unproductiveRounds: Math.max(0, Number(value?.unproductiveRounds) || 0),
    interventions: Math.max(0, Number(value?.interventions) || 0),
    interventionActive: value?.interventionActive === true,
    installAttempts: Array.isArray(value?.installAttempts)
      ? [...new Set(value.installAttempts.map((item) => String(item || '').slice(0, 240)).filter(Boolean))]
          .slice(-MAX_INSTALL_ATTEMPT_SIGNATURES)
      : [],
  }
}

function serializeExecutionConvergence(value) {
  return {
    unproductiveRounds: value.unproductiveRounds,
    interventions: value.interventions,
    interventionActive: value.interventionActive,
    installAttempts: [...value.installAttempts].slice(-MAX_INSTALL_ATTEMPT_SIGNATURES),
  }
}

function isProductiveExecutionOutcome(call, result, artifactId = null) {
  if (!isSuccessfulToolResult(result)) return false
  if (artifactId) return true
  if (isProbeLikeCall(call) || installAttemptSignature(call)) return false
  if (!isMutationExecutionCall(call, artifactId)) return false
  if (call?.name === 'bash_exec'
    && Array.isArray(call?.args?.expected_outputs)
    && Object.hasOwn(result || {}, 'changedPaths')) {
    return Array.isArray(result.changedPaths) && result.changedPaths.length > 0
  }
  return true
}

function shouldReflectOnFailure(result) {
  if (result?.ok !== false) return false
  const code = String(result?.code || '')
  return !TOOL_AUTHORING_FAILURE_CODES.has(code)
    && !NON_REFLECTIVE_FAILURE_CODES.has(code)
    && result?.denied !== true
    && result?.cancelled !== true
}

function progressChangesFor(call, result) {
  if (!isLocalMutationCall(call)) return { changedPaths: [], changes: [] }
  const changes = Array.isArray(result?.changes) ? result.changes : []
  const changedPaths = []
  if (result?.path) changedPaths.push(result.path)
  for (const path of Array.isArray(result?.changedPaths) ? result.changedPaths : []) {
    if (path) changedPaths.push(path)
  }
  for (const change of changes) {
    if (change?.path) changedPaths.push(change.path)
  }
  return { changedPaths, changes }
}

function inlinePythonCode(call) {
  if (call?.name !== 'bash_exec') return ''
  if (Array.isArray(call?.args?.expected_outputs) && call.args.expected_outputs.length > 0) return ''
  const source = String(call?.args?.command || '').trim()
  const match = source.match(/^(?:(?:"[^"]*(?:python(?:3)?|py)(?:\.exe)?")|(?:[^\s"]*[\\/])?(?:python(?:3)?|py)(?:\.exe)?)(?:\s+(?!-c\b)-[^\s]+)*\s+-c\s+([\s\S]+)$/i)
  if (!match) return ''
  const rawCode = String(match[1] || '').trim()
  const quote = rawCode[0]
  if (!['"', "'"].includes(quote) || rawCode.at(-1) !== quote) return ''
  return rawCode.slice(1, -1)
}

function isReadOnlyPythonVerificationCall(call) {
  const code = inlinePythonCode(call)
  return Boolean(code)
    && PYTHON_INLINE_READ_EVIDENCE.test(code)
    && !hasInlinePythonMutation(code)
}

function isLocalMutationCall(call) {
  if (LOCAL_MUTATION_TOOLS.has(call?.name)) {
    return !(call?.name === 'apply_patch' && call?.args?.dry_run === true)
  }
  if (call?.name !== 'bash_exec' || isVerificationCall(call)) return false
  return getToolMetadata(call.name, { args: call.args }).isReadOnly !== true
}

function isVerificationCall(call) {
  if (VERIFICATION_TOOLS.has(call?.name)) return true
  if (call?.name !== 'bash_exec') return false
  // Declared outputs make the command a mutation contract even when the same
  // shell line also runs tests/lint/build. The executor snapshots and verifies
  // these outputs, so classifying the whole call as read-only would discard the
  // real changedPaths and incorrectly report that no execution occurred.
  if (Array.isArray(call?.args?.expected_outputs) && call.args.expected_outputs.length > 0) {
    return false
  }
  const command = String(call?.args?.command || '')
  return SHELL_VERIFICATION_COMMAND.test(command)
    || PDF_LAYOUT_VALIDATOR_COMMAND.test(command)
    || isReadOnlyPythonVerificationCall(call)
    || getToolMetadata(call.name, { args: call.args }).isReadOnly === true
}

function isMutationExecutionCall(call, artifactId = null) {
  if (!isSubstantiveToolCall(call)) return false
  if (artifactId || isFileArtifactTool(call?.name) || CONNECTOR_WRITE_TOOL_NAMES.includes(call?.name)) return true
  if (LOCAL_MUTATION_TOOLS.has(call?.name)) return isLocalMutationCall(call)
  if (call?.name === 'bash_exec') return isLocalMutationCall(call)
  const metadata = getToolMetadata(call?.name, { args: call?.args })
  // Dynamic MCP/plugin writes normally use riskClass=external and do not
  // appear in the built-in connector-name list. A successful one is concrete
  // mutation evidence; ignoring it makes the completion guard ask the model
  // to create/send the same external object again.
  return metadata.isReadOnly === false
}

function normalizeMutationTarget(rawTarget) {
  let target = String(rawTarget || '').trim()
  if (!target) return ''
  if ((target.startsWith('"') && target.endsWith('"'))
    || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1).trim()
  }
  if (!target || target.startsWith('-') || target.startsWith('&')) return ''
  target = target.replace(/\\/g, '/').replace(/\/+/g, '/')
  while (target.startsWith('./')) target = target.slice(2)
  if (target.length > 1) target = target.replace(/\/$/, '')
  return target
}

function targetsMatch(left, right) {
  const a = normalizeMutationTarget(left)
  const b = normalizeMutationTarget(right)
  if (!a || !b) return false
  const normalizeCase = (value) => process.platform === 'win32' ? value.toLowerCase() : value
  const comparableA = normalizeCase(a)
  const comparableB = normalizeCase(b)
  if (comparableA === comparableB) return true
  const aAbsolute = /^(?:[a-z]:\/|\/)/i.test(a)
  const bAbsolute = /^(?:[a-z]:\/|\/)/i.test(b)
  if (aAbsolute === bAbsolute) return false
  const absolute = aAbsolute ? comparableA : comparableB
  const relative = aAbsolute ? b : a
  const workspaceRoot = normalizeMutationTarget(
    process.env.WORKSPACE_ROOT?.trim() || process.cwd(),
  )
  if (!workspaceRoot) return false
  const resolvedRelative = normalizeMutationTarget(
    relative === '.' ? workspaceRoot : `${workspaceRoot}/${relative}`,
  )
  return absolute === normalizeCase(resolvedRelative)
}

function clearWorkspaceScopedMutationTargets(pendingTargets) {
  let cleared = false
  for (const pending of [...pendingTargets]) {
    if (pending === PROJECT_SCOPE_TARGET) {
      pendingTargets.delete(pending)
      cleared = true
      continue
    }
    const normalized = normalizeMutationTarget(pending)
    if (!normalized) continue
    // Project checks validate project-relative source state. An absolute target
    // may be a separately authorized artifact (PDF/PNG/etc.), even when it
    // happens to sit below WORKSPACE_ROOT, so it still needs target-specific
    // read/list/diff evidence before completion.
    if (/^(?:[a-z]:\/|\/)/i.test(normalized)) continue
    pendingTargets.delete(pending)
    cleared = true
  }
  return cleared
}

function shellTargetWithCwd(target, cwd) {
  const normalized = normalizeMutationTarget(target)
  if (!normalized || /^(?:[a-z]:\/|\/)/i.test(normalized)) return normalized
  const normalizedCwd = normalizeMutationTarget(cwd)
  if (!normalizedCwd || normalizedCwd === '.') return normalized
  return normalizeMutationTarget(`${normalizedCwd}/${normalized}`)
}

function looksLikeDeletionCommand(command) {
  const source = String(command || '')
  return /(?:^|[;&|\r\n])\s*(?:rm|unlink|rmdir|del|erase|rd|remove-item)(?:\.exe)?\b/i.test(source)
    || /^\s*(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*\bremove-item\b/i.test(source)
}

function tokenizeStaticDeletionCommand(command) {
  const source = String(command || '').trim()
  // Compensation is safe only when this is one literal delete operation with
  // no chaining, redirection, variable expansion, or shell escaping.
  if (!source || /[&|;<>\r\n\x60^]/.test(source)) return null
  const tokens = []
  let token = ''
  let quote = ''
  for (const character of source) {
    if (quote) {
      if (character === quote) quote = ''
      else token += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (token) {
        tokens.push(token)
        token = ''
      }
      continue
    }
    token += character
  }
  if (quote) return null
  if (token) tokens.push(token)
  return tokens
}

function isAllowedWindowsDeletionSwitch(commandName, token) {
  if (!token.startsWith('/')) return false
  if (['rd', 'rmdir'].includes(commandName)) return /^\/[sq]$/i.test(token)
  return /^\/(?:[fpqs]|a(?::[rhsa-]+)?)$/i.test(token)
}

function isStaticDeletionTarget(value) {
  const target = String(value || '').trim()
  if (!target || target === '.' || target === '/' || /^[a-z]:[\\/]?$/i.test(target)) return false
  if (/[%!$*?[\]{}~,]/.test(target)) return false
  if (/(?:^|[\\/])\.\.(?:$|[\\/])/.test(target)) return false
  return true
}

function staticWindowsDeletionTargets(call, result = null) {
  if (call?.name !== 'bash_exec') return null
  const tokens = tokenizeStaticDeletionCommand(call?.args?.command)
  if (!tokens?.length) return null
  const commandName = String(tokens.shift() || '').toLowerCase().replace(/\.exe$/, '')
  if (!['del', 'erase', 'rd', 'rmdir'].includes(commandName)) return null

  const rawTargets = []
  for (const token of tokens) {
    if (token.startsWith('/')) {
      if (!isAllowedWindowsDeletionSwitch(commandName, token)) return null
      continue
    }
    if (!isStaticDeletionTarget(token)) return null
    rawTargets.push(token)
  }
  if (rawTargets.length === 0) return null

  const cwd = call?.args?.cwd || result?.cwd
  const targets = new Set(rawTargets.map((target) => shellTargetWithCwd(target, cwd)).filter(Boolean))
  return targets.size === rawTargets.length ? targets : null
}

function isAllowedUnixDeletionSwitch(commandName, token) {
  if (commandName === 'rm') {
    return /^-[dfirRv]+$/.test(token)
      || ['--dir', '--force', '--interactive', '--recursive', '--verbose'].includes(token)
  }
  if (commandName === 'unlink') return token === '-f' || token === '--force'
  if (commandName === 'rmdir') {
    return /^-[pv]+$/.test(token)
      || ['--ignore-fail-on-non-empty', '--parents', '--verbose'].includes(token)
  }
  return false
}

function staticUnixDeletionTargets(call, result = null) {
  if (call?.name !== 'bash_exec') return null
  const tokens = tokenizeStaticDeletionCommand(call?.args?.command)
  if (!tokens?.length) return null
  const commandName = String(tokens.shift() || '').toLowerCase().replace(/\.exe$/, '')
  if (!['rm', 'unlink', 'rmdir'].includes(commandName)) return null

  const rawTargets = []
  let optionsEnded = false
  for (const token of tokens) {
    if (!optionsEnded && token === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && token.startsWith('-')) {
      if (!isAllowedUnixDeletionSwitch(commandName, token)) return null
      continue
    }
    if (!isStaticDeletionTarget(token)) return null
    rawTargets.push(token)
  }
  if (rawTargets.length === 0) return null

  const cwd = call?.args?.cwd || result?.cwd
  const targets = new Set(rawTargets.map((target) => shellTargetWithCwd(target, cwd)).filter(Boolean))
  return targets.size === rawTargets.length ? targets : null
}

function parseStaticPowerShellRemoveItem(tokens, cwd) {
  const remaining = [...tokens]
  const commandName = String(remaining.shift() || '').toLowerCase().replace(/\.exe$/, '')
  if (commandName !== 'remove-item') return null

  let rawTarget = ''
  while (remaining.length > 0) {
    const token = String(remaining.shift() || '')
    const normalized = token.toLowerCase()
    if (normalized === '-force' || normalized === '-recurse') continue
    if (normalized !== '-literalpath' || rawTarget || remaining.length === 0) return null
    const candidate = String(remaining.shift() || '')
    if (!isStaticDeletionTarget(candidate)) return null
    rawTarget = candidate
  }
  if (!rawTarget) return null
  const target = shellTargetWithCwd(rawTarget, cwd)
  return target ? new Set([target]) : null
}

function staticPowerShellDeletionTargets(call, result = null) {
  if (call?.name !== 'bash_exec') return null
  const tokens = tokenizeStaticDeletionCommand(call?.args?.command)
  if (!tokens?.length) return null
  const commandName = String(tokens[0] || '').toLowerCase().replace(/\.exe$/, '')
  const cwd = call?.args?.cwd || result?.cwd
  if (commandName === 'remove-item') return parseStaticPowerShellRemoveItem(tokens, cwd)
  if (!['powershell', 'pwsh'].includes(commandName)) return null

  tokens.shift()
  while (tokens.length > 0) {
    const option = String(tokens.shift() || '').toLowerCase()
    if (['-encodedcommand', '-enc', '-e'].includes(option)) return null
    if (['-noprofile', '-noninteractive', '-nologo'].includes(option)) continue
    if (!['-command', '-c'].includes(option) || tokens.length === 0) return null
    const commandTokens = tokens.length === 1
      ? tokenizeStaticDeletionCommand(tokens[0])
      : tokens
    return commandTokens?.length
      ? parseStaticPowerShellRemoveItem(commandTokens, cwd)
      : null
  }
  return null
}

function staticDeletionTargets(call, result = null) {
  for (const parser of [
    staticWindowsDeletionTargets,
    staticUnixDeletionTargets,
    staticPowerShellDeletionTargets,
  ]) {
    const targets = parser(call, result)
    if (targets?.size) return targets
  }
  return null
}

function extractInlinePythonMutationTargets(call) {
  const code = inlinePythonCode(call)
  if (!code) return new Set()
  const targets = new Set()
  const add = (value) => {
    const target = normalizeMutationTarget(value)
    if (target) targets.add(target)
  }
  const writeMode = (value) => /[wax+]/i.test(String(value || ''))
  const patterns = [
    /\bopen\s*\(\s*(?:file\s*=\s*)?[rRuUbB]{0,2}'([^'\r\n]+)'\s*,\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}'([^'\r\n]+)'/g,
    /\bopen\s*\(\s*(?:file\s*=\s*)?[rRuUbB]{0,2}"([^"\r\n]+)"\s*,\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}"([^"\r\n]+)"/g,
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}'([^'\r\n]+)'\s*\)\s*\.open\s*\(\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}'([^'\r\n]+)'/g,
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}"([^"\r\n]+)"\s*\)\s*\.open\s*\(\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}"([^"\r\n]+)"/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (writeMode(match[2])) add(match[1])
    }
  }
  const directWriters = [
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}'([^'\r\n]+)'\s*\)\s*\.(?:write_text|write_bytes|touch)\s*\(/g,
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}"([^"\r\n]+)"\s*\)\s*\.(?:write_text|write_bytes|touch)\s*\(/g,
  ]
  for (const pattern of directWriters) {
    for (const match of code.matchAll(pattern)) add(match[1])
  }
  return targets
}

function extractShellMutationTargets(call, cwd = call?.args?.cwd) {
  const command = String(call?.args?.command || '')
  const targets = new Set()
  const add = (value) => {
    const target = shellTargetWithCwd(value, cwd)
    if (target) targets.add(target)
  }
  const redirection = /\d?>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g
  for (const match of command.matchAll(redirection)) add(match[1] || match[2] || match[3])
  const pathArgument = /\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item)\b[^\r\n;|]{0,160}?(?:-(?:Literal)?Path\s+)(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/gi
  for (const match of command.matchAll(pathArgument)) add(match[1] || match[2] || match[3])
  const simpleWriter = /(?:^|[;&|]\s*|\s)(?:touch|mkdir|rm|unlink|tee)\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi
  for (const match of command.matchAll(simpleWriter)) add(match[1] || match[2] || match[3])
  const windowsDeleter = /(?:^|[;&|]\s*|\s)(?:del|erase|rd|rmdir)\s+(?:\/[A-Za-z?]+(?::[^\s]+)?\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi
  for (const match of command.matchAll(windowsDeleter)) {
    const candidate = match[1] || match[2] || match[3]
    // Dynamic, wildcard, and parent-traversal deletes are intentionally left
    // unknown so extractMutationTargets falls back to <workspace>.
    if (/[%$*?]/.test(candidate) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(candidate)) continue
    add(candidate)
  }
  for (const target of extractInlinePythonMutationTargets(call)) add(target)
  return targets
}

function extractMutationTargets(call, result) {
  const targets = new Set()
  const shellCwd = call?.name === 'bash_exec'
    ? result?.cwd || call?.args?.cwd
    : null
  const canonicalExecutorPaths = new Set(
    (Array.isArray(result?.verifiedOutputs) ? result.verifiedOutputs : [])
      .map((output) => normalizeMutationTarget(output?.path))
      .filter(Boolean),
  )
  const normalizedShellCwd = normalizeMutationTarget(shellCwd)
  const add = (value, { reportedByExecutor = false } = {}) => {
    const normalizedValue = normalizeMutationTarget(value)
    const alreadyResolvedAgainstRelativeCwd = normalizedShellCwd
      && normalizedShellCwd !== '.'
      && !/^(?:[a-z]:\/|\/)/i.test(normalizedShellCwd)
      && (normalizedValue === normalizedShellCwd
        || normalizedValue.startsWith(`${normalizedShellCwd}/`))
    const target = reportedByExecutor
      && call?.name === 'bash_exec'
      && !canonicalExecutorPaths.has(normalizedValue)
      && !alreadyResolvedAgainstRelativeCwd
      ? shellTargetWithCwd(value, shellCwd)
      : normalizedValue
    if (target) targets.add(target)
  }
  // Executors and pre-tool hooks may rewrite a requested path. Prefer the
  // canonical path reported by the successful result; call arguments are only
  // a fallback when the executor cannot report what it actually changed.
  add(result?.path, { reportedByExecutor: true })
  add(result?.output_path, { reportedByExecutor: true })
  add(result?.output, { reportedByExecutor: true })
  add(result?.outputDir, { reportedByExecutor: true })
  for (const output of Array.isArray(result?.outputs) ? result.outputs : []) {
    add(output?.path, { reportedByExecutor: true })
  }
  for (const mapping of Array.isArray(result?.renamed) ? result.renamed : []) {
    if (mapping?.unchanged !== true) add(mapping?.to, { reportedByExecutor: true })
  }
  if (call?.name === 'archive_extract') {
    for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
      add(entry?.outputPath, { reportedByExecutor: true })
    }
  }
  const hasAuthoritativeChangedPaths = Array.isArray(result?.changedPaths)
  for (const path of hasAuthoritativeChangedPaths ? result.changedPaths : []) {
    add(path, { reportedByExecutor: true })
  }
  for (const change of Array.isArray(result?.changes) ? result.changes : []) {
    add(change?.path, { reportedByExecutor: true })
  }
  // expected_outputs verification deliberately returns changedPaths, including
  // an empty list when nothing changed. In that case the executor's evidence is
  // authoritative: do not turn unchanged/missing declarations into mutations.
  if (targets.size > 0 || hasAuthoritativeChangedPaths) return targets
  if (['write_file', 'edit_file'].includes(call?.name)) add(call?.args?.path)
  if (call?.name === 'multi_edit') {
    add(call?.args?.path)
    for (const edit of Array.isArray(call?.args?.edits) ? call.args.edits : []) {
      add(edit?.path || edit?.file_path || edit?.filePath)
    }
  }
  if (call?.name === 'apply_patch') {
    const patch = String(call?.args?.patch || '')
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) add(match[1])
  }
  if (call?.name === 'bash_exec') {
    if (looksLikeDeletionCommand(call?.args?.command)) {
      const deletionTargets = staticDeletionTargets(call, result)
      if (!deletionTargets?.size) targets.add(PROJECT_SCOPE_TARGET)
      else for (const target of deletionTargets) add(target)
      return targets
    }
    for (const target of Array.isArray(call?.args?.expected_outputs) ? call.args.expected_outputs : []) {
      add(shellTargetWithCwd(target, call?.args?.cwd))
    }
    for (const target of extractShellMutationTargets(call, shellCwd)) add(target)
  }
  if (targets.size === 0) targets.add(PROJECT_SCOPE_TARGET)
  return targets
}

function readResultCanVerifyMutation(result) {
  const extractionStatus = String(result?.extractionStatus || '').trim().toLowerCase()
  if (extractionStatus) return extractionStatus === 'text'
  return true
}

function addVerificationTarget(targets, value) {
  const candidate = value && typeof value === 'object'
    ? value.path || value.file || value.filePath || value.filename
    : value
  const target = normalizeMutationTarget(candidate)
  if (target && target !== '/dev/null') targets.add(target.replace(/^(?:a|b)\//, ''))
}

function diffVerificationTargets(call, result) {
  const diff = String(result?.diff || '').trim()
  if (!diff) return new Set()
  const targets = new Set()
  addVerificationTarget(targets, result?.path || call?.args?.path)
  for (const value of Array.isArray(result?.changedFiles) ? result.changedFiles : []) {
    addVerificationTarget(targets, value)
  }
  for (const value of Array.isArray(result?.changes) ? result.changes : []) {
    addVerificationTarget(targets, value)
  }
  for (const match of diff.matchAll(/^diff --git\s+(?:"?a\/)?(.+?)"?\s+(?:"?b\/)?(.+?)"?$/gm)) {
    addVerificationTarget(targets, match[2] || match[1])
  }
  for (const match of diff.matchAll(/^\+\+\+\s+(?:"?b\/)?(.+?)"?(?:\t.*)?$/gm)) {
    addVerificationTarget(targets, match[1])
  }
  return targets
}

function listDirectoryVerificationTargets(call, result) {
  if (result?.ok !== true) return new Set()
  const directory = normalizeMutationTarget(result?.path || call?.args?.path)
  if (!directory) return new Set()
  const targets = new Set()
  for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
    const rawEntry = entry && typeof entry === 'object'
      ? entry.path || entry.name
      : entry
    const normalizedEntry = normalizeMutationTarget(rawEntry)
    if (!normalizedEntry || normalizedEntry === '.' || normalizedEntry === '..') continue
    const target = /^(?:[a-z]:\/|\/)/i.test(normalizedEntry)
      ? normalizedEntry
      : normalizeMutationTarget(`${directory}/${normalizedEntry}`)
    if (target) targets.add(target)
  }
  return targets
}

function clearVerifiedDeletionTargets(pendingTargets, call, result) {
  if (!pendingTargets.size || call?.name !== 'list_directory') return false
  // Absence is evidence only when the executor explicitly confirms that the
  // parent listing is complete. A limited/truncated listing cannot prove that
  // an omitted target was deleted.
  if (result?.ok !== true || result?.truncated !== false || !Array.isArray(result?.entries)) {
    return false
  }
  const directory = normalizeMutationTarget(result?.path || call?.args?.path)
  if (!directory) return false
  const listedTargets = listDirectoryVerificationTargets(call, result)
  const directoryCandidates = new Set([
    directory,
    normalizeMutationTarget(call?.args?.path),
  ].filter(Boolean))
  let cleared = false
  for (const pending of [...pendingTargets]) {
    const normalized = normalizeMutationTarget(pending)
    const separator = normalized.lastIndexOf('/')
    if (!normalized || separator === normalized.length - 1) continue
    const parent = separator < 0
      ? '.'
      : separator === 0
        ? '/'
        : normalized.slice(0, separator)
    if (![...directoryCandidates].some((candidate) => targetsMatch(parent, candidate))) continue
    if ([...listedTargets].some((listed) => targetsMatch(normalized, listed))) continue
    pendingTargets.delete(pending)
    cleared = true
  }
  return cleared
}

function clearExplicitTargetsMatchingEvidence(pendingTargets, evidenceTargets) {
  if (!evidenceTargets.size) return false
  let cleared = false
  for (const pending of [...pendingTargets]) {
    if (pending === PROJECT_SCOPE_TARGET) continue
    if ([...evidenceTargets].some((evidence) => targetsMatch(pending, evidence))) {
      pendingTargets.delete(pending)
      cleared = true
    }
  }
  return cleared
}

function clearTargetsMatchingEvidence(pendingTargets, evidenceTargets) {
  if (!evidenceTargets.size) return false
  let cleared = false
  if (pendingTargets.delete(PROJECT_SCOPE_TARGET)) cleared = true
  for (const pending of [...pendingTargets]) {
    if ([...evidenceTargets].some((evidence) => targetsMatch(pending, evidence))) {
      pendingTargets.delete(pending)
      cleared = true
    }
  }
  return cleared
}

function clearVerifiedMutationTargets(pendingTargets, call, result) {
  if (!pendingTargets.size) return false
  if (call?.name === 'list_directory') {
    const evidence = listDirectoryVerificationTargets(call, result)
    if (result?.ok === true) {
      addVerificationTarget(evidence, result?.path || call?.args?.path)
    }
    return clearExplicitTargetsMatchingEvidence(
      pendingTargets,
      evidence,
    )
  }
  if (call?.name === 'git_diff') {
    return clearTargetsMatchingEvidence(pendingTargets, diffVerificationTargets(call, result))
  }
  if (call?.name === 'run_project_check') {
    return clearWorkspaceScopedMutationTargets(pendingTargets)
  }
  if (call?.name === 'bash_exec') {
    const command = String(call?.args?.command || '')
    if (/\bgit\s+diff\b/i.test(command)) {
      return clearTargetsMatchingEvidence(pendingTargets, diffVerificationTargets(call, {
        ...result,
        diff: result?.diff || result?.stdout,
      }))
    }
    if (SHELL_PROJECT_CHECK_COMMAND.test(command)) {
      return clearWorkspaceScopedMutationTargets(pendingTargets)
    }
  }
  if (call?.name === 'read_file') {
    if (!readResultCanVerifyMutation(result)) return false
    const evidence = new Set()
    addVerificationTarget(evidence, result?.path)
    addVerificationTarget(evidence, call?.args?.path)
    return clearExplicitTargetsMatchingEvidence(pendingTargets, evidence)
  }
  const evidence = new Set()
  addVerificationTarget(evidence, result?.path)
  if (call?.name === 'image_info') {
    addVerificationTarget(evidence, call?.args?.path)
  } else if (call?.name === 'media_probe') {
    addVerificationTarget(evidence, call?.args?.input_path)
  } else if (call?.name === 'pdf_info' || call?.name === 'pdf_text') {
    addVerificationTarget(evidence, call?.args?.path || call?.args?.input)
  } else if (call?.name === 'archive_list') {
    addVerificationTarget(evidence, result?.input)
    addVerificationTarget(evidence, call?.args?.input)
  } else {
    return false
  }
  return clearExplicitTargetsMatchingEvidence(pendingTargets, evidence)
}

function artifactDeliveryError(expectedTools) {
  const names = [...expectedTools].join(', ')
  const error = new Error(`The requested file was not created. The model must successfully call: ${names}.`)
  error.code = 'ARTIFACT_NOT_CREATED'
  return error
}

function persistGeneratedArtifact({ artifact, args, job, step }) {
  const common = {
    id: artifact.id,
    userId: job.userId,
    type: artifact.type,
    title: artifact.title || args.title,
    url: artifact.url,
    filename: artifact.filename,
  }
  return job?.origin === 'chat'
    ? appendTurnArtifact({ ...common, sessionId: job.sessionId, turnId: job.id })
    : appendJobArtifact({ ...common, jobId: job.id, stepId: step?.id || null })
}

/**
 * TurnEngine consumes the exact same static schemas exposed by toolRegistry.
 * Connector schemas stay separate because availability is filtered per user
 * by resolveTurnToolSpecs at the beginning of every turn.
 */
export const SERVER_TOOL_SPECS = [
  ...listBuiltinSpecs(),
  ...CONNECTOR_TOOL_SPECS,
].filter(Boolean)

/**
 * 为一次运行选择稳定的工具 schema 集。聊天按回答/执行两类能力路由，
 * 让模型从已启用工具中选择具体能力，不再逐类猜关键词；后台 Job 已有
 * 明确计划步骤，继续保留更窄的产物合同。
 */
export function selectJobToolSpecs({
  prompt = '',
  userPrompt = prompt,
  skillId = undefined,
  specs = SERVER_TOOL_SPECS,
  origin = '',
  intentMode = 'auto',
  userId = null,
  metadataResolver = undefined,
} = {}) {
  const allowed = allowedArtifactTools(userPrompt, { skillId })
  const artifactFiltered = specs.filter((spec) => {
    const name = spec?.function?.name
    if (!name) return false
    return !isFileArtifactTool(name) || allowed.has(name)
  })
  if (origin === 'chat') {
    return selectChatToolSpecs({
      prompt,
      userPrompt,
      specs: artifactFiltered,
      intentMode,
      executionRequired: allowed.size > 0,
      userId,
      ...(metadataResolver ? { metadataResolver } : {}),
    })
  }
  return artifactFiltered
}

function localArtifactCandidates(call, result) {
  if (call?.name === 'write_file') {
    return [{ path: result?.path || call?.args?.path, scope: result?.scope }]
  }
  if (call?.name === 'image_transform') {
    return [{ path: result?.path || call?.args?.output_path, scope: result?.scope }]
  }
  if (call?.name === 'media_transform') {
    return [{
      path: result?.path || result?.output_path || call?.args?.output_path,
      scope: result?.scope,
    }]
  }
  if (call?.name === 'pdf_transform') {
    return (Array.isArray(result?.outputs) ? result.outputs : [])
      .map((output) => ({ path: output?.path, scope: output?.scope }))
  }
  if (call?.name === 'archive_create') {
    return [{ path: result?.output || call?.args?.output, scope: result?.scope }]
  }
  if (call?.name !== 'bash_exec') return []
  return (Array.isArray(result?.verifiedOutputs) ? result.verifiedOutputs : [])
    .filter((output) => output?.type === 'file')
}

function resolveLocalArtifactSource(candidate, call, result) {
  const reported = String(candidate?.path || '').trim()
  const declared = String(candidate?.declaredPath || '').trim()
  if (reported && path.isAbsolute(reported)) return reported
  if (candidate?.scope === 'workspace' && reported) return resolveInWorkspace(reported)
  if (declared && path.isAbsolute(declared)) return declared
  const cwd = String(result?.cwd || call?.args?.cwd || '').trim()
  if (cwd && path.isAbsolute(cwd)) return path.resolve(cwd, declared || reported)
  return resolveInWorkspace(reported || declared)
}

export function persistLocalToolArtifacts({ call, result, job, step }) {
  if (result?.ok !== true || ![
    'write_file',
    'bash_exec',
    'image_transform',
    'media_transform',
    'pdf_transform',
    'archive_create',
  ].includes(call?.name)) return []
  const persisted = []
  const seen = new Set()
  for (const candidate of localArtifactCandidates(call, result)) {
    let artifact = null
    try {
      const sourcePath = resolveLocalArtifactSource(candidate, call, result)
      const key = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath
      if (seen.has(key)) continue
      seen.add(key)
      artifact = createLocalFileArtifact({ sourcePath, filename: path.basename(sourcePath) })
      persistGeneratedArtifact({ artifact, args: { title: artifact.title }, job, step })
      persisted.push(artifact)
    } catch {
      if (artifact?.fullPath) {
        try { fs.unlinkSync(artifact.fullPath) } catch { /* best-effort orphan cleanup */ }
      }
      // A successful tool result remains successful if an output disappears
      // before it can be copied or has no safe downloadable filename.
    }
  }
  return persisted
}

async function persistLocalToolArtifactsAsync({ call, result, job, step }) {
  if (result?.ok !== true || ![
    'write_file',
    'bash_exec',
    'image_transform',
    'media_transform',
    'pdf_transform',
    'archive_create',
  ].includes(call?.name)) return []
  const persisted = []
  const seen = new Set()
  for (const candidate of localArtifactCandidates(call, result)) {
    let artifact = null
    try {
      const sourcePath = resolveLocalArtifactSource(candidate, call, result)
      const key = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath
      if (seen.has(key)) continue
      seen.add(key)
      artifact = await createLocalFileArtifactAsync({ sourcePath, filename: path.basename(sourcePath) })
      persistGeneratedArtifact({ artifact, args: { title: artifact.title }, job, step })
      persisted.push(artifact)
    } catch {
      if (artifact?.fullPath) {
        try { await fs.promises.unlink(artifact.fullPath) } catch { /* best-effort orphan cleanup */ }
      }
      // Preserve the successful source operation if an output disappears
      // before publication or cannot be copied into the artifact store.
    }
  }
  return persisted
}

export const selectToolSpecs = selectJobToolSpecs

const DIRECTORY_REVIEW_GUARD_MARKER = '[DIRECTORY REVIEW REPRESENTATIVE READ REQUIRED]'
const LIVE_STEERING_GUARD_MARKER = '[LIVE STEERING UPDATE CONTRACT]'
const DIRECTORY_REVIEW_INTENT = /read|inspect|review|understand|analy[sz]e|research|check|\u9605\u8bfb|\u8bfb\u53d6|\u5ba1\u67e5|\u7406\u89e3|\u4e86\u89e3|\u5206\u6790|\u7814\u7a76|\u68c0\u67e5/i
const TEXT_FILE = /\.(?:md|mdx|txt|json|ya?ml|toml|ini|cfg|conf|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|cs|php|sh|ps1|bat|cmd|xml|gradle|properties)$/i
const SENSITIVE_FILE = /(?:^\.|secret|credential|token|password|passwd|id_rsa|private[_-]?key)/i

function joinLocalPath(root, name) {
  const separator = String(root || '').includes('\\') ? '\\' : '/'
  return `${String(root || '').replace(/[\\/]+$/u, '')}${separator}${name}`
}

function pickRepresentativeFiles(entries = []) {
  const files = entries
    .filter((entry) => entry?.type === 'file' && typeof entry?.name === 'string')
    .map((entry) => entry.name)
    .filter((name) => name && !/[\\/]/u.test(name) && !SENSITIVE_FILE.test(name))
  const selected = []
  const pick = (...patterns) => {
    for (const pattern of patterns) {
      const found = files.find((name) => pattern.test(name) && !selected.includes(name))
      if (!found) continue
      selected.push(found)
      return
    }
  }
  pick(/^readme(?:\.[^.]+)?$/i, /^manual(?:\.[^.]+)?$/i, /^usage(?:\.[^.]+)?$/i, /^contributing(?:\.[^.]+)?$/i)
  pick(/^(?:package\.json|pyproject\.toml|requirements(?:-[^.]+)?\.txt|cargo\.toml|go\.mod|composer\.json|pom\.xml|build\.gradle|settings\.gradle)$/i)
  pick(/^main(?:\.[^.]+)$/i, /^start(?:\.[^.]+)$/i, /^app(?:\.[^.]+)$/i, /^server(?:\.[^.]+)$/i, /^index(?:\.[^.]+)$/i, /^dashboard(?:\.[^.]+)$/i)
  for (const name of files) {
    if (selected.length >= 3) break
    if (!selected.includes(name) && TEXT_FILE.test(name)) selected.push(name)
  }
  return selected.slice(0, 3)
}

function buildRepresentativeReadCalls(content, turnId) {
  const calls = []
  const blockPattern = /Path:\s*([^\r\n]+)\r?\nTool:\s*list_directory\r?\nSucceeded:\s*yes\r?\n(\{[^\r\n]+\})/giu
  for (const match of String(content || '').matchAll(blockPattern)) {
    let listing
    try {
      listing = JSON.parse(match[2])
    } catch {
      continue
    }
    const root = String(listing?.path || match[1] || '').trim()
    if (!root || !Array.isArray(listing?.entries)) continue
    for (const name of pickRepresentativeFiles(listing.entries)) {
      if (calls.length >= 3) break
      const suffix = String(turnId || 'turn').replace(/[^A-Za-z0-9_-]/g, '').slice(-24)
      calls.push({
        id: `local-project-read-${suffix}-${calls.length + 1}`,
        type: 'function',
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: joinLocalPath(root, name) }),
        },
      })
    }
    if (calls.length >= 3) break
  }
  return calls
}

function successfulReadFileInMessages(messages = []) {
  return messages.some((message) => {
    if (message?.role !== 'tool' || message?.name !== 'read_file') return false
    try {
      return JSON.parse(String(message.content || '{}'))?.ok === true
    } catch {
      return false
    }
  })
}

/**
 * 执行单个工具调用 → 落盘 artifact → appendJobArtifact → 返回给模型的简短结果。
 */
async function executeServerTool({
  name,
  args,
  job,
  step,
  signal,
  budget,
  approvalContext,
  allowedArtifactTools,
  toolCallId,
  idempotencyKey,
}) {
  if (isFileArtifactTool(name) && !allowedArtifactTools?.has(name)) {
    return {
      ok: false,
      code: 'artifact_tool_not_requested',
      error: `用户没有明确要求生成 ${name} 文件，本轮拒绝执行。`,
      retryable: false,
    }
  }
  if (name === 'web_search') {
    try {
      return await searchWeb({
        userId: job.userId,
        query: args?.query,
        maxResults: args?.max_results ?? args?.maxResults,
      })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'WEB_SEARCH_ERROR' })
    }
  }
  if (name === 'generate_image') {
    const generated = await generateImage({ userId: job.userId, ...args })
    const artifact = createImageArtifact({
      title: args.title || args.prompt,
      buffer: generated.buffer,
      mimeType: generated.mimeType,
    })
    persistGeneratedArtifact({ artifact, args, job, step })
    return {
      ok: true,
      artifactId: artifact.id,
      filename: artifact.filename,
      url: artifact.url,
      revisedPrompt: generated.revisedPrompt,
    }
  }
  if (name === 'fetch_url') {
    try {
      return await fetchAndExtract({ url: args?.url })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (name === 'create_pptx') {
    const artifact = await createPptx({
      title: args.title,
      subtitle: args.subtitle,
      theme: args.theme,
      brand: args.brand,
      slides: args.slides || [],
    })
    persistGeneratedArtifact({ artifact, args, job, step })
    return { ok: true, artifactId: artifact.id, filename: artifact.filename, url: artifact.url }
  }
  if (name === 'create_docx') {
    const artifact = await createDocx({ title: args.title, paragraphs: args.paragraphs || [] })
    persistGeneratedArtifact({ artifact, args, job, step })
    return { ok: true, artifactId: artifact.id, filename: artifact.filename, url: artifact.url }
  }
  if (name === 'create_xlsx') {
    const artifact = await createXlsx({ title: args.title, sheets: args.sheets || [] })
    persistGeneratedArtifact({ artifact, args, job, step })
    return { ok: true, artifactId: artifact.id, filename: artifact.filename, url: artifact.url }
  }
  if (name === 'create_html_app') {
    const artifact = createHtmlArtifact({ title: args.title, html: args.html, files: args.files })
    persistGeneratedArtifact({ artifact, args, job, step })
    return { ok: true, artifactId: artifact.id, filename: artifact.filename, url: artifact.url }
  }
  // fs/shell 工具不落 artifact,执行结果直接回给模型.
  // 任意 fsShellTools 抛错(包括 env 未启用 / 路径越界)都返回 {ok:false,error}.
  if (FS_SHELL_TOOL_NAMES.has(name)) {
    try {
      return await dispatchFsShellTool(name, args || {}, {
        userId: job?.userId || null,
        signal,
        toolCallId,
        idempotencyKey,
      })
    } catch (err) {
      return {
        ...normalizeToolError(err, { fallbackCode: 'fs_tool_failed' }),
        ...(err?.path ? { path: err.path } : {}),
      }
    }
  }
  if (IMAGE_TOOL_NAMES.has(name)) {
    try {
      return await dispatchImageTool(name, args || {}, { userId: job?.userId || null, signal })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'image_tool_failed' })
    }
  }
  if (MEDIA_TOOL_NAMES.has(name)) {
    try {
      return await dispatchMediaTool(name, args || {}, { userId: job?.userId || null, signal })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'media_tool_failed' })
    }
  }
  if (PDF_TOOL_NAMES.has(name)) {
    try {
      return await dispatchPdfTool(name, args || {}, { userId: job?.userId || null, signal })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'pdf_tool_failed' })
    }
  }
  if (BATCH_FILE_TOOL_NAMES.has(name)) {
    try {
      return await dispatchBatchFileTool(name, args || {}, { userId: job?.userId || null, signal })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'batch_file_tool_failed' })
    }
  }
  if (['grep_code', 'find_symbol', 'list_imports'].includes(name)) {
    try {
      return await dispatchCodeSearchTool(name, args || {}, { userId: job?.userId || null })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (name === 'apply_patch') {
    try {
      return await dispatchApplyPatchTool(name, args || {}, { userId: job?.userId || null })
    } catch (err) {
      return {
        ok: false,
        code: err?.code || 'apply_patch_failed',
        error: err?.message || String(err),
        retryable: err?.retryable ?? ![401, 403, 404].includes(err?.statusCode),
        ...(err?.path ? { path: err.path } : {}),
        ...(err?.hint ? { hint: err.hint } : {}),
      }
    }
  }
  if (name === 'remember') {
    return dispatchMemoryTool(name, args || {}, { userId: job?.userId || null })
  }
  if (['reflect', 'request_clarification', 'request_directory', 'sleep_until'].includes(name)) {
    try {
      const result = await dispatchAgenticTool(name, args || {}, { userId: job?.userId || null })
      return result && typeof result === 'object'
        ? { ok: true, ...result }
        : { ok: true, result }
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'fetch_url_failed' })
    }
  }
  if (name === 'Agent') {
    try {
      return await runSubagentBatch({
        userId: job?.userId || null,
        request: args || {},
        depth: -1,
        parentSessionId: job?.id || null,
        parentMessageId: step?.id || null,
        signal,
        budget,
        approvalContext,
      })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  if (['git_status', 'git_diff', 'run_project_check', 'git_commit', 'git_push', 'git_rollback'].includes(name)) {
    try {
      return await dispatchGitTool(name, args || {}, {
        userId: job?.userId || null,
        toolCallId,
        idempotencyKey,
      })
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }
  // ★ manage_todos: 无副作用的计划工具,把清单原样回执给模型,
  // 让它在后续轮次里看得到自己拆的步骤和完成进度。
  if (name === 'manage_todos') {
    const todos = Array.isArray(args?.todos) ? args.todos : []
    const normalized = todos
      .filter((t) => t && typeof t === 'object')
      .slice(0, 50)
      .map((t) => ({
        content: String(t.content || '').slice(0, 300),
        status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
        activeForm: String(t.activeForm || '').slice(0, 300),
      }))
    const done = normalized.filter((t) => t.status === 'completed').length
    return {
      ok: true,
      todos: normalized,
      summary: `共 ${normalized.length} 项,已完成 ${done} 项`,
    }
  }
  if (CONNECTOR_TOOL_NAMES.includes(name)) {
    return executeConnectorTool(name, args || {}, {
      userId: job?.userId || null,
      toolCallId,
      idempotencyKey,
    })
  }
  if (name.startsWith('browser_')) {
    try {
      const result = await executeBrowserTool(name, args || {}, {
        userId: job?.userId || null,
        toolCallId,
        idempotencyKey,
        signal,
      })
      return result && typeof result === 'object' ? { ok: true, ...result } : { ok: true, result }
    } catch (err) {
      return {
        ok: false,
        code: err?.code || (err?.name === 'AbortError' ? 'browser_cancelled' : 'browser_tool_failed'),
        cancelled: err?.name === 'AbortError',
        error: err?.message || String(err),
        retryable: err?.name !== 'AbortError',
      }
    }
  }
  if (name.startsWith('mcp__')) {
    try {
      const result = await callMcpTool({
        userId: job?.userId || null,
        fullToolName: name,
        args: args || {},
        toolCallId,
        idempotencyKey,
        signal,
      })
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        return { ok: !result.isError, ...result }
      }
      return { ok: true, result }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err
      return normalizeToolError(err, { fallbackCode: 'mcp_tool_failed' })
    }
  }
  return { ok: false, error: `unknown tool: ${name}` }
}

executeServerTool.supportsIdempotentResume = ({ name, idempotencyKey } = {}) => (
  Boolean(idempotencyKey) && CONNECTOR_WRITE_TOOL_NAMES.includes(name)
)

export function buildJobToolIdempotencyKey({ jobId, stepId, toolCallId }) {
  return `job:${String(jobId || 'unknown')}:step:${String(stepId || 'unknown')}:tool:${String(toolCallId || 'unknown')}`
}

function textToolCallScope(value) {
  return String(value || 'turn')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'turn'
}

/**
 * Local chat templates often restart their synthetic call ids at
 * `text-tool-1` for every model response. Scope only those compatibility ids
 * before checkpointing so later tool rounds cannot overwrite the first UI row
 * or reuse the same connector idempotency key. The scope is deterministic, so
 * a persisted turn remains stable across process restarts.
 */
export function scopeTextToolCallIds(rawCalls, { turnId, iteration = 0 } = {}) {
  if (!Array.isArray(rawCalls)) return []
  const scope = textToolCallScope(turnId)
  const round = Math.max(0, Math.floor(Number(iteration) || 0)) + 1
  return rawCalls.map((call, index) => {
    const id = String(call?.id || '')
    if (!/^text-tool-\d+$/i.test(id)) return call
    return {
      ...call,
      id: `text-tool-${scope}-i${round}-c${index + 1}`,
    }
  })
}

function supportsIdempotentResume(executor, callContext) {
  const capability = executor?.supportsIdempotentResume
  if (typeof capability === 'function') return capability(callContext) === true
  return capability === true
}

/**
 * Tools loop:给模型按产物意图裁剪后的工具集,多轮直到模型停止调用工具或达 maxIters。
 *
 * @param {object} opts
 * @param {object} opts.job        当前 job(含 userId)
 * @param {object} opts.step       当前 step
 * @param {Array}  opts.messages   初始 messages([{role,content}, ...])
 * @param {Function} opts.runModel  ({messages,tools,signal}) => Promise<{content, toolCalls}>
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxIters=MAX_ITERS]
 * @param {'standard'|'read_only_exploration'} [opts.executionGuardMode='standard']
 * @param {'auto'|'answer'|'execute'} [opts.intentMode='auto']
 * @returns {Promise<{text:string, artifactIds:string[], iterations:number}>}
 */
export async function runToolsLoop({
  job,
  step,
  messages,
  runModel,
  signal,
  maxIters = MAX_ITERS,
  executeTool = executeServerTool,
  onApprovalPending = null,
  onApprovalResolved = null,
  claimSteering = null,
  acknowledgeSteering = null,
  releaseSteering = null,
  beforeFinalCompletion = null,
  loadCheckpoint = null,
  saveCheckpoint = null,
  contextWindow = undefined,
  toolSpecs = undefined,
  fallbackToolSpecs = SERVER_TOOL_SPECS,
  skillId = undefined,
  approvalOrigin = 'job',
  approvalSessionId = null,
  approvalMode = null,
  runtimeBudget = null,
  approvalContext = null,
  requestToolApproval = requestApproval,
  enableToolHooks = true,
  onModelPhase = null,
  onModelDelta = null,
  onReasoningDelta = null,
  onProgress = null,
  onToolCall = null,
  onToolStarted = null,
  onToolCompleted = null,
  executionGuardMode = 'standard',
  intentMode = 'auto',
  toolRetryMaxAttempts = 3,
  toolRetryBaseDelayMs = 120,
}) {
  // 文件产物工具按本次任务意图裁剪。同一份 spec 既喂给模型,也用于 validateToolCall ——
  // 这样"模型看不到"和"调了也会被拒"是同一个事实,不会两边漂移。
  //
  // 意图文本取 job.prompt + 最后一条 user 消息:jobRuntime 走的是 job.prompt,
  // 但直接调 runToolsLoop(子任务、测试、未来的其他入口)只有 messages,
  // 只看 job.prompt 会把用户明写的「整理成 Word 文档」误判成无产物需求。
  // 不能扫描完整历史:旧轮次请求过 PPT 后,普通后续轮会永久携带 create_pptx
  // schema,既增加 token,也会诱导模型继续生成已经结束的产物。
  const currentUserMessage = (Array.isArray(messages) ? messages : [])
    .findLast((message) => message?.role === 'user' && typeof message.content === 'string')
  const intentText = [
    job?.prompt || '',
    currentUserMessage?.content || '',
  ].join('\n')
  const hasManagedAttachments = job?.hasManagedAttachments === true
    || (Array.isArray(job?.managedAttachments) && job.managedAttachments.length > 0)
    || MANAGED_ATTACHMENT_MARKER.test(intentText)
  const explicitSkillId = skillId
    || parseSkillIdFromPrompt(currentUserMessage?.content || '')
    || parseSkillIdFromPrompt(job?.prompt || '')
  const artifactAuthorizationText = String(
    job?.userPrompt || currentUserMessage?.content || job?.prompt || '',
  )
  const authorizedArtifactTools = allowedArtifactTools(artifactAuthorizationText, {
    skillId: explicitSkillId || skillId,
  })
  // Planning and verification consume an existing deliverable. They must not
  // manufacture another one merely because the original prompt names a format.
  const artifactDeliveryStep = !['plan', 'verify', 'finalize'].includes(String(step?.kind || ''))
  const stepArtifactTools = artifactDeliveryStep ? authorizedArtifactTools : new Set()
  const selectedToolSpecs = selectJobToolSpecs({
    prompt: intentText,
    userPrompt: artifactAuthorizationText,
    skillId: explicitSkillId || skillId,
    specs: Array.isArray(toolSpecs) ? toolSpecs : SERVER_TOOL_SPECS,
    origin: job?.origin,
    intentMode,
    userId: job?.userId || null,
  })
  const restored = typeof loadCheckpoint === 'function' ? await loadCheckpoint() : null
  const restoredState = restored?.state && typeof restored.state === 'object'
    ? restored.state
    : restored && typeof restored === 'object'
      ? restored
      : null
  const directoryAuthorizationResolution = restoredState?.directoryAuthorizationResolution
    && typeof restoredState.directoryAuthorizationResolution === 'object'
    ? restoredState.directoryAuthorizationResolution
    : null
  const skillArtifactTools = explicitSkillId
    ? allowedArtifactTools('', { skillId: explicitSkillId })
    : new Set()
  // A slash artifact skill is the delivery contract for this run. Keep the
  // completion guard on that one generator; content words such as "report"
  // must not silently add DOCX to a /webpage job. Without an artifact skill,
  // explicit multi-file requests still require every requested generator.
  const requestedArtifactTools = skillArtifactTools.size > 0
    ? skillArtifactTools
    : authorizedArtifactTools
  const selectedToolNames = new Set(selectedToolSpecs.map((spec) => spec?.function?.name).filter(Boolean))
  const expectedArtifactTools = new Set(
    [...requestedArtifactTools].filter((name) => selectedToolNames.has(name)),
  )
  // Verify/finalize/plan steps inherit the original job prompt, so they still
  // mention the requested format. Their job is to inspect or summarize the
  // artifact already produced by execute/batch_item, not manufacture a second
  // copy. Chat and delivery steps keep the strict persisted-file contract.
  const requiresPersistedArtifact = expectedArtifactTools.size > 0 && artifactDeliveryStep
  // A standalone Gugo artifact is written to the managed artifact store. It
  // never needs access to an arbitrary user folder. Hiding request_directory
  // here prevents a model from pausing /webpage or Office generation for an
  // unrelated filesystem permission. Explicit local-path delivery still keeps
  // the directory request tool available.
  let activeToolSpecs = restoreDirectoryAuthorizationToolSpecs(
    selectedToolSpecs.filter((spec) => {
      const name = spec?.function?.name
      return !isFileArtifactTool(name) || stepArtifactTools.has(name)
    }),
    directoryAuthorizationResolution,
    fallbackToolSpecs,
  )
  if (requiresPersistedArtifact && !EXPLICIT_LOCAL_DIRECTORY_CONTEXT.test(intentText)) {
    activeToolSpecs = activeToolSpecs.filter((spec) => spec?.function?.name !== 'request_directory')
  }
  if (hasManagedAttachments) {
    // Managed attachments never need a local-directory grant. Keep explicitly
    // configured connector/browser tools available, though: the user may
    // legitimately ask to compare an attachment with Drive or a web page.
    activeToolSpecs = activeToolSpecs.filter((spec) => spec?.function?.name !== 'request_directory')
  }
  // Job 的 verify/finalize 步骤会自行生成一条 user 消息，其中天然包含
  // “运行测试、修正、验证”等动作词。完成门禁必须判断用户的原始目标，
  // 不能把内核自己写出的验证提示再次识别成一项新的执行请求。
  // Chat `job.prompt` contains runtime-generated local-access instructions.
  // They mention write/create/modify even when the user's actual follow-up is
  // verification-only, so prefer the raw user prompt as intent evidence.
  const generatedWorkflowStep = ['plan', 'verify', 'finalize']
    .includes(String(step?.kind || ''))
  const executionIntentText = String(
    job?.userPrompt
      || (generatedWorkflowStep ? job?.prompt : currentUserMessage?.content)
      || job?.prompt
      || '',
  )
  // Planning explorers inspect the same user prompt as the later executor. A
  // request such as "fix the project" therefore still contains mutation
  // intent, but the explorer is deliberately read-only and should be allowed
  // to finish with findings after its reads. Keep the opt-out explicit at the
  // trusted planning call site; every other caller remains fail-closed on the
  // standard execution/evidence contract.
  const enforceExecutionIntent = executionGuardMode !== 'read_only_exploration'
  const directExecutionRequested = enforceExecutionIntent && shouldRequireExecution({
    intentMode,
    text: executionIntentText,
  })
  const mutationExecutionRequested = requiresPersistedArtifact
    || (directExecutionRequested && hasMutationExecutionIntent(executionIntentText))
  const executionConvergenceEnabled = enforceExecutionIntent && mutationExecutionRequested
  let requiresPdfLayoutVerification = mutationExecutionRequested
    && shouldRequirePdfLayoutVerification(executionIntentText)
    && activeToolSpecs.some((spec) => toolNameFromSpec(spec) === 'bash_exec')
  // Explicit execution is a contract, not a hint. Keep this requirement even
  // when routing produced no usable tool; otherwise prose such as "done" would
  // be accepted precisely when the harness cannot perform the requested work.
  const requiresExecutionEvidence = directExecutionRequested
  let availableVerificationToolNames = activeToolSpecs
    .map(toolNameFromSpec)
    .filter((name) => VERIFICATION_TOOLS.has(name) || name === 'bash_exec')
  const representativeReadCalls = buildRepresentativeReadCalls(job?.prompt, job?.id)
  const requiresRepresentativeRead = job?.origin === 'chat'
    && DIRECTORY_REVIEW_INTENT.test(String(job?.userPrompt || ''))
    && activeToolSpecs.some((spec) => spec?.function?.name === 'read_file')
    && representativeReadCalls.length > 0
  const recoverySessionId = job?.origin === 'chat' && job?.sessionId
    ? String(job.sessionId)
    : job?.id && step?.id
      ? `job:${job.id}:${step.id}`
      : null
  // Automatic tool rounds must never wait for extra map/reduce model calls
  // merely to prepare their next request. Explicit compaction can still request
  // a semantic summary; automatic recovery uses the deterministic archive.
  const semanticSummary = false
  let convo = ensureSafetySystemMessages(
    Array.isArray(restoredState?.messages) ? [...restoredState.messages] : [...messages],
  )
  convo = replaceRuntimeCapabilityBlock(convo, {
    toolSpecs: activeToolSpecs,
    approvalMode,
  })
  const hasRuntimeMarker = (marker) => convo.some((message) => (
    message?.role === 'system' && String(message?.content || '').includes(marker)
  ))
  let representativeReadsInjected = Boolean(restoredState?.completionGuards?.representativeReadsInjected)
    || convo.some((message) => message?.role === 'system' && String(message?.content || '').includes(DIRECTORY_REVIEW_GUARD_MARKER))
  let hasSuccessfulRepresentativeRead = successfulReadFileInMessages(convo)
  const artifactIds = Array.isArray(restoredState?.artifactIds) ? [...restoredState.artifactIds] : []
  let artifactDeliveryRetries = Math.max(0, Number(restoredState?.completionGuards?.artifactDeliveryRetries) || 0)
  const deliveredArtifactTools = new Set(
    Array.isArray(restoredState?.completionGuards?.deliveredArtifactTools)
      ? restoredState.completionGuards.deliveredArtifactTools.filter((name) => expectedArtifactTools.has(name))
      : [],
  )
  const inheritedArtifactEvidence = ['verify', 'finalize'].includes(String(step?.kind || ''))
    && Array.isArray(job?.steps)
    && job.steps.some((priorStep) => (
      priorStep?.id !== step?.id
      && priorStep?.status === 'completed'
      && Array.isArray(priorStep?.output?.artifactIds)
      && priorStep.output.artifactIds.length > 0
    ))
  let executionEvidenceObserved = Boolean(restoredState?.completionGuards?.executionEvidenceObserved)
    || deliveredArtifactTools.size > 0
    || inheritedArtifactEvidence
  let mutationExecutionObserved = Boolean(restoredState?.completionGuards?.mutationExecutionObserved)
    || deliveredArtifactTools.size > 0
    || inheritedArtifactEvidence
  let executionEvidenceRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.executionEvidenceRetries) || 0,
  )
  let executionReasoningRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.executionReasoningRetries) || 0,
  )
  let directoryResumeRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.directoryResumeRetries) || 0,
  )
  const hasVerifiedDirectoryResolution = directoryAuthorizationResolution?.type === 'directory_authorization'
    && directoryAuthorizationResolution?.approved === true
    || convo.some((message) => (
      message?.role === 'system'
        && VERIFIED_DIRECTORY_RESOLUTION.test(String(message?.content || ''))
    ))
  const restoredMutationTargets = Array.isArray(restoredState?.completionGuards?.pendingMutationTargets)
    ? restoredState.completionGuards.pendingMutationTargets
    : restoredState?.completionGuards?.pendingMutationVerification
      ? [PROJECT_SCOPE_TARGET]
      : []
  const pendingMutationTargets = new Set(
    restoredMutationTargets.map(normalizeMutationTarget).filter(Boolean),
  )
  const pendingDeletionTargets = new Set(
    (Array.isArray(restoredState?.completionGuards?.pendingDeletionTargets)
      ? restoredState.completionGuards.pendingDeletionTargets
      : [])
      .map(normalizeMutationTarget)
      .filter(Boolean),
  )
  const hasPendingMutationVerification = () => (
    pendingMutationTargets.size > 0 || pendingDeletionTargets.size > 0
  )
  let mutationVerificationRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.mutationVerificationRetries) || 0,
  )
  let pdfLayoutVerificationObserved = Boolean(
    restoredState?.completionGuards?.pdfLayoutVerificationObserved,
  )
  let pdfLayoutVerificationRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.pdfLayoutVerificationRetries) || 0,
  )
  let executionConvergence = restoreExecutionConvergence(
    restoredState?.completionGuards?.executionConvergence,
  )
  if (hasManagedAttachments && !hasRuntimeMarker('[MANAGED ATTACHMENT EXECUTION CONTRACT]')) {
    const attachmentUris = (Array.isArray(job?.managedAttachments) ? job.managedAttachments : [])
      .map((item) => String(item?.uri || '').trim())
      .filter(Boolean)
      .slice(0, 16)
    convo.push({
      role: 'system',
      content: [
        '[MANAGED ATTACHMENT EXECUTION CONTRACT]',
        'The attached files are already uploaded into Gugo-managed storage and require no directory permission or cloud connector.',
        attachmentUris.length ? `Use read_file with these exact URIs when file contents are needed: ${attachmentUris.join(', ')}.` : 'Use the attachment:// URI shown in the user message with read_file when file contents are needed.',
        'Do not search Dropbox, Google Drive, OneDrive, or browser apps to locate these files. Prefer the supplied extracted PDF/text content when it is already present.',
      ].join(' '),
    })
  }
  if ((directExecutionRequested || requiresPersistedArtifact)
    && !hasRuntimeMarker(AVAILABLE_TOOL_CAPABILITIES_MARKER)) {
    const activeToolNames = activeToolSpecs.map(toolNameFromSpec).filter(Boolean)
    const capabilityNotes = []
    if (activeToolNames.includes('bash_exec')) {
      capabilityNotes.push('bash_exec can run commands and installed Python/Node scripts in an authorized workspace or local directory')
    }
    if (process.platform === 'win32'
      && activeToolNames.includes('bash_exec')
      && activeToolNames.includes('write_file')) {
      capabilityNotes.push('on Windows, bash_exec uses cmd.exe; for multiline or long Python such as PDF/image generation, write a UTF-8 .py file with write_file and then run that file instead of embedding the program in python -c, and do not use Unix-only tail/grep/sed/awk pipelines')
    }
    const writableTools = activeToolNames.filter((name) => FILE_WRITE_TOOL_NAMES.has(name))
    if (writableTools.length > 0) {
      capabilityNotes.push(`${writableTools.join('/')} can create or modify authorized files`)
    }
    const artifactTools = activeToolNames.filter((name) => isFileArtifactTool(name))
    if (artifactTools.length > 0) {
      capabilityNotes.push(`${artifactTools.join('/')} can create persisted downloadable artifacts`)
    }
    convo.push({
      role: 'system',
      content: [
        AVAILABLE_TOOL_CAPABILITIES_MARKER,
        `The callable tools for this turn are: ${activeToolNames.join(', ') || '(none)'}.`,
        capabilityNotes.length > 0 ? `${capabilityNotes.join('; ')}.` : '',
        'Treat this runtime-provided list as authoritative. A malformed argument or one failed tool call does not mean that the tool is unavailable.',
        'Do not call request_clarification merely to claim that a listed capability is missing; correct the arguments or use another listed tool and continue.',
      ].filter(Boolean).join(' '),
    })
  }
  if ((directExecutionRequested || requiresPersistedArtifact)
    && !hasRuntimeMarker('[DIRECT EXECUTION REQUIRED]')) {
    convo.push({
      role: 'system',
      content: [
        '[DIRECT EXECUTION REQUIRED]',
        'The user asked for concrete work, not instructions for doing it later.',
        'Use the available tools now, follow the supplied steps, create or modify the requested deliverable, and verify the result before answering.',
        'Do not merely print a script or tell the user to run commands unless execution is genuinely blocked by a missing permission or indispensable user input.',
        'Keep internal deliberation brief; report the completed result or one concise, specific blocker.',
      ].join(' '),
    })
  }
  if (requiresPdfLayoutVerification
    && !hasRuntimeMarker(PDF_LAYOUT_EXECUTION_CONTRACT_MARKER)) {
    convo.push({
      role: 'system',
      content: buildPdfLayoutExecutionContract(executionIntentText),
    })
  }
  const missingArtifactTools = () => [...expectedArtifactTools].filter((name) => !deliveredArtifactTools.has(name))
  const hasRequiredArtifacts = () => !requiresPersistedArtifact || missingArtifactTools().length === 0
  const hasRequiredExecutionEvidence = () => !requiresExecutionEvidence
    || (mutationExecutionRequested ? mutationExecutionObserved : executionEvidenceObserved)
  const assertRequiredArtifacts = () => {
    if (!requiresPersistedArtifact) return
    const missing = missingArtifactTools()
    if (missing.length > 0) throw artifactDeliveryError(missing)
  }
  let recovery = restoredState?.recovery?.archiveId
    ? { archiveId: String(restoredState.recovery.archiveId) }
    : null
  const appliedSteeringIds = new Set(
    Array.isArray(restoredState?.appliedSteeringIds)
      ? restoredState.appliedSteeringIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [],
  )
  let finalText = ''
  let finalCheckpointPersisted = false
  let iter = Math.max(0, Number(restoredState?.iterations) || 0)
  let modelBudgetExceededAfterResponse = null
  let checkpointCalls = Array.isArray(restoredState?.toolCalls)
    ? restoredState.toolCalls.map((call) => ({
        ...call,
        idempotencyKey: call.idempotencyKey || buildJobToolIdempotencyKey({
          jobId: job?.id,
          stepId: step?.id,
          toolCallId: call.id,
        }),
      }))
    : null
  const progressState = restoreToolProgress(restoredState?.progress)
  observeToolCalls(progressState, checkpointCalls)
  for (const call of checkpointCalls || []) {
    if (call?.checkpointStatus !== 'completed') continue
    const result = normalizeToolResult(call.checkpointResult)
    const progressChanges = progressChangesFor(call, result)
    recordToolProgress(progressState, {
      call,
      succeeded: isSuccessfulToolResult(result),
      ...progressChanges,
    })
  }
  let failureRecovery = restoreFailureRecovery(restoredState?.failureRecovery)
  let pendingFailureRecoveryPrompt = failureRecovery.count >= FAILURE_RECOVERY_THRESHOLD
    && !failureRecovery.reflected

  const emitToolProgress = async (phase, iteration = iter + 1) => {
    if (typeof onProgress !== 'function') return
    await onProgress(toolProgressPayload(progressState, { iteration, phase }))
  }

  // An interrupted final is durable UI evidence, not a completed model turn.
  // Explicit resume must continue from the checkpointed tool results instead
  // of replaying the interruption text as if it were the final answer.
  const restoredFinalIsInterrupted = restoredState?.final?.interrupted === true
  const restoredFinalIsTerminal = Boolean(
    restoredState?.final?.incomplete
    || restoredState?.final?.paused
    || restoredState?.final?.budgetExceeded
    || restoredState?.final?.noProgress,
  )
  if (restoredState?.final?.text != null
    && String(restoredState.final.text).trim()
    && !restoredFinalIsInterrupted
    && (restoredFinalIsTerminal || (
       hasRequiredArtifacts()
       && hasRequiredExecutionEvidence()
       && !hasPendingMutationVerification()
       && (!requiresPdfLayoutVerification || pdfLayoutVerificationObserved)
    ))) {
    return {
      ...restoredState.final,
      text: String(restoredState.final.text),
      artifactIds,
      iterations: Math.max(1, Number(restoredState.final.iterations) || iter || 1),
      resumed: true,
      recovery,
    }
  }

  let injectRepresentativeReadsBeforeModel = requiresRepresentativeRead
    && !hasSuccessfulRepresentativeRead
    && !representativeReadsInjected
    && !checkpointCalls?.length

  const persistTurn = async ({ final = null } = {}) => {
    if (typeof saveCheckpoint !== 'function') return
    const saved = await saveCheckpoint({
      messages: convo,
      toolCalls: checkpointCalls || [],
      artifactIds,
      appliedSteeringIds: [...appliedSteeringIds],
      iterations: iter,
      budget: budget.snapshot?.() || null,
      recovery,
      progress: serializeToolProgress(progressState),
      failureRecovery: serializeFailureRecovery(failureRecovery),
      ...(directoryAuthorizationResolution ? { directoryAuthorizationResolution } : {}),
      completionGuards: {
        representativeReadsInjected,
        artifactDeliveryRetries,
        deliveredArtifactTools: [...deliveredArtifactTools],
        executionEvidenceObserved,
        mutationExecutionObserved,
        executionEvidenceRetries,
        executionReasoningRetries,
        directoryResumeRetries,
        pendingMutationVerification: hasPendingMutationVerification(),
        pendingMutationTargets: [...pendingMutationTargets],
        pendingDeletionTargets: [...pendingDeletionTargets],
        mutationVerificationRetries,
        pdfLayoutVerificationObserved,
        pdfLayoutVerificationRetries,
        executionConvergence: serializeExecutionConvergence(executionConvergence),
      },
      final,
    })
    if (saved === false || saved === null) throw new Error('Failed to persist job turn checkpoint')
  }
  const completionGateAllowsFinish = async (details) => {
    if (typeof beforeFinalCompletion !== 'function') return true
    const result = await beforeFinalCompletion(details)
    return typeof result === 'boolean' ? result : result?.closed !== false
  }
  const prepareCompletionForSteering = async ({
    text = '',
    steeringLeaseId = null,
    incomplete = false,
    reason = null,
  } = {}) => {
    if (typeof beforeFinalCompletion !== 'function') {
      return { closed: true, prepared: false }
    }
    try {
      if (steeringLeaseId) {
        if (text) convo.push({ role: 'assistant', content: text })
        // The checkpoint is the durable proof that every claimed steering id
        // was applied to this candidate result. ACK only after that proof
        // exists; then atomically close the inbox.
        await persistTurn()
        if (typeof acknowledgeSteering === 'function') {
          await acknowledgeSteering(steeringLeaseId)
        }
      }
      const closed = await completionGateAllowsFinish({ text, incomplete, reason })
      if (!closed) {
        // With no claimed lease there is nothing to ACK, so avoid an extra
        // checkpoint on the overwhelmingly common uncontended completion.
        // Persist the discarded candidate only when a racing update actually
        // kept the inbox open; the next model round can then see that context.
        if (!steeringLeaseId) {
          if (text) convo.push({ role: 'assistant', content: text })
          await persistTurn()
        }
        if (iter + 1 >= maxIters) maxIters = iter + 2
      }
      return { closed, prepared: Boolean(steeringLeaseId) || !closed }
    } catch (error) {
      if (steeringLeaseId && typeof releaseSteering === 'function') {
        await releaseSteering(steeringLeaseId)
      }
      throw error
    }
  }
  const finishIncomplete = async ({ text, reason, steeringLeaseId = null }) => {
    finalText = text
    const completion = await prepareCompletionForSteering({
      text: finalText,
      steeringLeaseId,
      incomplete: true,
      reason,
    })
    if (!completion.closed) return { deferredForSteering: true }
    if (!completion.prepared) convo.push({ role: 'assistant', content: finalText })
    try {
      await persistTurn({
        final: {
          text: finalText,
          iterations: iter + 1,
          incomplete: true,
          reason,
        },
      })
      finalCheckpointPersisted = true
      if (!completion.prepared && steeringLeaseId && typeof acknowledgeSteering === 'function') {
        await acknowledgeSteering(steeringLeaseId)
      }
    } catch (error) {
      if (steeringLeaseId && typeof releaseSteering === 'function') {
        await releaseSteering(steeringLeaseId)
      }
      throw error
    }
    return {
      text: finalText,
      artifactIds,
      iterations: iter + 1,
      incomplete: true,
      reason,
      recovery,
    }
  }
  const finishTerminalResult = async (result, {
    steeringLeaseId = null,
    finalMetadata = {},
    appendTextToConversation = true,
  } = {}) => {
    const text = String(result?.text || '')
    const completion = await prepareCompletionForSteering({
      text,
      steeringLeaseId,
      incomplete: result?.incomplete === true,
      reason: result?.reason || null,
    })
    if (!completion.closed) return null
    if (!completion.prepared && text && appendTextToConversation) {
      convo.push({ role: 'assistant', content: text })
    }
    await persistTurn({
      final: {
        text,
        iterations: Math.max(1, Number(result?.iterations) || iter + 1),
        incomplete: result?.incomplete === true,
        reason: result?.reason || null,
        ...finalMetadata,
      },
    })
    finalCheckpointPersisted = Boolean(text.trim())
    return result
  }
  // ★ M3.5 + Lens-2 fix:任务级预算用 WeakMap 持有,模型/工具碰不到 job 的属性也无法绕过。
  const restoredBudget = restoredState?.budget && typeof restoredState.budget === 'object'
    ? {
        maxTotalCalls: restoredState.budget.maxTotalCalls,
        maxWallMs: restoredState.budget.maxWallMs,
        maxModelCalls: restoredState.budget.maxModelCalls,
        maxModelTokens: restoredState.budget.maxModelTokens,
        maxCostUsd: restoredState.budget.maxCostUsd,
        initialUsed: restoredState.budget.used,
        initialElapsedMs: restoredState.budget.elapsed,
        initialModelMs: restoredState.budget.modelMs,
        initialModelCalls: restoredState.budget.modelCalls,
        initialModelTokens: restoredState.budget.modelTokens,
        initialCostUsd: restoredState.budget.costUsd,
      }
    : undefined
  const budget = runtimeBudget || (job
    ? (getJobBudget(job) || attachJobBudget(job, restoredBudget))
    : createJobBudget(restoredBudget))
  const subagentApprovalContext = approvalContext || createSubagentApprovalContext()
  // 预算测试/小预算任务应优先报告 budgetExceeded；第 5 次相同调用再判无进展。
  // Two identical calls leave room for a transient retry. The third is a loop
  // and must be rejected before execution instead of spending more budget.
  const loopGuard = createToolLoopGuard({ maxRepeatedCalls: 2 })
  const rememberInstallAttempt = (signature) => {
    if (!signature) return
    executionConvergence.installAttempts = executionConvergence.installAttempts
      .filter((item) => item !== signature)
    executionConvergence.installAttempts.push(signature)
    executionConvergence.installAttempts = executionConvergence.installAttempts
      .slice(-MAX_INSTALL_ATTEMPT_SIGNATURES)
  }
  const convergenceBlockFor = (call) => {
    if (!executionConvergenceEnabled || !executionConvergence.interventionActive) return null
    if (isProbeLikeCall(call)) {
      return {
        ok: false,
        code: 'execution_convergence_probe_blocked',
        error: 'The call was blocked because this execution task already spent several rounds on environment or inspection probes without producing the requested output.',
        retryable: false,
        blockedKind: 'probe',
        hint: 'Stop creating or running inspection scripts. Execute the requested mutation or artifact generation now, then verify its actual output.',
      }
    }
    const installSignature = installAttemptSignature(call)
    if (installSignature && executionConvergence.installAttempts.includes(installSignature)) {
      return {
        ok: false,
        code: 'execution_convergence_install_blocked',
        error: `The repeated dependency installation (${installSignature}) was blocked after the task failed to converge.`,
        retryable: false,
        blockedKind: 'repeated_install',
        hint: 'Use the dependency state already observed and execute the requested output-producing command. Only report a blocker when a concrete execution error proves the dependency is unusable.',
      }
    }
    return null
  }

  for (; iter < maxIters; iter += 1) {
    if (signal?.aborted) {
      const error = new Error('Turn cancelled')
      error.name = 'AbortError'
      throw error
    }
    let steeringLeaseId = null
    let toolCalls

    if (injectRepresentativeReadsBeforeModel) {
      representativeReadsInjected = true
      injectRepresentativeReadsBeforeModel = false
      convo.push({
        role: 'system',
        content: [
          DIRECTORY_REVIEW_GUARD_MARKER,
          'A directory listing is discovery evidence only.',
          'The runtime is reading representative documentation, configuration, and entrypoint files through the authorized read_file tool before the first model call.',
          'Base the answer on the returned file contents and report any concrete read errors truthfully.',
        ].join(' '),
      })
      checkpointCalls = normalizeToolCalls(representativeReadCalls, {
        toolSpecs: activeToolSpecs,
      }).map((call) => ({
        ...call,
        idempotencyKey: buildJobToolIdempotencyKey({
          jobId: job?.id,
          stepId: step?.id,
          toolCallId: call.id,
        }),
        checkpointStatus: 'pending',
        checkpointApprovalId: null,
      }))
      observeToolCalls(progressState, checkpointCalls)
      if (typeof onToolCall === 'function') {
        for (const call of checkpointCalls) await onToolCall(call)
      }
      await emitToolProgress('tools_scheduled')
      convo.push(buildAssistantToolCallsMessage(checkpointCalls, ''))
      await persistTurn()
    }

    if (checkpointCalls?.length) {
      // The model response was already made durable before the previous process
      // stopped. Resume its unanswered calls without asking the model again.
      toolCalls = checkpointCalls
    } else {
      if (typeof claimSteering === 'function') {
        const claimed = await claimSteering()
        if (claimed?.messages?.length) {
          steeringLeaseId = claimed.leaseId
          if (!hasRuntimeMarker(LIVE_STEERING_GUARD_MARKER)) {
            convo.push({
              role: 'system',
              content: `${LIVE_STEERING_GUARD_MARKER} The user sent steering updates while this task was running. Apply them now; newer user direction takes precedence.`,
            })
          }
          for (const steering of claimed.messages) {
            // Preserve the user text verbatim. Do not summarize steering before the model sees it.
            if (steering?.id) appliedSteeringIds.add(String(steering.id))
            convo.push({ role: 'user', content: steering.content })
          }
        }
      }

      let modelResult
      try {
        if (typeof onModelPhase === 'function') await onModelPhase({ phase: 'started', iteration: iter })
        let streamedText = false
        const request = await callModelWithContextRecovery({
          messages: convo,
          tools: activeToolSpecs,
          callModel: (modelRequest) => runWithModelBudget(
            budget,
            () => runModel(modelRequest),
          ),
          isContextLengthError,
          contextWindow,
          semanticSummary,
          signal,
          userId: job?.userId || null,
          sessionId: recoverySessionId,
          consumeBudget: (cost) => budget.consume(cost),
          onTextDelta: async (text, metadata = {}) => {
            if (!text) return
            // Do not leak a model's "copy this code into a file" fallback into
            // the chat while a real file artifact is still required. The final
            // narration streams normally after the generator succeeds.
            if (!hasRequiredArtifacts()) return
            streamedText = true
            if (typeof onModelDelta === 'function') {
              await onModelDelta({ text, iteration: iter, modelName: metadata.modelName || null })
            }
          },
          onReasoningDelta: async (text, metadata = {}) => {
            if (!text || typeof onReasoningDelta !== 'function') return
            await onReasoningDelta({ text, iteration: iter, modelName: metadata.modelName || null })
          },
        })
        convo.splice(0, convo.length, ...request.messages)
        if (request.recovery?.archiveId) {
          recovery = { archiveId: String(request.recovery.archiveId) }
        }
        modelResult = request.response
        if (!Array.isArray(modelResult?.toolCalls) || modelResult.toolCalls.length === 0) {
          const compatibilityCall = extractTextToolCalls(modelResult?.content)
          if (compatibilityCall.detected) {
            modelResult = {
              ...modelResult,
              content: compatibilityCall.content,
              toolCalls: compatibilityCall.toolCalls,
            }
          }
        }
        const returnedToolCalls = Array.isArray(modelResult?.toolCalls) ? modelResult.toolCalls : []
        if (requiresRepresentativeRead
          && !hasSuccessfulRepresentativeRead
          && !representativeReadsInjected
          && returnedToolCalls.length === 0
          && iter + 1 < maxIters) {
          representativeReadsInjected = true
          convo.push({
            role: 'system',
            content: [
              DIRECTORY_REVIEW_GUARD_MARKER,
              'The previous answer tried to finish from a directory listing alone, so it was discarded.',
              'The runtime is now reading representative documentation, configuration, and entrypoint files through the authorized read_file tool.',
              'Base the next answer on the returned file contents and report any concrete read errors truthfully.',
            ].join(' '),
          })
          modelResult = { ...modelResult, content: '', toolCalls: representativeReadCalls }
        }
        if (typeof onModelPhase === 'function') await onModelPhase({
          phase: 'completed',
          iteration: iter,
          content: modelResult?.content || '',
          toolCalls: modelResult?.toolCalls || [],
          usage: modelResult?.usage || null,
          modelName: modelResult?.modelName || null,
        })
        if (!streamedText
          && modelResult?.content
          && hasRequiredArtifacts()
          && typeof onModelDelta === 'function') {
          await onModelDelta({
            text: modelResult.content,
            iteration: iter,
            modelName: modelResult?.modelName || null,
          })
        }
      } catch (error) {
        let recoverableModelResult = error?.partialModelResult
        if (recoverableModelResult
          && (!Array.isArray(recoverableModelResult.toolCalls) || recoverableModelResult.toolCalls.length === 0)) {
          const compatibilityCall = extractTextToolCalls(recoverableModelResult.content)
          if (compatibilityCall.detected) {
            recoverableModelResult = {
              ...recoverableModelResult,
              content: compatibilityCall.content,
              toolCalls: compatibilityCall.toolCalls,
            }
          }
        }
        const recoverableToolCalls = Array.isArray(recoverableModelResult?.toolCalls)
          ? recoverableModelResult.toolCalls
          : []
        const canRecoverExecutionReasoning = error?.code === 'REASONING_RUNAWAY'
          && directExecutionRequested
          && activeToolSpecs.length > 0
          && executionReasoningRetries < MAX_EXECUTION_REASONING_RETRIES
          && iter + 1 < maxIters
        if (canRecoverExecutionReasoning) {
          executionReasoningRetries += 1
          convo.push({
            role: 'system',
            content: [
              EXECUTION_REASONING_RECOVERY_MARKER,
              'The previous response spent too long reasoning without submitting a tool call and was cancelled.',
              'Do not recompute the plan, layout, or environment and do not narrate another intention to act.',
              `Begin the next response with one substantive available tool call. Preferred execution tools: ${activeToolSpecs.map(toolNameFromSpec).filter(Boolean).join(', ')}.`,
              'Keep private reasoning brief, execute the requested mutation now, and verify concrete output afterward.',
            ].join(' '),
          })
          if (typeof onModelPhase === 'function') await onModelPhase({
            phase: 'retrying',
            iteration: iter,
            error: error?.message || String(error),
            reason: 'reasoning_runaway',
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (error?.code === 'MODEL_BUDGET_EXCEEDED' && recoverableToolCalls.length > 0) {
          // The provider request and its cost have already happened. Discarding
          // an actionable tool call here wastes that work and can stop one step
          // before the requested artifact is produced. Execute this final
          // response; the exhausted budget will still reject the next model
          // request before it reaches the provider.
          modelResult = recoverableModelResult
          modelBudgetExceededAfterResponse = error?.message || 'model budget exceeded'
          if (typeof onModelPhase === 'function') await onModelPhase({
            phase: 'completed',
            iteration: iter,
            content: modelResult?.content || '',
            toolCalls: modelResult?.toolCalls || [],
            usage: modelResult?.usage || null,
            modelName: modelResult?.modelName || null,
            budgetExceeded: true,
            budgetReason: error?.message || String(error),
          })
        } else {
          if (typeof onModelPhase === 'function') await onModelPhase({
            phase: 'failed', iteration: iter, error: error?.message || String(error),
          })
        // ★ 模型报错不再无条件炸掉整个 step。
        //
        // 原来这里直接 throw,一路冒到 runOneTick 把 job 标 failed,
        // **这一步已经收集到的所有工具结果全部丢弃**,checkpoint 也被删掉。
        // 于是 LM Studio 在第 30 轮打了个嗝,前 29 轮的活白干。
        //
        // subagentRuntime.js 早就做对了(见那里的降级注释),job 循环一直没跟上。
        // 现在对齐:已经跑过至少一轮 + 不是用户主动取消 → 降级成部分结果,
        // 把中断原因和已查到的东西交给用户,而不是一个空的 failed。
        if (error?.code === 'MODEL_BUDGET_EXCEEDED') {
          const collected = convo
            .filter((m) => m.role === 'tool')
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
            .filter(Boolean)
            .join('\n')
            .slice(0, 4000)
          let wrapUpText = ''
          try {
            const wrapUpRequest = await callModelWithContextRecovery({
              messages: [
                ...convo,
                {
                  role: 'system',
                  content: `模型预算已用尽(${error.message})。请基于目前已有的信息给出最终回答，不要再调用任何工具。`,
                },
              ],
              tools: [],
              callModel: (modelRequest) => runWithModelBudget(
                budget,
                () => runModel(modelRequest),
                { allowOverBudget: true },
              ),
              isContextLengthError,
              contextWindow,
              semanticSummary,
              signal,
              userId: job?.userId || null,
              sessionId: recoverySessionId,
              toolChoice: 'none',
            })
            if (wrapUpRequest.recovery?.archiveId) {
              recovery = { archiveId: String(wrapUpRequest.recovery.archiveId) }
            }
            wrapUpText = wrapUpRequest.response?.content || ''
          } catch (wrapUpError) {
            if (wrapUpError?.name === 'AbortError') throw wrapUpError
          }
          assertRequiredArtifacts()
          const terminal = await finishTerminalResult({
            text: wrapUpText || `(模型预算已用尽:${error.message})\n\n已经完成的部分:\n${collected || error.partialModelResult?.content || '(无)'}`,
            artifactIds,
            iterations: iter + 1,
            incomplete: true,
            budgetExceeded: true,
            reason: error.message,
            recovery,
          }, { steeringLeaseId, finalMetadata: { budgetExceeded: true } })
          if (!terminal) continue
          return terminal
        }
        if (steeringLeaseId) {
          if (typeof releaseSteering === 'function') await releaseSteering(steeringLeaseId)
          steeringLeaseId = null
        }
        if (error?.name === 'AbortError' || iter === 0) throw error

        const collected = convo
          .filter((m) => m.role === 'tool')
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .filter(Boolean)
          .join('\n')
          .slice(0, 4000)

        assertRequiredArtifacts()
        const terminal = await finishTerminalResult({
          text: `(任务中断:${error?.message || String(error)})\n\n已经完成的部分:\n${collected || '(无)'}`,
          artifactIds,
          iterations: iter + 1,
          interrupted: true,
          code: error?.code || 'MODEL_CALL_INTERRUPTED',
          reason: error?.message || String(error),
          recovery,
        }, {
          steeringLeaseId,
          appendTextToConversation: false,
          finalMetadata: {
            interrupted: true,
            code: error?.code || 'MODEL_CALL_INTERRUPTED',
          },
        })
        if (!terminal) continue
          return terminal
        }
      }
      const { content, toolCalls: rawToolCalls } = modelResult

      if (!rawToolCalls || rawToolCalls.length === 0) {
        if (hasVerifiedDirectoryResolution && DIRECTORY_AUTHORIZATION_WAIT_CLAIM.test(String(content || ''))) {
          const canRetry = directoryResumeRetries < MAX_DIRECTORY_RESUME_RETRIES
            && iter + 1 < maxIters
          if (!canRetry) {
            const incomplete = await finishIncomplete({
              text: '\u76ee\u5f55\u6743\u9650\u5df2\u6388\u4e88\uff0c\u4f46\u6a21\u578b\u5728\u6062\u590d\u540e\u4ecd\u91cd\u590d\u8bf7\u6c42\u540c\u4e00\u6388\u6743\uff0c\u4e14\u672a\u6267\u884c\u539f\u4efb\u52a1\u3002\u672c\u8f6e\u6ca1\u6709\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002',
              reason: 'directory_resume_not_converged',
              steeringLeaseId,
            })
            if (incomplete.deferredForSteering) continue
            return incomplete
          }
          directoryResumeRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              DIRECTORY_RESUME_GUARD_MARKER,
              'The requested directory grant is already verified in this checkpoint; there is no pending directory picker or authorization action.',
              'Do not ask the user to authorize, choose, or confirm that directory again.',
              'Continue the original task now with the available execution tools and obtain concrete execution and verification results before answering.',
            ].join(' '),
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (!hasRequiredArtifacts()) {
          const canRetry = artifactDeliveryRetries < MAX_ARTIFACT_DELIVERY_RETRIES && iter + 1 < maxIters
          const missing = missingArtifactTools()
          if (!canRetry) throw artifactDeliveryError(missing)
          artifactDeliveryRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              ARTIFACT_DELIVERY_GUARD_MARKER,
              'The user requested a real downloadable file, but the previous response did not create one.',
              `Call each missing artifact generator now: ${missing.join(', ')}.`,
              'Do not ask for a directory, do not print source code as the deliverable, and do not claim completion until the tool returns artifactId.',
            ].join(' '),
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (!hasRequiredExecutionEvidence()) {
          const canRetry = executionEvidenceRetries < MAX_EXECUTION_EVIDENCE_RETRIES
            && iter + 1 < maxIters
          if (!canRetry) {
            const incomplete = await finishIncomplete({
              text: '任务尚未完成：模型没有调用任何可用工具取得实际执行结果。请重试，或切换到支持工具调用的模型。',
              reason: 'execution_evidence_missing',
              steeringLeaseId,
            })
            if (incomplete.deferredForSteering) continue
            return incomplete
          }
          executionEvidenceRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              EXECUTION_EVIDENCE_GUARD_MARKER,
              'The previous response described work but did not execute any substantive tool successfully, so it was not accepted as completion.',
              'Use the available tools now and continue until there is a concrete tool result.',
              'If indispensable information is missing, call request_clarification instead of presenting instructions as a completed result.',
            ].join(' '),
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (hasPendingMutationVerification()) {
          const canRetry = mutationVerificationRetries < MAX_MUTATION_VERIFICATION_RETRIES
            && iter + 1 < maxIters
            && availableVerificationToolNames.length > 0
          if (!canRetry) {
            const incomplete = await finishIncomplete({
              text: availableVerificationToolNames.length > 0
                ? '修改已经执行，但尚未通过读回、差异检查或项目检查验证，因此没有标记为完成。请重试以继续验证。'
                : '修改已经执行，但当前没有启用可用于读回、差异检查或项目检查的工具，因此无法确认完成。',
              reason: 'post_mutation_verification_missing',
              steeringLeaseId,
            })
            if (incomplete.deferredForSteering) continue
            return incomplete
          }
          mutationVerificationRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              POST_MUTATION_VERIFICATION_GUARD_MARKER,
              'A local mutation succeeded, but no later verification has succeeded, so the completion claim was discarded.',
              `Pending changed targets: ${[...pendingMutationTargets].join(', ')}.`,
              `Pending deleted targets: ${[...pendingDeletionTargets].join(', ')}.`,
              `Verify the changed state now with one of these available tools: ${availableVerificationToolNames.join(', ')}.`,
              'Read back each matching changed file, inspect the project diff, or run the relevant project check before answering. For deleted targets, list the complete parent directory so absence can be verified. Reading an unrelated file does not verify these targets.',
            ].join(' '),
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (requiresPdfLayoutVerification && !pdfLayoutVerificationObserved) {
          const canRetry = pdfLayoutVerificationRetries < MAX_PDF_LAYOUT_VERIFICATION_RETRIES
            && iter + 1 < maxIters
            && activeToolSpecs.some((spec) => toolNameFromSpec(spec) === 'bash_exec')
          if (!canRetry) {
            const incomplete = await finishIncomplete({
              text: '\u6587\u4ef6\u5df2\u751f\u6210\uff0c\u4f46\u5c1a\u672a\u901a\u8fc7\u76ee\u6807\u9875\u3001\u975e\u76ee\u6807\u9875\u3001\u6587\u672c\u8fb9\u754c\u4e0e\u9010\u9875\u6e32\u67d3\u7684 PDF \u5e03\u5c40\u6821\u9a8c\uff0c\u56e0\u6b64\u6ca1\u6709\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002',
              reason: 'pdf_layout_verification_missing',
              steeringLeaseId,
            })
            if (incomplete.deferredForSteering) continue
            return incomplete
          }
          pdfLayoutVerificationRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              PDF_LAYOUT_VERIFICATION_GUARD_MARKER,
              'The PDF/preview files exist, but existence and byte reads do not verify the requested page selection or visual layout.',
              requestedPdfSectionLabel(executionIntentText)
                ? `The authoritative requested section is ${requestedPdfSectionLabel(executionIntentText)}.`
                : 'Use the exact page or section named by the user.',
              'Create or correct a separate read-only verify_pdf_layout.py, then run it with bash_exec after all writes.',
              'It must assert target-page text, unchanged non-target pages, full text/order, glyph bounds, forbidden-line clearance, paragraph continuation/indentation, and one fresh non-empty PNG per output page.',
              'Do not use browser_open_url for local file:// PDF or PNG paths; browser tools accept only http/https URLs. Use bash_exec and the validator for local visual evidence.',
              `Only a successful validator that prints the standalone marker ${PDF_LAYOUT_VERIFICATION_OK} is accepted. Do not echo the marker or print it from the generation script.`,
            ].join(' '),
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        const completion = await prepareCompletionForSteering({
          text: content || '',
          steeringLeaseId,
        })
        if (!completion.closed) continue
        finalText = content || ''
        if (!completion.prepared) convo.push({ role: 'assistant', content: finalText })
        try {
          const hasFinalText = Boolean(finalText.trim())
          await persistTurn(hasFinalText ? { final: { text: finalText, iterations: iter + 1 } } : {})
          finalCheckpointPersisted = hasFinalText
          if (!completion.prepared && steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
        } catch (error) {
          if (steeringLeaseId && typeof releaseSteering === 'function') {
            await releaseSteering(steeringLeaseId)
          }
          throw error
        }
        break
      }

      // 唯一 id、参数 JSON 和简写/wire 形状都在公共 harness 里归一化。
      // 这样无 id 的调用也能保证 assistant.tool_calls 与 tool_call_id 严格配对。
      const scopedToolCalls = scopeTextToolCallIds(rawToolCalls, {
        turnId: job?.id || step?.id,
        iteration: iter,
      })
      const modelOutputTruncated = String(modelResult?.finishReason || '').toLowerCase() === 'length'
      checkpointCalls = normalizeToolCalls(scopedToolCalls, {
        toolSpecs: activeToolSpecs,
      }).map((call) => ({
        ...call,
        modelOutputTruncated,
        idempotencyKey: buildJobToolIdempotencyKey({
          jobId: job?.id,
          stepId: step?.id,
          toolCallId: call.id,
        }),
        checkpointStatus: 'pending',
        checkpointApprovalId: null,
      }))
      observeToolCalls(progressState, checkpointCalls)
      if (typeof onToolCall === 'function') {
        for (const call of checkpointCalls) await onToolCall(call)
      }
      await emitToolProgress('tools_scheduled')
      toolCalls = checkpointCalls
      convo.push(buildAssistantToolCallsMessage(toolCalls, content))
      try {
        // The model response and steering text become durable atomically from
        // the engine's perspective; only then may the steering lease be ACKed.
        await persistTurn()
        if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
          await acknowledgeSteering(steeringLeaseId)
          steeringLeaseId = null
        }
      } catch (error) {
        if (steeringLeaseId && typeof releaseSteering === 'function') {
          await releaseSteering(steeringLeaseId)
        }
        throw error
      }
    }

    let pausedByClarification = null
    const budgetExceededByCompletedModelResponse = modelBudgetExceededAfterResponse
    modelBudgetExceededAfterResponse = null
    let budgetExceeded = budgetExceededByCompletedModelResponse
    let noProgressReason = null
    const markCall = async (call, updates) => {
      Object.assign(call, updates)
      await persistTurn()
    }
    const observeFailureRecovery = (call, result) => {
      if (isSuccessfulToolResult(result)) {
        if (isSubstantiveToolCall(call)) {
          failureRecovery = restoreFailureRecovery()
          pendingFailureRecoveryPrompt = false
        }
        return
      }
      if (!shouldReflectOnFailure(result)) return
      const tool = String(call?.name || '').trim()
      if (!tool) return
      if (failureRecovery.tool !== tool) {
        failureRecovery = { tool, count: 0, reflected: false, attempts: [] }
      }
      failureRecovery.count += 1
      failureRecovery.attempts.push({
        tool,
        code: String(result?.code || 'tool_execution_failed').slice(0, 160),
        message: [
          String(result?.error || 'Tool execution failed.'),
          result?.hint ? `Hint: ${String(result.hint)}` : '',
        ].filter(Boolean).join(' ').slice(0, 800),
      })
      failureRecovery.attempts = failureRecovery.attempts.slice(-FAILURE_RECOVERY_THRESHOLD)
      if (failureRecovery.count >= FAILURE_RECOVERY_THRESHOLD && !failureRecovery.reflected) {
        pendingFailureRecoveryPrompt = true
      }
    }
    const appendFailureRecoveryPrompt = () => {
      if (!pendingFailureRecoveryPrompt || failureRecovery.reflected) return false
      const tried = failureRecovery.attempts.map((attempt, index) => (
        `${index + 1}. ${attempt.tool} failed with ${attempt.code}: ${attempt.message}`
      ))
      convo.push({
        role: 'system',
        content: [
          FAILURE_RECOVERY_MARKER,
          `The same tool (${failureRecovery.tool}) has failed ${failureRecovery.count} consecutive times.`,
          'Analyze the failure before making another call. Do not repeat the same method or merely vary guessed arguments.',
          'State internally what was tried, identify the likely cause from the concrete errors below, then choose a materially different strategy or report one specific blocker.',
          ...(process.platform === 'win32'
            && failureRecovery.tool === 'bash_exec'
            && activeToolSpecs.some((spec) => toolNameFromSpec(spec) === 'write_file')
            ? ['For long or multiline Python on Windows, the required different strategy is: create a UTF-8 .py file with write_file, run it with bash_exec, then verify the declared final outputs. Do not retry another long python -c command or a Unix-only pipeline.']
            : []),
          ...tried,
        ].join('\n'),
      })
      failureRecovery.reflected = true
      pendingFailureRecoveryPrompt = false
      return true
    }

    const executeOne = async (call, { durableExecution = true } = {}) => {
      if (signal?.aborted) {
        const error = new Error('Turn cancelled')
        error.name = 'AbortError'
        throw error
      }
      if (typeof onToolStarted === 'function') await onToolStarted(call)
      const { name, args } = call
      let executionArgsUsed = args
      // ★ M3.5:预算检查(reflect/request_clarification 不计,鼓励复盘与澄清)
      const isFree = name === 'reflect' || name === 'request_clarification' || name === 'request_directory' || name === 'sleep_until'
      let result
      let outcomeBudgetExceeded = null
      let outcomeNoProgressReason = null
      let clarification = null
      let artifactId = null
      const idempotentResume = call.checkpointStatus === 'executing'
        && supportsIdempotentResume(executeTool, {
          name,
          args: call.checkpointExecutionArgs ?? args,
          job,
          step,
          toolCallId: call.id,
          idempotencyKey: call.idempotencyKey,
        })
      if (call.modelOutputTruncated) {
        result = {
          ok: false,
          code: 'tool_call_truncated',
          error: 'The model reached its output-token limit while generating this tool-call batch, so the arguments may be incomplete and were not executed.',
          retryable: true,
          hint: 'Generate a fresh complete tool call. Shorten large inline content or split the work into smaller calls when necessary.',
        }
      } else if (call.checkpointStatus === 'executing'
        && getToolMetadata(name, { args, userId: job?.userId || null }).isReadOnly !== true
        && !idempotentResume) {
        // We cannot prove whether a side effect committed before the process
        // stopped. Never replay it automatically: report the uncertainty to
        // the model so it can verify state or ask the user how to proceed.
        result = {
          ok: false,
          code: 'tool_execution_outcome_unknown',
          error: `The service restarted while ${name} was executing. It was not replayed because its side effects may already have happened.`,
          retryable: false,
          requiresUserVerification: true,
        }
      } else {
        const convergenceBlock = convergenceBlockFor(call)
        const guardDecision = convergenceBlock
          ? { ok: false, result: convergenceBlock, convergenceBlocked: true }
          : loopGuard.before(call)
        if (!guardDecision.ok) {
          result = guardDecision.result
          if (!guardDecision.convergenceBlocked) outcomeNoProgressReason = guardDecision.reason
        } else {
          // 每次非思维型工具尝试都计成本，包括模型给出的未知工具/损坏参数。
          // 校验仍会阻止它们真正执行，但不能让无效调用绕过预算。
          if (!isFree) {
            const b = budget.consume(1)
            if (!b.ok) {
              outcomeBudgetExceeded = b.reason
              result = { ok: false, code: 'tool_budget_exceeded', error: b.reason, retryable: false }
            }
          }

          if (!result) {
            // 被产物门控挡下的文件工具单独给一条可执行的说明,否则模型只看到
            // 「未知工具：create_pptx」会以为是系统故障,继续重试到耗尽预算。
            if (isFileArtifactTool(call.name) && !stepArtifactTools.has(call.name)) {
              result = {
                ok: false,
                code: 'artifact_tool_not_requested',
                error: `用户没有要求生成 ${call.name} 这类文件产物,该工具在本次任务中不可用。`,
                retryable: false,
                hint: '直接完成用户真正要求的工作(如修改代码、给出结论),并用文字说明结果;不要用文件代替交付。',
              }
            }
          }

          if (!result) {
            const validationError = validateToolCall(call, activeToolSpecs, {
              // 单测/嵌入方可注入自己的 executor；生产默认执行器仍严格限制在已声明工具集。
              allowUnknown: executeTool !== executeServerTool,
            })
            if (validationError) result = validationError
          }

          if (!result && name === 'request_directory' && hasVerifiedDirectoryResolution) {
            result = {
              ok: false,
              code: 'directory_authorization_already_resolved',
              error: 'The requested local directory authorization is already persisted and verified for this turn.',
              retryable: false,
              hint: 'Do not request the directory again. Continue the original task now using the exact authorized path and access mode from the TURN_RESOLUTION system message.',
            }
          }

          if (!result && name === 'request_clarification') {
            result = contradictedCapabilityClarification(args, activeToolSpecs, convo)
          }

          if (!result) {
            try {
              // Resume the exact persisted approval after restart; otherwise
              // run the pre hook once, then create and persist the approval.
              // A resumed approval already contains the hook-rewritten args,
              // so the pre hook must not be fired a second time after restart.
              const resumingApproval = call.checkpointStatus === 'awaiting_approval' && call.checkpointApprovalId
              let effectiveArgs = args
              let gate = null
              if (idempotentResume) {
                effectiveArgs = call.checkpointExecutionArgs ?? effectiveArgs
                gate = {
                  proceed: true,
                  args: effectiveArgs,
                  approvalId: call.checkpointApprovalId || null,
                  resumedIdempotentExecution: true,
                }
              } else if (resumingApproval) {
                gate = await resumePersistedApproval({ approvalId: call.checkpointApprovalId, signal })
                effectiveArgs = gate.args ?? effectiveArgs
              } else {
                if (enableToolHooks && job?.userId) {
                  const preHook = await dispatchHooks({
                    userId: job.userId,
                    event: 'pre_tool_use',
                    tool: name,
                    args: effectiveArgs,
                    sessionId: job.id || null,
                    requestId: step?.id || null,
                  })
                  if (!preHook.allow) {
                    result = {
                      ok: false,
                      denied: true,
                      code: 'hook_denied',
                      error: preHook.reason || `pre_tool_use hook denied ${name}`,
                      retryable: false,
                    }
                  } else if (preHook.replacementArgs && typeof preHook.replacementArgs === 'object') {
                    effectiveArgs = preHook.replacementArgs
                  }
                }
                if (!result && effectiveArgs !== args) {
                  const hookValidationError = validateToolCall(
                    { ...call, args: effectiveArgs },
                    activeToolSpecs,
                    { allowUnknown: executeTool !== executeServerTool },
                  )
                  if (hookValidationError) result = hookValidationError
                }
                if (!result) gate = await requestToolApproval({
                    userId: job?.userId || null,
                    origin: approvalOrigin,
                    jobId: approvalOrigin === 'chat' ? null : job?.id || null,
                    stepId: approvalOrigin === 'chat' ? job?.id || null : step?.id || null,
                    sessionId: approvalSessionId,
                    toolName: name,
                    args: effectiveArgs,
                    signal,
                    mode: approvalMode,
                    onPending: async (approval) => {
                      await markCall(call, {
                        checkpointStatus: 'awaiting_approval',
                        checkpointApprovalId: approval.id,
                      })
                      if (typeof onApprovalPending === 'function') await onApprovalPending(approval)
                    },
                  })
              }
              if (gate && !gate.proceed) {
                result = formatDeniedToolResult(gate)
              } else if (gate) {
                const executionArgs = gate.args ?? effectiveArgs
                executionArgsUsed = executionArgs
                rememberApprovedSubagentCall(subagentApprovalContext, name, executionArgs, gate)
                const executionMetadata = getToolMetadata(name, {
                  args: executionArgs,
                  userId: job?.userId || null,
                })
                // Mutating tools ignore lease/transport aborts while a call is in flight,
                // but an explicit user stop still reaches cancellable shell/browser work.
                const abortScope = createToolAbortScope(signal, executionMetadata.interruptBehavior)
                if (durableExecution) {
                  await markCall(call, {
                    checkpointStatus: 'executing',
                    checkpointApprovalId: gate.approvalId || call.checkpointApprovalId || null,
                    checkpointExecutionArgs: executionArgs,
                    idempotencyKey: call.idempotencyKey,
                  })
                }
                try {
                  result = await executeToolWithRetry({
                    metadata: executionMetadata,
                    signal: abortScope.signal,
                    maxAttempts: toolRetryMaxAttempts,
                    baseDelayMs: toolRetryBaseDelayMs,
                    execute: () => executeTool({
                      name,
                      args: executionArgs,
                      job,
                      step,
                      signal: abortScope.signal,
                      budget,
                      toolCallId: call.id,
                      idempotencyKey: call.idempotencyKey,
                      approvalContext: subagentApprovalContext,
                      allowedArtifactTools: stepArtifactTools,
                    }),
                  })
                } finally {
                  abortScope.dispose()
                }
                if (gate.authorization && result && typeof result === 'object') {
                  result = { ...result, approvalAuthorization: gate.authorization }
                }
                artifactId = result?.artifactId || null
                if (isLoopPauseResult(result)) clarification = result.clarification
                if (enableToolHooks && job?.userId) {
                  try {
                    await dispatchHooks({
                      userId: job.userId,
                      event: 'post_tool_use',
                      tool: name,
                      args: { input: executionArgs, output: result },
                      sessionId: job.id || null,
                      requestId: step?.id || null,
                    })
                  } catch {
                    // The tool has already executed; a post hook failure must
                    // not replay or reinterpret its side effects.
                  }
                }
              }
              if (gate?.approvalId && !gate.resumedIdempotentExecution && typeof onApprovalResolved === 'function') {
                try {
                  await onApprovalResolved(gate)
                } catch {
                  // Approval has already resolved and the tool may already
                  // have committed an external side effect. An event/UI sink
                  // failure must never overwrite that real outcome and invite
                  // the model to replay the write.
                }
              }
            } catch (err) {
              if (signal?.aborted || err?.name === 'AbortError') throw err
              result = normalizeToolError(err)
            }
          }
        }
      }

      return {
        call,
        executionArgs: executionArgsUsed,
        result,
        artifactId,
        clarification,
        budgetExceeded: outcomeBudgetExceeded,
        noProgressReason: outcomeNoProgressReason,
      }
    }

    const pendingToolResultCount = Math.max(
      1,
      toolCalls.filter((call) => call.checkpointStatus !== 'completed').length,
    )
    const toolResultMaxChars = resolveToolResultMaxChars({
      contextWindow,
      resultCount: pendingToolResultCount,
    })
    const convergenceBatch = {
      exploratorySuccess: false,
      productiveSuccess: false,
    }
    // OpenAI-compatible providers require every tool response for one
    // assistant tool_calls batch to be contiguous. Browser screenshots add a
    // multimodal user message, so defer that (and any other post-tool context)
    // until every tool_call in this batch has received its tool response.
    const deferredPostBatchMessages = []

    const recordOutcome = async (outcome) => {
      outcome.result = normalizeToolResult(outcome.result)
      const succeeded = isSuccessfulToolResult(outcome.result)
      const executedCall = outcome.executionArgs === outcome.call?.args
        ? outcome.call
        : { ...outcome.call, args: outcome.executionArgs }
      if (succeeded && !outcome.artifactId) {
        const localArtifacts = await persistLocalToolArtifactsAsync({
          call: executedCall,
          result: outcome.result,
          job,
          step,
        })
        if (localArtifacts.length > 0) {
          outcome.artifactId = localArtifacts[0].id
          outcome.artifactIds = localArtifacts.map((artifact) => artifact.id)
          outcome.artifacts = localArtifacts.map(({ id, filename, type, url }) => ({ id, filename, type, url }))
          outcome.result = {
            ...outcome.result,
            artifactId: localArtifacts[0].id,
            filename: localArtifacts[0].filename,
            url: localArtifacts[0].url,
            artifacts: outcome.artifacts,
          }
        }
      }
      const progressChanges = progressChangesFor(executedCall, outcome.result)
      const installSignature = installAttemptSignature(executedCall)
      if (installSignature) rememberInstallAttempt(installSignature)
      const productiveExecution = executionConvergenceEnabled
        && isProductiveExecutionOutcome(executedCall, outcome.result, outcome.artifactId)
      if (productiveExecution) {
        convergenceBatch.productiveSuccess = true
      } else if (executionConvergenceEnabled
        && succeeded
        && isExplorationOnlyCall(executedCall, job?.userId || null)) {
        convergenceBatch.exploratorySuccess = true
      }
      recordToolProgress(progressState, {
        call: outcome.call,
        succeeded,
        ...progressChanges,
      })
      observeFailureRecovery(executedCall, outcome.result)
      if (!succeeded) outcome.artifactId = null
      const scheduledWaitEvidence = executedCall?.name === 'sleep_until'
        && outcome.result?.paused === true
        && outcome.result?.clarification?.blocker_kind === 'scheduled_wake'
        && Number.isFinite(Number(outcome.result?.clarification?.wakeAt))
        && SCHEDULED_WAIT_INTENT.test(executionIntentText)
      if (succeeded && (isSubstantiveToolCall(executedCall) || scheduledWaitEvidence)) {
        executionEvidenceObserved = true
      }
      const mutationExecutionSucceeded = executionConvergenceEnabled
        ? productiveExecution
        : succeeded && isMutationExecutionCall(executedCall, outcome.artifactId)
      if (mutationExecutionSucceeded) {
        mutationExecutionObserved = true
      }
      if (mutationExecutionSucceeded && isLocalMutationCall(executedCall)) {
        if (requiresPdfLayoutVerification) pdfLayoutVerificationObserved = false
        const deletionTargets = looksLikeDeletionCommand(executedCall?.args?.command)
          ? staticDeletionTargets(executedCall, outcome.result)
          : null
        if (deletionTargets?.size) {
          for (const deletionTarget of deletionTargets) {
            for (const pending of [...pendingMutationTargets]) {
              if (pending !== PROJECT_SCOPE_TARGET && targetsMatch(pending, deletionTarget)) {
                pendingMutationTargets.delete(pending)
              }
            }
            pendingDeletionTargets.add(deletionTarget)
          }
        } else {
          for (const target of extractMutationTargets(executedCall, outcome.result)) {
            pendingMutationTargets.add(target)
            if (target === PROJECT_SCOPE_TARGET) continue
            for (const deleted of [...pendingDeletionTargets]) {
              if (targetsMatch(deleted, target)) pendingDeletionTargets.delete(deleted)
            }
          }
        }
        mutationVerificationRetries = 0
      } else if (succeeded && hasPendingMutationVerification() && isVerificationCall(executedCall)) {
        const clearedMutation = clearVerifiedMutationTargets(
          pendingMutationTargets,
          executedCall,
          outcome.result,
        )
        const clearedDeletion = clearVerifiedDeletionTargets(
          pendingDeletionTargets,
          executedCall,
          outcome.result,
        )
        if (clearedMutation || clearedDeletion) {
          mutationVerificationRetries = 0
        }
      }
      if (requiresPdfLayoutVerification
        && isSuccessfulPdfLayoutVerification(executedCall, outcome.result)) {
        pdfLayoutVerificationObserved = true
        pdfLayoutVerificationRetries = 0
      }
      if (Array.isArray(outcome.artifactIds)) artifactIds.push(...outcome.artifactIds)
      else if (outcome.artifactId) artifactIds.push(outcome.artifactId)
      if (outcome.artifactId && expectedArtifactTools.has(outcome.call?.name)) {
        deliveredArtifactTools.add(outcome.call.name)
      }
      if (executedCall?.name === 'read_file' && succeeded) {
        hasSuccessfulRepresentativeRead = true
      }
      const toolResultMessages = buildToolResultMessages(
        outcome.call,
        outcome.result,
        { maxChars: toolResultMaxChars },
      )
      if (toolResultMessages.length > 1 && outcome.result?.image?.data) {
        const compactImage = { ...outcome.result.image }
        delete compactImage.data
        outcome.result = { ...outcome.result, image: { ...compactImage, captured: true } }
      }
      const [toolResultMessage, ...postToolMessages] = toolResultMessages
      convo.push(toolResultMessage)
      deferredPostBatchMessages.push(...postToolMessages)
      if (executedCall?.name === 'request_directory'
        && succeeded
        && outcome.result?.already_authorized === true
        && outcome.result?.authorization?.resource_type === 'directory') {
        const accessMode = String(outcome.result.authorization.access_mode || '').trim()
        const requiredNames = new Set([
          'list_directory',
          'read_file',
          ...(accessMode === 'read_write' ? ['write_file', 'edit_file', 'bash_exec'] : []),
        ])
        const byName = new Map(activeToolSpecs.map((spec) => [toolNameFromSpec(spec), spec]))
        for (const spec of Array.isArray(fallbackToolSpecs) ? fallbackToolSpecs : []) {
          const name = toolNameFromSpec(spec)
          if (requiredNames.has(name) && !byName.has(name)) byName.set(name, spec)
        }
        const refreshedSpecs = [...byName.values()].filter(Boolean)
        if (refreshedSpecs.length > activeToolSpecs.length) {
          activeToolSpecs = refreshedSpecs
          convo = replaceRuntimeCapabilityBlock(convo, {
            toolSpecs: activeToolSpecs,
            approvalMode,
          })
          availableVerificationToolNames = activeToolSpecs
            .map(toolNameFromSpec)
            .filter((name) => VERIFICATION_TOOLS.has(name) || name === 'bash_exec')
          requiresPdfLayoutVerification = mutationExecutionRequested
            && shouldRequirePdfLayoutVerification(executionIntentText)
            && activeToolSpecs.some((spec) => toolNameFromSpec(spec) === 'bash_exec')
          deferredPostBatchMessages.push({
            role: 'system',
            content: [
              '[DIRECTORY AUTHORIZATION TOOL REFRESH]',
              `The persisted ${accessMode} directory grant has been verified by the runtime.`,
              `The callable tools for the next response are now: ${activeToolSpecs.map(toolNameFromSpec).filter(Boolean).join(', ')}.`,
              `Use the exact authorized directory ${JSON.stringify(outcome.result.authorization.path)} and continue the original task without requesting authorization again.`,
              `This refreshed list supersedes the earlier ${AVAILABLE_TOOL_CAPABILITIES_MARKER} list for local file and code-execution capabilities.`,
            ].join(' '),
          })
        }
      }
      const convergenceBlocked = [
        'execution_convergence_probe_blocked',
        'execution_convergence_install_blocked',
      ].includes(String(outcome.result?.code || ''))
      const progress = convergenceBlocked
        ? { ok: true }
        : loopGuard.after(outcome.result, outcome.call)
      const toolProgress = convergenceBlocked
        ? { ok: true }
        : loopGuard.afterCall?.(executedCall, outcome.result) || { ok: true }
      if (!noProgressReason) {
        noProgressReason = outcome.noProgressReason
          || (!progress.ok ? progress.reason : null)
          || (!toolProgress.ok ? toolProgress.reason : null)
      }
      if (!budgetExceeded && outcome.budgetExceeded) budgetExceeded = outcome.budgetExceeded
      if (!pausedByClarification && outcome.clarification) pausedByClarification = outcome.clarification
      await markCall(outcome.call, {
        checkpointStatus: 'completed',
        checkpointResult: outcome.result,
        checkpointArtifactId: outcome.artifactId || null,
      })
      if (typeof onToolCompleted === 'function') await onToolCompleted(outcome)
      await emitToolProgress('tool_completed')
    }

    const isParallelReadCall = (call) => {
      const metadata = getToolMetadata(call.name, {
        args: call.args,
        userId: job?.userId || null,
      })
      // Concurrency safety only describes whether two calls may overlap; it
      // is not proof that a side effect can be replayed after a crash. Keep
      // every mutation on the durable serial path even when a dynamic/MCP
      // tool explicitly declares itself concurrency-safe.
      return metadata.isReadOnly === true && metadata.isConcurrencySafe === true
    }
    const shouldStopBatch = () => Boolean(
      noProgressReason || budgetExceeded || pausedByClarification,
    )
    const skipRemainingCalls = async (startIndex) => {
      // If the batch must stop, every unanswered tool_call still needs a tool
      // result before the conversation can be sent back to the model.
      for (const skipped of toolCalls.slice(startIndex)) {
        if (skipped.checkpointStatus === 'completed') continue
        const skippedResult = {
          ok: false,
          code: 'tool_execution_skipped',
          error: noProgressReason || budgetExceeded || '当前轮已暂停',
          retryable: false,
        }
        convo.push(buildToolResultMessage(skipped, skippedResult))
        Object.assign(skipped, {
          checkpointStatus: 'completed',
          checkpointResult: skippedResult,
        })
        recordToolProgress(progressState, { call: skipped, succeeded: false })
      }
      await persistTurn()
    }

    // Preserve model order while treating each write or non-concurrency-safe
    // call as a barrier. Consecutive safe reads before and after a barrier can
    // run concurrently, while the barrier itself keeps durable execution and
    // approval/checkpoint semantics.
    let callIndex = 0
    while (callIndex < toolCalls.length) {
      const call = toolCalls[callIndex]
      if (call.checkpointStatus === 'completed') {
        callIndex += 1
        continue
      }

      if (isParallelReadCall(call)) {
        const readSegment = []
        let segmentEnd = callIndex
        while (segmentEnd < toolCalls.length) {
          const candidate = toolCalls[segmentEnd]
          if (candidate.checkpointStatus === 'completed' || !isParallelReadCall(candidate)) break
          readSegment.push(candidate)
          segmentEnd += 1
        }
        const outcomes = await mapWithConcurrency(
          readSegment,
          (candidate) => executeOne(candidate, { durableExecution: false }),
          { concurrency: JOB_READ_CONCURRENCY },
        )
        const hardNoProgressReason = outcomes.find((outcome) => outcome.noProgressReason)?.noProgressReason || null
        for (const outcome of outcomes) await recordOutcome(outcome)
        // A later successful candidate proves progress after ordinary read
        // failures. It must not, however, erase a pre-execution hard fuse such
        // as the third identical call in the same segment.
        if (hardNoProgressReason) noProgressReason = hardNoProgressReason
        else if (outcomes.some(({ result }) => result?.ok === true)) noProgressReason = null
        callIndex = segmentEnd
      } else {
        const outcome = await executeOne(call)
        await recordOutcome(outcome)
        callIndex += 1
      }

      if (shouldStopBatch()) {
        await skipRemainingCalls(callIndex)
        break
      }
    }
    convo.push(...deferredPostBatchMessages)
    if (executionConvergenceEnabled) {
      if (convergenceBatch.productiveSuccess) {
        executionConvergence.unproductiveRounds = 0
        executionConvergence.interventionActive = false
        executionConvergence.installAttempts = []
      } else if (convergenceBatch.exploratorySuccess) {
        executionConvergence.unproductiveRounds += 1
      }
      if (!executionConvergence.interventionActive
        && executionConvergence.unproductiveRounds >= EXECUTION_CONVERGENCE_ROUND_THRESHOLD) {
        executionConvergence.interventions += 1
        executionConvergence.interventionActive = true
        convo.push({
          role: 'system',
          content: [
            EXECUTION_CONVERGENCE_MARKER,
            `${executionConvergence.unproductiveRounds} consecutive tool batches completed discovery or inspection work without producing the requested output.`,
            'Discovery is now considered complete. Do not create or run more inspect/probe/diagnostic scripts, repeat dependency checks, or reinstall an already attempted dependency.',
            'Immediately execute the requested mutation or artifact-generation step, declare expected_outputs for generated local files when supported, and then verify the resulting files or project state.',
            'If execution is genuinely blocked, report the single concrete command error or missing authorization; do not substitute another exploration loop.',
          ].join(' '),
        })
      }
    }
    appendFailureRecoveryPrompt()
    checkpointCalls = null
    await persistTurn()
    await emitToolProgress('batch_completed')
    if (budgetExceeded) {
      // ★ Lens-4 fix:预算超限写 audit,审计员能追查 job 为什么没跑完
      if (job?.userId) {
        writeToolAudit({
          userId: job.userId,
          origin: 'budget',
          toolName: 'job_budget',
          args: { jobId: job.id, stepId: step?.id, snapshot: budget.snapshot?.() },
          status: 'denied',
          durationMs: 0,
        })
      }
      // ★ 这里以前直接 return finalText —— 而 finalText 在预算路径上几乎必然是 ''。
      // 用户看到的就是「任务跑了很久,然后一个字都没有」,即
      // 「做到一半就没有后续」最典型的现场。
      //
      // 对齐 maxIters 路径的做法:让模型基于已有信息收个尾。
      // 收尾调用**不再受已耗尽的预算约束**(不传 consumeBudget)—— 否则预算已经
      // 超了,收尾调用自己也会被拒,永远拿不到总结,等于没修。
      if (!finalText && budgetExceededByCompletedModelResponse) {
        finalText = '\u5df2\u6267\u884c\u6a21\u578b\u8fd4\u56de\u7684\u6700\u540e\u4e00\u6279\u5de5\u5177\u8c03\u7528\uff0c\u4f46\u6a21\u578b token \u9884\u7b97\u5df2\u7528\u5c3d\u3002\u5df2\u4fdd\u5b58\u68c0\u67e5\u70b9\uff1b\u91cd\u8bd5\u540e\u53ef\u4ece\u5f53\u524d\u8fdb\u5ea6\u7ee7\u7eed\uff0c\u4e0d\u4f1a\u91cd\u590d\u5df2\u5b8c\u6210\u7684\u5de5\u5177\u8c03\u7528\u3002'
      }
      if (!finalText) {
        try {
          const wrapUpRequest = await callModelWithContextRecovery({
            messages: [
              ...convo,
              {
                role: 'system',
                content: `任务预算已用尽(${budgetExceeded})。请基于目前已经取得的进展给出总结:做完了什么、还差什么、建议用户下一步怎么做。不要再调用任何工具。`,
              },
            ],
            tools: [],
            callModel: (modelRequest) => runWithModelBudget(
              budget,
              () => runModel(modelRequest),
              { allowOverBudget: true },
            ),
            isContextLengthError,
            contextWindow,
            semanticSummary,
            signal,
            userId: job?.userId || null,
            sessionId: recoverySessionId,
            toolChoice: 'none',
          })
          if (wrapUpRequest.recovery?.archiveId) {
            recovery = { archiveId: String(wrapUpRequest.recovery.archiveId) }
          }
          finalText = wrapUpRequest.response?.content || ''
        } catch {
          writeToolAudit?.({
            userId: job?.userId,
            origin: 'budget',
            toolName: 'wrap_up',
            args: { jobId: job?.id, stepId: step?.id },
            status: 'error',
            durationMs: 0,
          })
          finalText = ''
        }
      }
      assertRequiredArtifacts()
      const terminal = await finishTerminalResult({
        text: finalText || `(任务预算已用尽:${budgetExceeded}。上面的工具结果可能已包含部分进展,可以点「重试」从断点继续。)`,
        artifactIds,
        iterations: iter + 1,
        incomplete: true,
        budgetExceeded: true,
        reason: budgetExceeded,
        recovery,
      }, { steeringLeaseId, finalMetadata: { budgetExceeded: true } })
      if (!terminal) continue
      return terminal
    }
    if (pausedByClarification) {
      // ★ M3: 模型主动调 request_clarification → 当轮 loop 中断交回用户
      const terminal = await finishTerminalResult({
        text: finalText || String(
          pausedByClarification.question
          || pausedByClarification.message
          || '需要你补充信息后才能继续。',
        ),
        artifactIds,
        iterations: iter + 1,
        paused: true,
        clarification: pausedByClarification,
        recovery,
      }, {
        steeringLeaseId,
        finalMetadata: { paused: true, clarification: pausedByClarification },
      })
      if (!terminal) continue
      return terminal
    }
    if (noProgressReason) {
      try {
        const wrapUpRequest = await callModelWithContextRecovery({
          messages: [
            ...convo,
            {
              role: 'system',
              content: `工具循环因无进展停止：${noProgressReason}。请基于已有信息给出部分结论，不要再调用工具。`,
            },
          ],
          tools: [],
          callModel: (modelRequest) => runWithModelBudget(
            budget,
            () => runModel(modelRequest),
            { allowOverBudget: true },
          ),
          isContextLengthError,
          contextWindow,
          semanticSummary,
          signal,
          userId: job?.userId || null,
          sessionId: recoverySessionId,
          consumeBudget: (cost) => budget.consume(cost),
          toolChoice: 'none',
        })
        if (wrapUpRequest.recovery?.archiveId) {
          recovery = { archiveId: String(wrapUpRequest.recovery.archiveId) }
        }
        const wrapUp = wrapUpRequest.response
        finalText = wrapUp?.content || ''
      } catch {
        finalText = ''
      }
      assertRequiredArtifacts()
      const terminal = await finishTerminalResult({
        text: finalText || `(工具循环已停止：${noProgressReason})`,
        artifactIds,
        iterations: iter + 1,
        incomplete: true,
        noProgress: true,
        reason: noProgressReason,
        recovery,
      }, { steeringLeaseId, finalMetadata: { noProgress: true } })
      if (!terminal) continue
      return terminal
    }
  }

  // ★ Harness: 到达迭代上限时,以前直接返回空 finalText —— 用户看到的是
  // "任务完成但什么都没说"。对齐 subagentRuntime 的做法:让模型基于已有信息
  // 收个尾,拿不到就至少说清楚是被上限截断的,不要静默空返回。
  if (!finalText) {
    try {
      const wrapUpRequest = await callModelWithContextRecovery({
        messages: [
          ...convo,
          {
            role: 'system',
            content: `你已达到工具调用上限(${maxIters} 轮)。请基于目前已有的信息给出最终回答,不要再调用任何工具。`,
          },
        ],
        tools: [],
        callModel: (modelRequest) => runWithModelBudget(
          budget,
          () => runModel(modelRequest),
          { allowOverBudget: true },
        ),
        isContextLengthError,
        contextWindow,
        semanticSummary,
        signal,
        userId: job?.userId || null,
        sessionId: recoverySessionId,
        consumeBudget: (cost) => budget.consume(cost),
        toolChoice: 'none',
      })
      if (wrapUpRequest.recovery?.archiveId) {
        recovery = { archiveId: String(wrapUpRequest.recovery.archiveId) }
      }
      const wrapUp = wrapUpRequest.response
      finalText = wrapUp?.content || ''
    } catch {
      writeToolAudit?.({
        userId: job?.userId,
        origin: 'loop',
        toolName: 'wrap_up',
        args: { jobId: job?.id, stepId: step?.id },
        status: 'error',
        durationMs: 0,
      })
      finalText = ''
    }
    if (!finalText) {
      finalText = `(已达到 ${maxIters} 轮工具调用上限,任务未能自行收尾。上面的工具结果可能已包含部分进展。)`
    }
  }

  assertRequiredArtifacts()
  if (!hasRequiredExecutionEvidence()) {
    return finishIncomplete({
      text: '\u4efb\u52a1\u5c1a\u672a\u5b8c\u6210\uff1a\u672a\u83b7\u5f97\u53ef\u9a8c\u8bc1\u7684\u5b9e\u9645\u6267\u884c\u7ed3\u679c\u3002\u8bf7\u91cd\u8bd5\uff0c\u6216\u5207\u6362\u5230\u652f\u6301\u5de5\u5177\u8c03\u7528\u7684\u6a21\u578b\u3002',
      reason: 'execution_evidence_missing',
    })
  }
  if (hasPendingMutationVerification()) {
    return finishIncomplete({
      text: availableVerificationToolNames.length > 0
        ? '\u4fee\u6539\u5df2\u7ecf\u6267\u884c\uff0c\u4f46\u5c1a\u672a\u901a\u8fc7\u8bfb\u56de\u3001\u5dee\u5f02\u68c0\u67e5\u6216\u9879\u76ee\u68c0\u67e5\u9a8c\u8bc1\uff0c\u56e0\u6b64\u6ca1\u6709\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002'
        : '\u4fee\u6539\u5df2\u7ecf\u6267\u884c\uff0c\u4f46\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u7684\u9a8c\u8bc1\u5de5\u5177\uff0c\u56e0\u6b64\u65e0\u6cd5\u786e\u8ba4\u5b8c\u6210\u3002',
      reason: 'post_mutation_verification_missing',
    })
  }
  if (!finalCheckpointPersisted) {
    await persistTurn({ final: { text: finalText, iterations: Math.min(iter + 1, maxIters) } })
  }
  return { text: finalText, artifactIds, iterations: Math.min(iter + 1, maxIters), recovery }
}

export const runToolLoop = runToolsLoop
