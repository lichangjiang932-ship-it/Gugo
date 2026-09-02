/**
 * Agent 工具调用公共门面。
 *
 * 保留稳定导入路径；协议规范化、错误处理、结果消息和循环守卫分别位于
 * 专用纯函数模块中，供 job / subagent 等运行时复用。
 */
export {
  applyToolSchemaDefaults,
  buildAssistantToolCallsMessage,
  normalizeToolCalls,
  parseToolArguments,
  repairTruncatedJsonObject,
  validateToolCall,
} from './toolCallArguments.js'

export {
  executeToolWithRetry,
  isSafeToolRetry,
  mapWithConcurrency,
  normalizeToolError,
  normalizeToolResult,
  redactSensitiveText,
} from './toolCallErrors.js'

export {
  DEFAULT_TOOL_OUTPUT_CHARS,
  TOOL_OUTPUT_CONTEXT_CHARS_PER_TOKEN,
  TRUNCATED_TOOL_RESULT_METADATA_KEY,
  buildToolResultMessage,
  buildToolResultMessageBundle,
  buildToolResultMessages,
  isEphemeralToolMediaMessage,
  resolveToolResultMaxChars,
  serializeToolResult,
  stripEphemeralToolMediaMessages,
} from './toolCallResults.js'

export {
  createToolLoopGuard,
  isSubstantiveToolCall,
} from './toolLoopGuard.js'
