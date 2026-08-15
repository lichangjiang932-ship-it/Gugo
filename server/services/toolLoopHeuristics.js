/**
 * 工具循环的启发式层(方案 A 拆分)。
 *
 * 从 toolLoopRuntime.js 抽出的纯辅助与正则启发式:工具名集合、变更/删除/探针检测、
 * 验证分类、失败恢复与收敛计数、产物/目录/子代理请求构建、服务端工具执行器,
 * 以及 SERVER_TOOL_SPECS 等公共工具 spec API(仍从这里 re-export 给调用方)。
 *
 * 纯逻辑、无 IO(除 executeServerTool 的既有分发),不 import routes/react。
 */
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
import { publishTurnActivity } from './turnActivityBus.js'
import { recordFileSnapshot, rewindFromToolCall } from './fileSnapshotStore.js'
import { killBackgroundProcess, listBackgroundProcesses, startBackgroundProcess } from './backgroundProcessStore.js'
import { createDocx, createHtmlArtifact, createImageArtifact, createLocalFileArtifact, createLocalFileArtifactAsync, createPptx, createXlsx } from './artifactGen.js'
import { FS_SHELL_TOOL_SPECS, dispatchFsShellTool, resolveInWorkspace, resolveForFileTool } from '../adapters/fsShellTools.js'
import { IMAGE_TOOL_SPECS, dispatchImageTool } from '../adapters/imageTools.js'
import { MEDIA_TOOL_SPECS, dispatchMediaTool } from '../adapters/mediaTools.js'
import { PDF_TOOL_SPECS, dispatchPdfTool } from '../adapters/pdfTools.js'
import { BATCH_FILE_TOOL_SPECS, dispatchBatchFileTool } from '../adapters/batchFileTools.js'
import { CODING_AGENT_TOOL_SPECS, dispatchCodingAgentTool } from '../adapters/codingAgentTools.js'
import { dispatchGitTool } from '../adapters/gitWorkbench.js'
import { dispatchCodeSearchTool } from '../utils/codeSearch.js'
import { dispatchApplyPatchTool } from '../utils/applyPatch.js'
import { dispatchAgenticTool } from '../utils/agenticTools.js'
import { getBuiltinSpec, getToolMetadata, listBuiltinSpecs } from './toolRegistry.js'
import { CONNECTOR_TOOL_NAMES, CONNECTOR_TOOL_SPECS, CONNECTOR_WRITE_TOOL_NAMES, executeConnectorTool } from './connectorTools.js'
import { dispatchMemoryTool } from '../utils/memoryTools.js'
import { allowedArtifactTools, isFileArtifactTool } from './artifactIntent.js'
import { selectChatToolSpecs } from './chatToolSelection.js'
import { runSubagentBatch } from './subagentRuntime.js'
import { isSubstantiveToolCall, normalizeToolError } from '../utils/toolCallHarness.js'
import { callTool as callMcpTool } from '../mcp/mcpManager.js'
import { executeBrowserTool } from './browserToolExecutor.js'
import { fetchAndExtract } from '../adapters/toolProxy.js'
import { searchWeb } from './webSearchService.js'
import { generateImage } from './mediaModelService.js'


const FS_SHELL_TOOL_NAMES = new Set(
  FS_SHELL_TOOL_SPECS.map((spec) => String(spec?.function?.name || '')).filter(Boolean),
)
const IMAGE_TOOL_NAMES = new Set(IMAGE_TOOL_SPECS.map((spec) => spec.function.name))
const MEDIA_TOOL_NAMES = new Set(MEDIA_TOOL_SPECS.map((spec) => spec.function.name))
const PDF_TOOL_NAMES = new Set(PDF_TOOL_SPECS.map((spec) => spec.function.name))
const BATCH_FILE_TOOL_NAMES = new Set(BATCH_FILE_TOOL_SPECS.map((spec) => spec.function.name))
const CODING_AGENT_TOOL_NAMES = new Set(CODING_AGENT_TOOL_SPECS.map((spec) => spec.function.name))
const COMMAND_EXECUTION_TOOL_NAMES = new Set(['bash_exec', 'run_command'])
const COMMAND_OUTPUT_TOOL_NAMES = new Set([...COMMAND_EXECUTION_TOOL_NAMES, 'docker_exec'])
const LOCAL_ARTIFACT_TOOL_NAMES = new Set([
  'write_file',
  ...COMMAND_OUTPUT_TOOL_NAMES,
  'image_transform',
  'media_transform',
  'pdf_transform',
  'archive_create',
  'file_download',
])

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
  'patch_file',
  'multi_edit',
  'file_download',
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
const POWERSHELL_READ_ONLY_COMMAND = /\b(?:Get-Content|Get-FileHash|Get-ChildItem|Get-Item|Test-Path|Select-String|Measure-Object|Compare-Object)\b/i
const POWERSHELL_MUTATION_COMMAND = /\b(?:Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|Set-Item|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Acl|Start-Process|Invoke-Expression)\b|(?:^|[^>])>{1,2}(?!=)/i
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
const REPEAT_CALL_GUARD_MARKER = '[REPEAT CALL GUARD]'
const EXECUTION_CONVERGENCE_ROUND_THRESHOLD = 3
const MAX_INSTALL_ATTEMPT_SIGNATURES = 24
const PROBE_SCRIPT_PATH = /(?:^|[\\/])(?:[._-]?(?:inspect|probe|diagnos(?:e|tic)|debug[-_]?env|check[-_]?env|env[-_]?check|test[-_]?(?:import|dependency)))(?:[-_.0-9][^\\/]*)?\.(?:py|m?js|cjs|ts|ps1|sh|cmd|bat)$/i
const PROBE_SCRIPT_REFERENCE = /(?:^|[\s"'`])(?:[^\s"'`;|&]*[\\/])?(?:[._-]?(?:inspect|probe|diagnos(?:e|tic)|debug[-_]?env|check[-_]?env|env[-_]?check|test[-_]?(?:import|dependency)))(?:[-_.0-9][^\s"'`;|&]*)?\.(?:py|m?js|cjs|ts|ps1|sh|cmd|bat)(?=$|[\s"'`;|&])/i
const ENVIRONMENT_PROBE_COMMAND = /(?:\b(?:python(?:3)?|py|node)\b[^\r\n;&|]{0,80}(?:--version|-V\b|\s-c\s+)[^\r\n;&|]{0,240}(?:\bimport\b|find_spec|__version__|version)|\b(?:pip(?:3)?|python(?:3)?\s+-m\s+pip|py\s+-m\s+pip)\s+(?:show|list|check)\b|\b(?:npm|pnpm|yarn)\s+(?:list|ls|why)\b|\b(?:where(?:\.exe)?|which|Get-Command)\s+[^\r\n;&|]+)/i
const NON_REFLECTIVE_FAILURE_CODES = new Set([
  'tool_execution_skipped',
  'tool_execution_superseded_by_steering',
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

function isCommandExecutionTool(value) {
  const name = typeof value === 'string' ? value : value?.name
  return COMMAND_EXECUTION_TOOL_NAMES.has(String(name || '').trim())
}

function commandExecutionToolNames(specs) {
  return (Array.isArray(specs) ? specs : [])
    .map(toolNameFromSpec)
    .filter((name) => isCommandExecutionTool(name))
}

function hasCommandExecutionTool(specs) {
  return commandExecutionToolNames(specs).length > 0
}

function commandExecutionToolLabel(specs) {
  return commandExecutionToolNames(specs).join(' or ') || 'bash_exec or run_command'
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
  const availableCommandNames = [...availableNames].filter((name) => isCommandExecutionTool(name))
  const contradicted = []
  if (CODE_EXECUTION_CAPABILITY.test(text)) contradicted.push(...availableCommandNames)
  if (FILE_WRITE_CAPABILITY.test(text)) {
    contradicted.push(...availableCommandNames)
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
    'Do not call browser_open_url with a local file:// PDF or PNG; browser tools accept only http/https URLs. Inspect local PDF and image files through an exposed command tool (bash_exec or run_command) and the read-only validator.',
    `Only after every assertion passes may the validator print the exact standalone marker ${PDF_LAYOUT_VERIFICATION_OK}. A read_file or directory listing proves existence only and is not layout verification. Do not claim completion without a successful validator result containing that marker.`,
    // ★ 实事求是汇报(用户明确要求):验证通过就直说「验证器打印了 PDF_LAYOUT_VERIFICATION_OK」,
    // 不要用「通过全部断言」这类转述猜测;产出文件用 Markdown 链接给出完整路径,
    // 供用户直接点击打开;永远不要把设备重定向(nul)当成产出文件列出来。
    'Report results as plain fact: if the validator printed PDF_LAYOUT_VERIFICATION_OK, say exactly that — do not paraphrase it as assertions passing or speculate about internals. List every produced file with its full path as a Markdown link so it can be clicked. Never list device-redirection targets (nul) as output files.',
  ].join(' ')
}

function isSuccessfulPdfLayoutVerification(call, result) {
  if (!isCommandExecutionTool(call) || !isSuccessfulToolResult(result)) return false
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
  if (!isCommandExecutionTool(call)) return ''
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
  if (!isCommandExecutionTool(call)) return false
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
  if (isCommandExecutionTool(call)
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
  if (!isCommandExecutionTool(call)) return ''
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

function powerShellCommandScript(call) {
  if (!isCommandExecutionTool(call)) return ''
  const command = String(call?.args?.command || '').trim()
  if (!/^\s*(?:powershell|pwsh)(?:\.exe)?\b/i.test(command)) return ''
  const commandFlag = command.match(/(?:^|\s)-(?:command|c)\s+([\s\S]+)$/i)
  if (!commandFlag) return ''
  let script = String(commandFlag[1] || '').trim()
  if ((script.startsWith('"') && script.endsWith('"'))
    || (script.startsWith("'") && script.endsWith("'"))) {
    script = script.slice(1, -1).trim()
  }
  return script
}

function isReadOnlyPowerShellVerificationCall(call) {
  const script = powerShellCommandScript(call)
  if (!script
    || /[;<>`]|&&|\|\||\$\(/.test(script)
    || POWERSHELL_MUTATION_COMMAND.test(script)) {
    return false
  }
  const pipeline = script.split('|').map((part) => part.trim()).filter(Boolean)
  if (!pipeline.length || !/^\(?\s*(?:Get-Content|Get-FileHash|Get-ChildItem|Get-Item|Test-Path|Select-String|Compare-Object)\b/i.test(pipeline[0])) {
    return false
  }
  return pipeline.slice(1).every((part) => (
    /^(?:Format-(?:Table|List|Wide)|Select-Object|Sort-Object|Measure-Object)\b/i.test(part)
  )) && POWERSHELL_READ_ONLY_COMMAND.test(script)
}

function isLocalMutationCall(call) {
  if (LOCAL_MUTATION_TOOLS.has(call?.name)) {
    return !(['apply_patch', 'patch_file'].includes(call?.name) && call?.args?.dry_run === true)
  }
  if (!isCommandExecutionTool(call) || isVerificationCall(call)) return false
  return getToolMetadata(call.name, { args: call.args }).isReadOnly !== true
}

function isVerificationCall(call) {
  if (VERIFICATION_TOOLS.has(call?.name)) return true
  if (!isCommandExecutionTool(call)) return false
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
    || isReadOnlyPowerShellVerificationCall(call)
    || getToolMetadata(call.name, { args: call.args }).isReadOnly === true
}

function isMutationExecutionCall(call, artifactId = null) {
  if (!isSubstantiveToolCall(call)) return false
  if (artifactId || isFileArtifactTool(call?.name) || CONNECTOR_WRITE_TOOL_NAMES.includes(call?.name)) return true
  if (LOCAL_MUTATION_TOOLS.has(call?.name)) return isLocalMutationCall(call)
  if (isCommandExecutionTool(call)) return isLocalMutationCall(call)
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
  // ★ Windows/Unix 空设备是重定向目标,不是真实产出。
  //   `>nul`(cmd) / `>$null`(PowerShell) / `>/dev/null`(sh) 一旦被当成
  //   pending mutation target,就永远无法被读回/差异验证清除 ——
  //   最终会误报 post_mutation_verification_missing,让一个已完成的任务
  //   以「验证缺失」结尾。空设备一律不跟踪。
  if (/^(?:nul|\\\\.\\nul|\/dev\/null|\$null)$/i.test(target)) return ''
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
  if (!isCommandExecutionTool(call)) return null
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
  if (!isCommandExecutionTool(call)) return null
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
  if (!isCommandExecutionTool(call)) return null
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
  const shellCwd = isCommandExecutionTool(call)
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
      && isCommandExecutionTool(call)
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
  if (isCommandExecutionTool(call)) {
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

function powerShellVerificationTargets(call, result) {
  if (!isReadOnlyPowerShellVerificationCall(call)) return new Set()
  const script = powerShellCommandScript(call)
  const targets = new Set()
  addVerificationTarget(targets, result?.path)
  const pathArgument = /\b(?:Get-Content|Get-FileHash|Get-Item|Select-String)\b[^\r\n;|]{0,240}?(?:-(?:Literal)?Path\s+)(?:"([^"]+)"|'([^']+)'|([^\s;|)]+))/gi
  for (const match of script.matchAll(pathArgument)) {
    addVerificationTarget(targets, match[1] || match[2] || match[3])
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
  if (isCommandExecutionTool(call)) {
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
    const powerShellEvidence = powerShellVerificationTargets(call, result)
    if (powerShellEvidence.size > 0) {
      return clearExplicitTargetsMatchingEvidence(pendingTargets, powerShellEvidence)
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
  previousUserPrompt = '',
  skillId = undefined,
  specs = SERVER_TOOL_SPECS,
  origin = '',
  intentMode = 'auto',
  userId = null,
  metadataResolver = undefined,
} = {}) {
  // Final-delivery selection is a server-owned chat control, not a user
  // capability toggle. Older clients and persisted settings do not know about
  // this hidden tool, so the upstream configured list can legitimately omit
  // it. Restore the canonical schema for chat turns before capability routing;
  // answer mode will still remove it as a mutating control, and non-chat jobs
  // remain unable to claim turn-owned artifacts.
  const sourceSpecs = Array.isArray(specs) ? specs : []
  const deliveryControlSpec = origin === 'chat' ? getBuiltinSpec('set_deliverables') : null
  const routedSpecs = deliveryControlSpec
    && !sourceSpecs.some((spec) => spec?.function?.name === 'set_deliverables')
    ? [...sourceSpecs, deliveryControlSpec]
    : sourceSpecs
  const allowed = allowedArtifactTools(userPrompt, { skillId })
  const artifactFiltered = routedSpecs.filter((spec) => {
    const name = spec?.function?.name
    if (!name) return false
    // Final-delivery selection is scoped to a persisted chat turn. Background
    // jobs have a different artifact owner (job/step) and must not be allowed
    // to claim turn artifacts through this control tool.
    if (name === 'set_deliverables' && origin !== 'chat') return false
    return !isFileArtifactTool(name) || allowed.has(name)
  })
  if (origin === 'chat') {
    return selectChatToolSpecs({
      prompt,
      userPrompt,
      previousUserPrompt,
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
  if (call?.name === 'write_file' || call?.name === 'file_download') {
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
  if (!COMMAND_OUTPUT_TOOL_NAMES.has(call?.name)) return []
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
  if (result?.ok !== true || !LOCAL_ARTIFACT_TOOL_NAMES.has(call?.name)) return []
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
  if (result?.ok !== true || !LOCAL_ARTIFACT_TOOL_NAMES.has(call?.name)) return []
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
export function buildSubagentRequest(args = {}, inheritedModelName = '', inheritedSkillIds = [], inheritedSkillDefinitions = []) {
  const rawRequest = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const request = { ...rawRequest }
  delete request.skillDefinitions
  delete request.skill_definitions
  const modelName = String(request.modelName || request.model_name || inheritedModelName || '').trim()
  const explicitSkillIds = request.skillIds || request.skill_ids
  const skillIds = [...new Set((Array.isArray(explicitSkillIds) ? explicitSkillIds : inheritedSkillIds)
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
  return {
    ...request,
    ...(modelName ? { modelName } : {}),
    ...(skillIds.length ? { skillIds } : {}),
    ...(Array.isArray(inheritedSkillDefinitions) && inheritedSkillDefinitions.length
      ? { skillDefinitions: inheritedSkillDefinitions }
      : {}),
  }
}

export function inheritedJobSkillIds(job, activeSkillId = null) {
  const configured = Array.isArray(job?.skillIds) ? job.skillIds : []
  const fallback = configured.length ? configured : (activeSkillId ? [activeSkillId] : [])
  return [...new Set(fallback
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

// Image outputs the model must be able to inspect to verify its own work.
// Feedback is opt-in per tool and capped so large media never enters the
// prompt as base64. TIFF/AVIF are omitted because common vision endpoints
// reject them.
const VISION_FEEDBACK_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const VISION_FEEDBACK_FORMAT_MIMES = Object.freeze({
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
})
const VISION_FEEDBACK_EXT_MIMES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
})

function resolveVisionFeedbackMaxBytes() {
  const raw = Number(process.env.VISION_FEEDBACK_MAX_BYTES)
  return Number.isInteger(raw) && raw > 0 ? raw : 2 * 1024 * 1024
}

function visionFeedbackMime(name, result) {
  const explicit = String(result?.imageMime || result?.image?.mimeType || '').toLowerCase()
  if (VISION_FEEDBACK_MIMES.has(explicit)) return explicit
  if (name === 'image_transform') {
    return VISION_FEEDBACK_FORMAT_MIMES[String(result?.format || '').toLowerCase()] || null
  }
  const extension = path.extname(String(result?.fullPath || result?.output_path || result?.path || '')).toLowerCase()
  return VISION_FEEDBACK_EXT_MIMES[extension] || null
}

function stripLocalInternalFields(result) {
  if (!result || typeof result !== 'object') return result
  if (!('fullPath' in result) && !('imageMime' in result)) return result
  const next = { ...result }
  delete next.fullPath
  delete next.imageMime
  return next
}

/**
 * Attach a bounded base64 image so the model can visually verify tool output.
 * The absolute fullPath is never exposed to the model or persisted.
 */
async function attachVisionFeedback({ name, result, buffer = null }) {
  if (result?.ok !== true) return result
  const mimeType = visionFeedbackMime(name, result)
  if (!mimeType || !VISION_FEEDBACK_MIMES.has(mimeType)) return stripLocalInternalFields(result)
  const maxBytes = resolveVisionFeedbackMaxBytes()
  let bytes = buffer
  if (!bytes && result?.fullPath) {
    try {
      const stat = await fs.promises.stat(result.fullPath)
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return stripLocalInternalFields(result)
      bytes = await fs.promises.readFile(result.fullPath)
    } catch {
      return stripLocalInternalFields(result)
    }
  }
  const stripped = stripLocalInternalFields(result)
  if (!bytes || bytes.length <= 0 || bytes.length > maxBytes) return stripped
  return { ...stripped, image: { data: bytes.toString('base64'), mimeType, bytes: bytes.length } }
}

const SNAPSHOT_TOOL_NAMES = new Set(['write_file', 'edit_file'])

/**
 * Record a before-image for the most common file-mutating tools so a turn can
 * be rewound after the model edits the wrong file. Best-effort: snapshot
 * failures never block the real mutation.
 */
async function recordPreMutationSnapshot({ name, args, job, toolCallId }) {
  if (!job?.sessionId || !job?.id || !toolCallId || !SNAPSHOT_TOOL_NAMES.has(name)) return
  const rawPath = String(args?.path || '').trim()
  if (!rawPath) return
  let resolved
  try {
    resolved = resolveForFileTool(rawPath, { userId: job.userId, write: true, allowMissing: true })
  } catch {
    return
  }
  let beforeContent = null
  try {
    if (fs.existsSync(resolved.fullPath) && fs.statSync(resolved.fullPath).isFile()) {
      beforeContent = fs.readFileSync(resolved.fullPath)
    }
  } catch {
    return
  }
  try {
    recordFileSnapshot({
      userId: job.userId,
      sessionId: job.sessionId,
      turnId: job.id,
      toolCallId,
      toolName: name,
      filePath: resolved.fullPath,
      beforeContent,
    })
  } catch { /* snapshot is best-effort */ }
}

async function executeServerTool({
  name,
  args,
  job,
  step,
  signal,
  budget,
  skillId,
  approvalContext,
  allowedArtifactTools,
  toolCallId,
  idempotencyKey,
}) {
  const publishLiveOutput = (delta) => {
    if (job?.origin !== 'chat' || !job?.sessionId || !job?.id) return
    try {
      publishTurnActivity({
        userId: job.userId,
        activity: {
          sessionId: job.sessionId,
          turnId: job.id,
          kind: 'tool_output_delta',
          toolName: name,
          toolCallId: toolCallId || null,
          stream: delta?.stream || null,
          chunk: typeof delta?.chunk === 'string' ? delta.chunk.slice(0, 64 * 1024) : null,
        },
      })
    } catch { /* Live output is best-effort and must never fail the tool. */ }
  }

  if (isFileArtifactTool(name) && !allowedArtifactTools?.has(name)) {
    return {
      ok: false,
      code: 'artifact_tool_not_requested',
      error: `用户没有明确要求生成 ${name} 文件，本轮拒绝执行。`,
      retryable: false,
    }
  }
  if (name === 'bash_background') {
    try {
      const process = startBackgroundProcess({
        userId: job?.userId || null,
        sessionId: job?.sessionId || null,
        turnId: job?.id || null,
        toolCallId: toolCallId || null,
        command: args?.command,
        cwd: args?.cwd || undefined,
      })
      return { ok: true, processId: process.id, pid: process.pid, logPath: process.logPath, status: process.status }
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'bash_background_failed' })
    }
  }
  if (name === 'process_list') {
    try {
      const processes = listBackgroundProcesses({ userId: job?.userId || null })
      return { ok: true, processes }
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'process_list_failed' })
    }
  }
  if (name === 'process_kill') {
    try {
      const process = killBackgroundProcess({ userId: job?.userId || null, id: args?.process_id })
      if (!process) return { ok: false, code: 'PROCESS_NOT_FOUND', error: '后台进程不存在', retryable: false }
      return { ok: true, process }
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'process_kill_failed' })
    }
  }
  if (name === 'rewind_files') {
    if (!job?.sessionId || !job?.id) {
      return { ok: false, code: 'REWIND_TARGET_UNAVAILABLE', error: '回退目标上下文不可用' }
    }
    try {
      const result = rewindFromToolCall({
        userId: job.userId,
        sessionId: job.sessionId,
        turnId: job.id,
        toolCallId: typeof args?.tool_call_id === 'string' && args.tool_call_id.trim()
          ? args.tool_call_id.trim()
          : null,
      })
      if (!result.found) {
        return {
          ok: false,
          code: 'REWIND_SNAPSHOT_NOT_FOUND',
          error: '本轮没有可回退的文件变更快照',
          retryable: false,
        }
      }
      return {
        ok: true,
        rewound: result.count,
        files: result.rewound.map((entry) => ({ path: entry.snapshot.filePath, action: entry.action })),
      }
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'rewind_files_failed' })
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
    return await attachVisionFeedback({
      name,
      buffer: generated.buffer,
      result: {
        ok: true,
        artifactId: artifact.id,
        filename: artifact.filename,
        url: artifact.url,
        revisedPrompt: generated.revisedPrompt,
        imageMime: generated.mimeType,
      },
    })
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
      await recordPreMutationSnapshot({ name, args, job, toolCallId })
      return await dispatchFsShellTool(name, args || {}, {
        userId: job?.userId || null,
        signal,
        toolCallId,
        idempotencyKey,
        onOutput: publishLiveOutput,
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
      const result = await dispatchImageTool(name, args || {}, { userId: job?.userId || null, signal })
      return await attachVisionFeedback({ name, result })
    } catch (err) {
      return normalizeToolError(err, { fallbackCode: 'image_tool_failed' })
    }
  }
  if (MEDIA_TOOL_NAMES.has(name)) {
    try {
      const result = await dispatchMediaTool(name, args || {}, { userId: job?.userId || null, signal, onOutput: publishLiveOutput })
      return await attachVisionFeedback({ name, result })
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
  if (CODING_AGENT_TOOL_NAMES.has(name)) {
    try {
      return await dispatchCodingAgentTool(name, args || {}, {
        userId: job?.userId || null,
        signal,
        toolCallId,
        idempotencyKey,
      })
    } catch (err) {
      return {
        ...normalizeToolError(err, { fallbackCode: 'coding_tool_failed' }),
        ...(err?.path ? { path: err.path } : {}),
        ...(err?.hint ? { hint: err.hint } : {}),
      }
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
        request: buildSubagentRequest(
          args,
          job?.modelName,
          inheritedJobSkillIds(job, skillId),
          job?.skillDefinitions,
        ),
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
  if (['git_status', 'git_diff', 'run_project_check', 'git_commit', 'git_push', 'git_rollback', 'git_write'].includes(name)) {
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

export {
  FS_SHELL_TOOL_NAMES,
  IMAGE_TOOL_NAMES,
  MEDIA_TOOL_NAMES,
  PDF_TOOL_NAMES,
  BATCH_FILE_TOOL_NAMES,
  CODING_AGENT_TOOL_NAMES,
  COMMAND_EXECUTION_TOOL_NAMES,
  COMMAND_OUTPUT_TOOL_NAMES,
  LOCAL_ARTIFACT_TOOL_NAMES,
  MAX_ITERS,
  JOB_READ_CONCURRENCY,
  ARTIFACT_DELIVERY_GUARD_MARKER,
  MAX_ARTIFACT_DELIVERY_RETRIES,
  EXECUTION_EVIDENCE_GUARD_MARKER,
  EXECUTION_REASONING_RECOVERY_MARKER,
  DIRECTORY_RESUME_GUARD_MARKER,
  AVAILABLE_TOOL_CAPABILITIES_MARKER,
  POST_MUTATION_VERIFICATION_GUARD_MARKER,
  PDF_LAYOUT_EXECUTION_CONTRACT_MARKER,
  PDF_LAYOUT_VERIFICATION_GUARD_MARKER,
  PDF_LAYOUT_VERIFICATION_OK,
  MAX_EXECUTION_EVIDENCE_RETRIES,
  MAX_EXECUTION_REASONING_RETRIES,
  MAX_DIRECTORY_RESUME_RETRIES,
  MAX_MUTATION_VERIFICATION_RETRIES,
  MAX_PDF_LAYOUT_VERIFICATION_RETRIES,
  VERIFIED_DIRECTORY_RESOLUTION,
  DIRECTORY_AUTHORIZATION_WAIT_CLAIM,
  EXPLICIT_LOCAL_DIRECTORY_CONTEXT,
  MANAGED_ATTACHMENT_MARKER,
  LOCAL_MUTATION_TOOLS,
  PROJECT_SCOPE_TARGET,
  VERIFICATION_TOOLS,
  SHELL_VERIFICATION_COMMAND,
  SHELL_PROJECT_CHECK_COMMAND,
  POWERSHELL_READ_ONLY_COMMAND,
  POWERSHELL_MUTATION_COMMAND,
  PYTHON_INLINE_READ_EVIDENCE,
  PYTHON_INLINE_MUTATION,
  PYTHON_PATH_OPEN_MUTATION,
  PYTHON_PRINT_FILE_MUTATION,
  SCHEDULED_WAIT_INTENT,
  CLARIFICATION_CAPABILITY_CONTEXT,
  EXPLICIT_TOOLSET_CONTEXT,
  CLARIFICATION_CAPABILITY_DENIAL,
  CODE_EXECUTION_CAPABILITY,
  FILE_WRITE_CAPABILITY,
  FILE_WRITE_TOOL_NAMES,
  PDF_DOCUMENT_REFERENCE,
  PDF_LAYOUT_MUTATION_INTENT,
  PDF_LAYOUT_VALIDATOR_COMMAND,
  PATH_AUTHORIZATION_FAILURE_CODES,
  PERMISSION_CLARIFICATION,
  TOOL_AUTHORING_FAILURE_CODES,
  FAILURE_RECOVERY_MARKER,
  FAILURE_RECOVERY_THRESHOLD,
  EXECUTION_CONVERGENCE_MARKER,
  REPEAT_CALL_GUARD_MARKER,
  EXECUTION_CONVERGENCE_ROUND_THRESHOLD,
  MAX_INSTALL_ATTEMPT_SIGNATURES,
  PROBE_SCRIPT_PATH,
  PROBE_SCRIPT_REFERENCE,
  ENVIRONMENT_PROBE_COMMAND,
  NON_REFLECTIVE_FAILURE_CODES,
  toolNameFromSpec,
  isCommandExecutionTool,
  commandExecutionToolNames,
  hasCommandExecutionTool,
  commandExecutionToolLabel,
  parseToolResultMessage,
  isPathAuthorizationFailure,
  findPathAuthorizationFailures,
  hasConcreteToolFailure,
  contradictedCapabilityClarification,
  isSuccessfulToolResult,
  requestedPdfSectionLabel,
  shouldRequirePdfLayoutVerification,
  buildPdfLayoutExecutionContract,
  isSuccessfulPdfLayoutVerification,
  restoreFailureRecovery,
  serializeFailureRecovery,
  normalizeProbePath,
  probePathsFromCall,
  installAttemptSignature,
  hasInlinePythonMutation,
  isProbeLikeCall,
  isExplorationOnlyCall,
  restoreExecutionConvergence,
  serializeExecutionConvergence,
  isProductiveExecutionOutcome,
  shouldReflectOnFailure,
  progressChangesFor,
  inlinePythonCode,
  isReadOnlyPythonVerificationCall,
  powerShellCommandScript,
  isReadOnlyPowerShellVerificationCall,
  isLocalMutationCall,
  isVerificationCall,
  isMutationExecutionCall,
  normalizeMutationTarget,
  targetsMatch,
  clearWorkspaceScopedMutationTargets,
  shellTargetWithCwd,
  looksLikeDeletionCommand,
  tokenizeStaticDeletionCommand,
  isAllowedWindowsDeletionSwitch,
  isStaticDeletionTarget,
  staticWindowsDeletionTargets,
  isAllowedUnixDeletionSwitch,
  staticUnixDeletionTargets,
  parseStaticPowerShellRemoveItem,
  staticPowerShellDeletionTargets,
  staticDeletionTargets,
  extractInlinePythonMutationTargets,
  extractShellMutationTargets,
  extractMutationTargets,
  readResultCanVerifyMutation,
  addVerificationTarget,
  diffVerificationTargets,
  powerShellVerificationTargets,
  listDirectoryVerificationTargets,
  clearVerifiedDeletionTargets,
  clearExplicitTargetsMatchingEvidence,
  clearTargetsMatchingEvidence,
  clearVerifiedMutationTargets,
  artifactDeliveryError,
  persistGeneratedArtifact,
  localArtifactCandidates,
  resolveLocalArtifactSource,
  persistLocalToolArtifactsAsync,
  DIRECTORY_REVIEW_GUARD_MARKER,
  LIVE_STEERING_GUARD_MARKER,
  DIRECTORY_REVIEW_INTENT,
  TEXT_FILE,
  SENSITIVE_FILE,
  joinLocalPath,
  pickRepresentativeFiles,
  buildRepresentativeReadCalls,
  successfulReadFileInMessages,
  VISION_FEEDBACK_MIMES,
  VISION_FEEDBACK_FORMAT_MIMES,
  VISION_FEEDBACK_EXT_MIMES,
  resolveVisionFeedbackMaxBytes,
  visionFeedbackMime,
  stripLocalInternalFields,
  attachVisionFeedback,
  SNAPSHOT_TOOL_NAMES,
  recordPreMutationSnapshot,
  executeServerTool,
  textToolCallScope,
  supportsIdempotentResume,
}
