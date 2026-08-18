import {
  isFileArtifactTool,
} from '../../artifactIntent.js'
import {
  CLARIFICATION_CAPABILITY_CONTEXT,
  CLARIFICATION_CAPABILITY_DENIAL,
  CODE_EXECUTION_CAPABILITY,
  EXPLICIT_TOOLSET_CONTEXT,
  FILE_WRITE_CAPABILITY,
  FILE_WRITE_TOOL_NAMES,
  PATH_AUTHORIZATION_FAILURE_CODES,
  PDF_DOCUMENT_REFERENCE,
  PDF_LAYOUT_EXECUTION_CONTRACT_MARKER,
  PDF_LAYOUT_MUTATION_INTENT,
  PDF_LAYOUT_VALIDATOR_COMMAND,
  PDF_LAYOUT_VERIFICATION_OK,
  PERMISSION_CLARIFICATION,
  TOOL_AUTHORING_FAILURE_CODES,
} from './constants.js'
import {
  isCommandExecutionTool,
  toolNameFromSpec,
} from './commandCapabilities.js'
import {
  isReadOnlyPythonVerificationCall,
} from './mutationClassification.js'
import {
  isSuccessfulToolResult,
} from './resultStatus.js'

export {
  commandExecutionToolLabel,
  commandExecutionToolNames,
  hasCommandExecutionTool,
  isCommandExecutionTool,
  toolNameFromSpec,
} from './commandCapabilities.js'

export {
  isSuccessfulToolResult,
} from './resultStatus.js'

export function parseToolResultMessage(message) {
  if (message?.role !== 'tool') return null
  try {
    const result = JSON.parse(String(message.content || '{}'))
    return result && typeof result === 'object' ? result : null
  } catch {
    return null
  }
}

export function isPathAuthorizationFailure(result) {
  const code = String(result?.code || '').trim().toUpperCase()
  return PATH_AUTHORIZATION_FAILURE_CODES.has(code)
    || Boolean(result?.suggestGrantPath)
    || ['read_only', 'read_write'].includes(String(result?.requiredAccessMode || ''))
}

export function findPathAuthorizationFailures(messages) {
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

export function hasConcreteToolFailure(messages, names) {
  const relevant = new Set(names)
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (message?.role !== 'tool' || !relevant.has(String(message?.name || ''))) return false
    const result = parseToolResultMessage(message)
    return result?.ok === false
      && !TOOL_AUTHORING_FAILURE_CODES.has(String(result?.code || ''))
      && !isPathAuthorizationFailure(result)
  })
}

export function contradictedCapabilityClarification(args, toolSpecs, messages = []) {
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

export function requestedPdfSectionLabel(text) {
  const input = String(text || '')
  const match = input.match(/\b(?:ielts\s+)?(?:writing\s+)?task\s*([12])\b/i)
  if (match) return `Writing Task ${match[1]}`
  const chinese = input.match(/(?:\u5199\u4f5c)?\u4efb\u52a1\s*([\u4e00\u4e8c12])/u)
  if (!chinese) return ''
  const number = chinese[1] === '\u4e00' ? '1' : chinese[1] === '\u4e8c' ? '2' : chinese[1]
  return `Writing Task ${number}`
}

export function shouldRequirePdfLayoutVerification(text) {
  const input = String(text || '')
  return PDF_DOCUMENT_REFERENCE.test(input) && PDF_LAYOUT_MUTATION_INTENT.test(input)
}

export function buildPdfLayoutExecutionContract(text) {
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

export function isSuccessfulPdfLayoutVerification(call, result) {
  if (!isCommandExecutionTool(call) || !isSuccessfulToolResult(result)) return false
  if (Array.isArray(call?.args?.expected_outputs) && call.args.expected_outputs.length > 0) return false
  const command = String(call?.args?.command || '')
  if (command.includes(PDF_LAYOUT_VERIFICATION_OK)) return false
  const output = `${String(result?.stdout || '')}\n${String(result?.stderr || '')}`
  if (!new RegExp(`(?:^|\\r?\\n)${PDF_LAYOUT_VERIFICATION_OK}(?:\\r?\\n|$)`).test(output)) return false
  return PDF_LAYOUT_VALIDATOR_COMMAND.test(command) || isReadOnlyPythonVerificationCall(call)
}
