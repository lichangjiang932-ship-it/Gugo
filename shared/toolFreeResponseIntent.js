// This is a restriction on the current user request, not a tool authorization
// heuristic. Callers must supply user-authored text, never model/tool summaries.
const QUOTED_MATERIAL = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\r\n]*`|"[^"\r\n]*"|(?<![\p{L}\p{N}])'[^'\r\n]*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|^\s*>[^\r\n]*/gmu
const CLAUSE_BOUNDARY = /[。！？!?;；\r\n]+|\.(?=\s|$)|[,，]\s*|\b(?:and(?:\s+then)?|then|also|but|after|before|once)\s+|(?:然后|随后|接着|并且|同时|之后|后再)/giu
const INSTRUCTION_PREFIX = /^(?:(?:please|now|first|just|you\s+(?:must|should)|can\s+you|could\s+you|would\s+you)\s+|(?:请|你|现在|先|本轮|本次(?:任务|回复)?|这次|当前(?:任务|回合)|直接)\s*|(?:\d+[.)、]|[-*])\s*)*/iu
const GLOBAL_TOOL_PROHIBITION = /^(?:(?:do\s+not|don['’]?t|never|must\s+not|should\s+not|may\s+not|cannot)\s+(?:use|call|invoke|run|execute)\s+(?:(?:any|the|available|external)\s+)*tools?\b|(?:no\s+need\s+to|(?:there\s+is\s+)?no\s+need\s+to|(?:you\s+)?(?:do\s+not|don['’]?t)\s+need\s+to)\s+(?:use|call|invoke|run|execute)\s+(?:any\s+)?tools?\b|use\s+no\s+tools?\b|without\s+(?:(?:using|calling|invoking|running|executing)\s+)?(?:any\s+)?tools?\b|no\s+tool(?:s|\s+calls?)(?:\s+(?:are\s+)?(?:needed|required|allowed))?\s*[.:：!！。]*$|(?:不要|不许|不准|不得|禁止|请勿|勿|无需|不用|不必|不需要|不)(?:再|进行)?\s*(?:(?:使用|调用|执行|运行|用)\s*)?(?:任何|一切|所有|外部|可用的?)?\s*工具(?:调用)?(?:[。！!，,；;：:\s]|$)|工具(?:调用)?(?:都|一律)?(?:不要|不许|禁止|无需|不用)(?:使用|调用|执行|运行)?)/iu
const RESPONSE_WITHOUT_TOOLS = /^(?:reply|respond|answer)\b[^.!?;\r\n]{0,96}\bwithout\s+(?:(?:using|calling|invoking)\s+)?(?:any\s+)?tools?\b|^(?:回复|回答|答复)[^。！？；\r\n]{0,48}(?:不要|无需|不用|不需要)(?:使用|调用)?(?:任何)?工具/iu
const REPLY_ONLY_ORDER = /^(?:(?:only|just)\s+(?:reply|respond|answer|say)\b|(?:reply|respond|answer|say)\s+(?:only|just)\b|(?:只|仅|仅仅)(?:用(?:纯)?(?:文本|文字))?(?:回复|回答|答复))/iu
const TOOL_WORK_ORDER = /^(?:(?:run|execute|test|verify|check|read|open|inspect|review|search|browse|visit|click|install|deploy|send|publish|commit|push|delete|remove|rename|move|copy|edit|modify|fix|repair|harden|update|apply|build|create|make|generate|write|save|export|use|invoke|call)(?:s|d|ed|ing)?\b|(?:运行|执行|测试|验证|检查|读取|打开|查看|审查|搜索|浏览|访问|点击|安装|部署|发送|发布|提交|推送|删除|移除|重命名|移动|复制|编辑|修改|修复|更新|构建|创建|新建|制作|生成|写入|保存|导出|使用|调用)|(?:把|将)[^。！？!?\r\n]{1,80}(?:修改|修复|删除|写入|保存|导出|生成|改成|做成))/iu
const SCOPED_TOOL_RULE = /\b(?:external|remote|network|browser|shell|file|write|paid|dangerous)\s+tools?\b|\b(?:except|unless|other\s+than)\b|(?:外部|远程|网络|浏览器|写入|付费)工具|(?:除了|除非|以外|之外)/iu

function instructionClauses(text) {
  return String(text || '').replace(QUOTED_MATERIAL, (match) => ' '.repeat(match.length))
    .split(CLAUSE_BOUNDARY)
    .map((clause) => clause.trim().replace(INSTRUCTION_PREFIX, '').trim())
    .filter(Boolean)
}

/**
 * Explicitly forbidding tools always wins. A reply-only imperative also means
 * no tools unless a separate work order makes it an output-format constraint:
 * "Run tests, then reply only PASS" still authorizes the requested tests.
 * Quoted examples and negated reply-only orders never change permissions.
 */
export function isToolFreeResponseRequest(text = '') {
  const clauses = instructionClauses(text)
  if (clauses.some((clause) => !SCOPED_TOOL_RULE.test(clause)
    && (GLOBAL_TOOL_PROHIBITION.test(clause) || RESPONSE_WITHOUT_TOOLS.test(clause)))) return true
  const responseClauses = clauses.filter((clause) => REPLY_ONLY_ORDER.test(clause))
  if (responseClauses.length === 0) return false
  return !clauses.some((clause) => !REPLY_ONLY_ORDER.test(clause) && TOOL_WORK_ORDER.test(clause))
}
