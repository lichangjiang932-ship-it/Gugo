// ★ 从 200 提到 2000 并可配。200 轮对「读完一个中型项目再逐个文件改」
// 是够不到的:光探索就可能几十轮,真正动手改又是几十轮,
// 中间还要穿插验证。碰到上限时用户看到的是「做到一半停了」。
// 2000 是任何正常任务都碰不到、但仍能兜住死循环的量级。
export const MAX_ITERS = (() => {
  const raw = Number(process.env.JOB_MAX_ITERS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000
})()
export const JOB_READ_CONCURRENCY = 3
export const ARTIFACT_DELIVERY_GUARD_MARKER = '[PERSISTED ARTIFACT DELIVERY REQUIRED]'
// A completion guard must actively recover the requested file instead of
// merely detecting that a model ignored the tool contract once. The runtime
// uses these attempts with a forced tool choice and persists the counter, so
// this remains bounded across restarts while giving weaker/local models enough
// room to repair malformed arguments after the first forced call.
export const MAX_ARTIFACT_DELIVERY_RETRIES = 4
export const EXECUTION_EVIDENCE_GUARD_MARKER = '[EXECUTION EVIDENCE REQUIRED]'
export const EXECUTION_REASONING_RECOVERY_MARKER = '[EXECUTION REASONING RECOVERY REQUIRED]'
export const DIRECTORY_RESUME_GUARD_MARKER = '[VERIFIED DIRECTORY RESUME REQUIRED]'
export const AVAILABLE_TOOL_CAPABILITIES_MARKER = '[AVAILABLE TOOL CAPABILITIES]'
export const POST_MUTATION_VERIFICATION_GUARD_MARKER = '[POST-MUTATION VERIFICATION REQUIRED]'
export const PDF_LAYOUT_EXECUTION_CONTRACT_MARKER = '[PDF LAYOUT EXECUTION CONTRACT]'
export const PDF_LAYOUT_VERIFICATION_GUARD_MARKER = '[PDF LAYOUT VERIFICATION REQUIRED]'
export const PDF_LAYOUT_VERIFICATION_OK = 'PDF_LAYOUT_VERIFICATION_OK'
export const MAX_EXECUTION_EVIDENCE_RETRIES = 1
export const MAX_EXECUTION_REASONING_RETRIES = 2
export const MAX_DIRECTORY_RESUME_RETRIES = 2
export const MAX_MUTATION_VERIFICATION_RETRIES = 2
export const MAX_PDF_LAYOUT_VERIFICATION_RETRIES = 2
export const VERIFIED_DIRECTORY_RESOLUTION = /\[(?:TURN|JOB_DIRECTORY)_RESOLUTION:[^\]]+\][^\r\n]*local directory authorization is already persisted and verified\./i
export const DIRECTORY_AUTHORIZATION_WAIT_CLAIM = /(?:please\s+(?:choose|select|authorize|grant)[\s\S]{0,100}(?:directory|folder)|(?:i(?:'m| am)?\s+)?wait(?:ing)?[\s\S]{0,100}(?:authori[sz]ation|permission|directory|folder)|(?:directory|folder)[\s\S]{0,100}(?:authorization|permission)[\s\S]{0,100}(?:required|pending|choose|select|grant)|\u8bf7[\s\S]{0,40}(?:\u9009\u62e9|\u6388\u6743)[\s\S]{0,40}(?:\u76ee\u5f55|\u6587\u4ef6\u5939)|(?:\u76ee\u5f55|\u6587\u4ef6\u5939)[\s\S]{0,40}(?:\u6388\u6743|\u6743\u9650)[\s\S]{0,40}(?:\u8bf7\u6c42|\u7b49\u5f85|\u9009\u62e9|\u786e\u8ba4|\u9700\u8981|\u672a\u6388\u6743)|\u7b49\u5f85[\s\S]{0,40}(?:\u9009\u62e9|\u6388\u6743|\u76ee\u5f55|\u6587\u4ef6\u5939))/i
export const EXPLICIT_LOCAL_DIRECTORY_CONTEXT = /\[LOCAL PATH (?:ACCESS|REFERENCE)|\[VERIFIED LOCAL FILESYSTEM ACCESS\]|(?:^|[\s"'`])(?:[a-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|\/(?:home|users|workspace|mnt|tmp)\/)|(?:save|write|export).{0,40}(?:folder|directory|desktop)|(?:\u4fdd\u5b58|\u5199\u5165|\u5bfc\u51fa).{0,20}(?:\u76ee\u5f55|\u6587\u4ef6\u5939|\u684c\u9762)/im
export const MANAGED_ATTACHMENT_MARKER = /\[GUGO_MANAGED_ATTACHMENT\b|\[\u9644\u4ef6\s*:|attachment:\/\//i
export const LOCAL_MUTATION_TOOLS = new Set([
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
export const PROJECT_SCOPE_TARGET = '<workspace>'
export const VERIFICATION_TOOLS = new Set([
  'read_file',
  'list_directory',
  'grep_code',
  'find_symbol',
  'list_imports',
  'lsp',
  'git_status',
  'git_diff',
  'run_project_check',
  'image_info',
  'media_probe',
  'pdf_info',
  'pdf_text',
  'archive_list',
])
export const SHELL_VERIFICATION_COMMAND = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check|typecheck)\b|(?:^|\s)(?:pytest|vitest|jest|eslint|tsc|cargo\s+(?:test|check)|go\s+test|dotnet\s+test)\b|(?:^|\s)git\s+(?:status|diff)\b/i
export const SHELL_PROJECT_CHECK_COMMAND = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check|typecheck)\b|(?:^|\s)(?:pytest|vitest|jest|eslint|tsc|cargo\s+(?:test|check)|go\s+test|dotnet\s+test)\b/i
export const POWERSHELL_READ_ONLY_COMMAND = /\b(?:Get-Content|Get-FileHash|Get-ChildItem|Get-Item|Test-Path|Select-String|Measure-Object|Compare-Object)\b/i
export const POWERSHELL_MUTATION_COMMAND = /\b(?:Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|Set-Item|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Acl|Start-Process|Invoke-Expression)\b|(?:^|[^>])>{1,2}(?!=)/i
export const PYTHON_INLINE_READ_EVIDENCE = /(?:\b(?:fitz|pymupdf)\.open\s*\(|\bImage\.open\s*\(|\bopen\s*\(|\bos\.path\.(?:exists|isfile|getsize)\s*\(|\bPath\s*\([^)]*\)\.(?:exists|is_file|stat|read_text|read_bytes)\s*\(|\.read\s*\(|\.verify\s*\()/i
export const PYTHON_INLINE_MUTATION = /(?:\bopen\s*\([^)]*(?:,\s*['"][^'"]*[wax+]|\bmode\s*=\s*['"][^'"]*[wax+])|\bos\.open\s*\(|\.(?:write|writelines|truncate|write_text|write_bytes|save|saveIncr|insert_text|insert_image|new_page|delete_page|touch|mkdir|unlink|rename|replace|chmod)\s*\(|\b(?:os\.(?:remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|chmod|utime|symlink|link)|shutil\.(?:copy|copy2|copyfile|move|rmtree|make_archive|unpack_archive)|subprocess\.|eval\s*\(|exec\s*\()|(?:^|[;\s])(?:remove|unlink|rename|replace)\s*\()/i
export const PYTHON_PATH_OPEN_MUTATION = /\.\s*open\s*\(\s*(?:mode\s*=\s*)?(['"])(?=[rwaxtb+u]*[wax+])[rwaxtb+u]+\1/i
export const PYTHON_PRINT_FILE_MUTATION = /\bprint\s*\([^;\r\n]{0,1000}\bfile\s*=/i
export const SCHEDULED_WAIT_INTENT = /\b(?:sleep|wait|wake|schedule|delay|follow[- ]?up|remind)\b|(?:\u7b49\u5f85|\u5ef6\u8fdf|\u5b9a\u65f6|\u5230\u65f6|\u5524\u9192|\u63d0\u9192|\u7a0d\u540e\u7ee7\u7eed)/i
export const CLARIFICATION_CAPABILITY_CONTEXT = /(?:tool(?:set|s)?|capabilit(?:y|ies)|runtime|environment|\u5de5\u5177(?:\u96c6|\u5217\u8868|\u80fd\u529b)?|\u8fd0\u884c\u65f6|\u73af\u5883)/i
export const EXPLICIT_TOOLSET_CONTEXT = /(?:tool(?:set|s)?|capabilit(?:y|ies)|\u5de5\u5177(?:\u96c6|\u5217\u8868|\u80fd\u529b)?)/i
export const CLARIFICATION_CAPABILITY_DENIAL = /(?:do(?:es)?\s+not\s+have|cannot|can't|lack(?:s|ing)?|missing|unavailable|not\s+available|limited|limitation|\u6ca1\u6709|\u7f3a\u5c11|\u4e0d\u5177\u5907|\u4e0d\u53ef\u7528|\u672a\u63d0\u4f9b|\u65e0\u6cd5|\u53d7\u9650|\u9650\u5236)/i
export const CODE_EXECUTION_CAPABILITY = /(?:code\s+execution|execute\s+code|run\s+(?:code|scripts?)|shell|terminal|command\s+execution|python|node\.?(?:js)?|\u4ee3\u7801\u6267\u884c|\u6267\u884c\u4ee3\u7801|\u8fd0\u884c\u4ee3\u7801|\u8fd0\u884c\u811a\u672c|\u547d\u4ee4\u884c|\u7ec8\u7aef|\u811a\u672c)/i
export const FILE_WRITE_CAPABILITY = /(?:file\s+(?:write|edit|modif|generat)|(?:write|edit|modify|generate|create).{0,24}(?:files?|documents?|images?|pdf|png|jpe?g)|document\s+generation|filesystem\s+write|\u6587\u4ef6\u5199\u5165|\u5199\u5165\u6587\u4ef6|\u5199\u6587\u4ef6|\u7f16\u8f91\u6587\u4ef6|\u4fee\u6539\u6587\u4ef6|\u6587\u4ef6\u751f\u6210|\u751f\u6210\u6587\u4ef6|\u4ea7\u7269\u751f\u6210|(?:\u7f16\u8f91|\u4fee\u6539|\u751f\u6210|\u521b\u5efa|\u5199\u5165).{0,16}(?:pdf|png|jpe?g|\u56fe\u50cf|\u56fe\u7247|\u6587\u6863|\u6587\u4ef6))/i
export const FILE_WRITE_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'multi_edit',
  'image_transform',
  'media_transform',
  'pdf_transform',
])
export const PDF_DOCUMENT_REFERENCE = /(?:\.pdf\b|\bpdf\b|application\/pdf)/i
export const PDF_LAYOUT_MUTATION_INTENT = /(?:write|fill|insert|overlay|edit|modify|create|generate|render|export|save|\u5199\u5165|\u586b\u5199|\u586b\u5165|\u53e0\u52a0|\u7f16\u8f91|\u4fee\u6539|\u751f\u6210|\u6e32\u67d3|\u5bfc\u51fa|\u4fdd\u5b58)/i
// Keep this allowlist deliberately narrow. A validator may use the dedicated
// layout name or the comprehensive validator name used by the artifact flow,
// but an arbitrary verify_*.py command must not become trusted evidence.
export const PDF_LAYOUT_VALIDATOR_COMMAND = /(?:^|[\s&|])(?:(?:"[^"]*(?:python(?:3)?|py)(?:\.exe)?")|(?:[^\s"]*[\\/])?(?:python(?:3)?|py)(?:\.exe)?)\s+(?:"(?:[^"]*[\\/])?(?:verify[_-]?pdf[_-]?layout|verify[_-]?comprehensive)\.py"|'(?:[^']*[\\/])?(?:verify[_-]?pdf[_-]?layout|verify[_-]?comprehensive)\.py'|(?:[^\s;&|]*[\\/])?(?:verify[_-]?pdf[_-]?layout|verify[_-]?comprehensive)\.py)(?=$|[\s;&|])/i
export const PATH_AUTHORIZATION_FAILURE_CODES = new Set([
  'ABSOLUTE_PATH_REQUIRED',
  'PATH_NOT_AUTHORIZED',
  'PATH_NOT_WRITABLE',
  'FILESYSTEM_WRITE_DENIED',
  'ATTACHMENT_READ_ONLY',
])
export const PERMISSION_CLARIFICATION = /(?:permission|authori[sz](?:e|ation)|access\s+(?:was\s+)?denied|grant\s+(?:write\s+)?access|\u6743\u9650|\u6388\u6743|\u8bbf\u95ee\u88ab\u62d2\u7edd|\u5f00\u653e\u8bbf\u95ee)/i
export const TOOL_AUTHORING_FAILURE_CODES = new Set([
  'missing_tool_name',
  'unknown_tool',
  'tool_arguments_invalid',
  'tool_arguments_validation_failed',
  'tool_call_parse_error',
])
export const FAILURE_RECOVERY_MARKER = '[TOOL FAILURE RECOVERY REQUIRED]'
export const FAILURE_RECOVERY_THRESHOLD = 2
export const EXECUTION_CONVERGENCE_MARKER = '[EXECUTION CONVERGENCE REQUIRED]'
export const REPEAT_CALL_GUARD_MARKER = '[REPEAT CALL GUARD]'
export const EXECUTION_CONVERGENCE_ROUND_THRESHOLD = 3
export const MAX_INSTALL_ATTEMPT_SIGNATURES = 24
export const PROBE_SCRIPT_PATH = /(?:^|[\\/])(?:[._-]?(?:inspect|probe|diagnos(?:e|tic)|debug[-_]?env|check[-_]?env|env[-_]?check|test[-_]?(?:import|dependency)))(?:[-_.0-9][^\\/]*)?\.(?:py|m?js|cjs|ts|ps1|sh|cmd|bat)$/i
export const PROBE_SCRIPT_REFERENCE = /(?:^|[\s"'`])(?:[^\s"'`;|&]*[\\/])?(?:[._-]?(?:inspect|probe|diagnos(?:e|tic)|debug[-_]?env|check[-_]?env|env[-_]?check|test[-_]?(?:import|dependency)))(?:[-_.0-9][^\s"'`;|&]*)?\.(?:py|m?js|cjs|ts|ps1|sh|cmd|bat)(?=$|[\s"'`;|&])/i
export const ENVIRONMENT_PROBE_COMMAND = /(?:\b(?:python(?:3)?|py|node)\b[^\r\n;&|]{0,80}(?:--version|-V\b|\s-c\s+)[^\r\n;&|]{0,240}(?:\bimport\b|find_spec|__version__|version)|\b(?:pip(?:3)?|python(?:3)?\s+-m\s+pip|py\s+-m\s+pip)\s+(?:show|list|check)\b|\b(?:npm|pnpm|yarn)\s+(?:list|ls|why)\b|\b(?:where(?:\.exe)?|which|Get-Command)\s+[^\r\n;&|]+)/i
export const NON_REFLECTIVE_FAILURE_CODES = new Set([
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
