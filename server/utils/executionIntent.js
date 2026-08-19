export const TURN_INTENT_MODES = Object.freeze(['auto', 'answer', 'execute'])

const TURN_INTENT_MODE_SET = new Set(TURN_INTENT_MODES)
const NUMBERED_STEP_LINE = /^(?:\d+[.)\u3001]|step\s+\d+|\u6b65\u9aa4\s*[0-9\u4e00-\u5341]+)\s*/i
const STEP_EXECUTION_ACTION = /\b(?:implement|integrate|execute|run|apply|fix|create|generate|build|write|save|export|install|enable|open|click|upload|download|delete|rename|move|copy|test|verify|check|update|refactor)\b|(?:\u5b9e\u73b0|\u96c6\u6210|\u63a5\u5165|\u542f\u7528|\u6267\u884c|\u8fd0\u884c|\u4fee\u6539|\u4fee\u590d|\u521b\u5efa|\u751f\u6210|\u6784\u5efa|\u5199\u5165|\u4fdd\u5b58|\u5bfc\u51fa|\u5b89\u88c5|\u6253\u5f00|\u70b9\u51fb|\u4e0a\u4f20|\u4e0b\u8f7d|\u6dfb\u52a0|\u589e\u52a0|\u53bb\u6389|\u79fb\u9664|\u5220\u9664|\u6302\u8f7d|\u5206\u914d|\u91cd\u547d\u540d|\u79fb\u52a8|\u590d\u5236|\u6d4b\u8bd5|\u9a8c\u8bc1|\u68c0\u67e5|\u66f4\u65b0|\u91cd\u6784)/i
const DIRECT_EXECUTION_INTENT = /(?:\b(?:implement|execute|run|apply|fix|create|generate|build|write|save|export)\b|(?:\u5b9e\u73b0|\u6267\u884c|\u8fd0\u884c|\u4fee\u590d|\u521b\u5efa|\u751f\u6210|\u6784\u5efa|\u5199\u5165|\u4fdd\u5b58|\u5bfc\u51fa|\u4fee\u6539))(?:[\s\S]{0,160})(?:\b(?:file|page|app|project|script|document|artifact)\b|(?:\u6587\u4ef6|\u7f51\u9875|\u9875\u9762|\u5e94\u7528|\u9879\u76ee|\u811a\u672c|\u6587\u6863|\u4ea7\u7269))/i
const EXTERNAL_ACTION_ORDER = /^(?:\s*(?:please|directly|help\s+(?:me\s+)?|can\s+you|could\s+you|would\s+you|will\s+you)){0,3}\s*(?:send|notify)\b|^\s*(?:(?:\u8bf7|\u76f4\u63a5|\u5e2e\u6211|\u7ed9\u6211|\u4f60\u80fd|\u4f60\u53ef\u4ee5|\u53ef\u4ee5|\u80fd\u5426|\u9ebb\u70e6\u4f60)\s*){0,3}(?:\u53d1\u9001|\u901a\u77e5)/i
const EXTERNAL_MUTATION_INTENT = /\b(?:send|notify|post|publish)\b|(?:\u53d1\u9001|\u901a\u77e5|\u53d1\u5e03)/i
const MUTATION_EXECUTION_INTENT = /\b(?:implement|integrate|enable|apply|fix|handle|resolve|create|generate|build|write|edit|change|adjust|tweak|revise|replace|overwrite|save|export|install|remove|delete|rename|move|copy|update|modify|patch|refactor|improve|optimize|finish|complete)\b|\b(?:wire\s+in|take\s+care\s+of|sort\s+out)\b|(?:\u5b9e\u73b0|\u96c6\u6210|\u63a5\u5165|\u542f\u7528|\u4fee\u6539|\u7f16\u8f91|\u6539\u4e00\u4e0b|\u6539\u597d|\u6539\u6210|\u6539\u52a8|\u4fee\u590d|\u4fee\u597d|\u8c03\u6574|\u5904\u7406|\u521b\u5efa|\u65b0\u5efa|\u751f\u6210|\u6784\u5efa|\u5199\u5165|\u4fdd\u5b58|\u8986\u76d6|\u66ff\u6362|\u6dfb\u52a0|\u589e\u52a0|\u8865\u4e0a|\u53bb\u6389|\u79fb\u9664|\u5bfc\u51fa|\u5b89\u88c5|\u5220\u9664|(?:\u6309\u9700)?\u6302\u8f7d|\u5206\u914d|\u91cd\u547d\u540d|\u79fb\u52a8|\u590d\u5236|\u66f4\u65b0|\u6253\u8865\u4e01|\u91cd\u6784|\u4f18\u5316|\u5b8c\u5584|\u8865\u5168|\u641e\u5b9a|\u89e3\u51b3)/i
const NEGATED_MUTATION_CLAUSE = /(?:(?:\b(?:do\s+not|don't|never|without|no\s+need\s+to|must\s+not)\b)|(?:\u4e0d\u8981|\u65e0\u9700|\u4e0d\u5fc5|\u4e0d\u5f97|\u7981\u6b62))[^,.;\uff0c\u3002\uff1b\r\n]{0,120}?(?:\b(?:re-?generate|regenerate|rewrite|implement|integrate|enable|apply|fix|create|generate|build|write|edit|change|adjust|tweak|revise|replace|overwrite|save|export|install|remove|delete|rename|move|copy|update|modify|patch|refactor|improve|optimize)(?:s|d|ed|ing)?\b|(?:\u5b9e\u73b0|\u96c6\u6210|\u63a5\u5165|\u542f\u7528|\u4fee\u6539|\u7f16\u8f91|\u6539\u4e00\u4e0b|\u6539\u597d|\u6539\u6210|\u6539\u52a8|\u4fee\u590d|\u4fee\u597d|\u8c03\u6574|\u5904\u7406|\u521b\u5efa|\u65b0\u5efa|\u751f\u6210|\u6784\u5efa|\u5199\u5165|\u4fdd\u5b58|\u8986\u76d6|\u66ff\u6362|\u53bb\u6389|\u79fb\u9664|\u5bfc\u51fa|\u5b89\u88c5|\u5220\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u590d\u5236|\u66f4\u65b0|\u6253\u8865\u4e01|\u91cd\u6784|\u4f18\u5316|\u505a\u6210|\u6539\u9020(?:\u6210|\u4e3a)?))[^,.;\uff0c\u3002\uff1b\r\n]{0,120}/giu
const NEGATED_ROUTING_MUTATION_CLAUSE = /(?:\u4e0d\u8981|\u65e0\u9700|\u4e0d\u5fc5|\u4e0d\u5f97|\u7981\u6b62)[^,.;\uff0c\u3002\uff1b\r\n]{0,120}?(?:\u6dfb\u52a0|\u589e\u52a0|\u8865\u4e0a|(?:\u6309\u9700)?\u6302\u8f7d|\u5206\u914d)[^,.;\uff0c\u3002\uff1b\r\n]{0,120}/giu
const NEGATED_REWIND_MUTATION_CLAUSE = /(?:(?:\b(?:do\s+not|don't|never|without|must\s+not)\b)|(?:\u4e0d\u8981|\u65e0\u9700|\u4e0d\u5fc5|\u4e0d\u5f97|\u7981\u6b62))(?:\.(?=[a-z0-9]{1,12}\b)|[^,.;\uff0c\u3002\uff1b\r\n]){0,120}?(?:\b(?:revert|undo|rollback|restore)\b|(?:\u56de\u6eda|\u64a4\u9500|\u6062\u590d\u539f\u72b6|\u8fd8\u539f))(?:\.(?=[a-z0-9]{1,12}\b)|[^,.;\uff0c\u3002\uff1b\r\n]){0,120}/giu
const FILE_TARGET_REFERENCE = /(?:^|[\s"'`(])(?:[a-z]:[\\/]|\.\.?[\\/]|\/)?(?:[\p{L}\p{N}_@%+.,()[\]{} -]+[\\/])*[\p{L}\p{N}_@%+.,()[\]{} -]+\.[a-z0-9]{1,12}(?=$|[\s"'`),;:，。；：！？])/iu
// 纯文本交付物对象:「生成一份周报/写一段文案」是文字产出,不写文件。
// 生成/创建/写 类动词 + 这些对象 + 没有文件路径时,不该按「文件修改任务」
// 要求工具执行证据 —— 否则纯文本任务永远以 execution_evidence_missing 收尾。
// 注意不要包含「内容/说明/报告」这类可能出现在动作句里的宽泛词
// (如「写入内容」「检查结果」是动作,不是文本交付物)。
const TEXT_DELIVERABLE_TARGET = /(?:\u5468\u62a5|\u65e5\u62a5|\u6708\u62a5|\u603b\u7ed3\u62a5\u544a|\u5de5\u4f5c\u603b\u7ed3|\u603b\u7ed3|\u6982\u8981|\u6587\u6848|\u6587\u7ae0|\u6f14\u8bb2\u7a3f|\u90ae\u4ef6|\u7b80\u5386|\u65b9\u6848|\u8ba1\u5212|\u63d0\u7eb2|\u5927\u7eb2|\u6807\u9898|\u53e3\u53f7|\u6545\u4e8b|\u8bd7\u6b4c|\u8bfb\u4e66\u7b14\u8bb0|\u5fc3\u5f97\u4f53\u4f1a)/i
const IMPERATIVE_EXECUTION_INTENT = /(?:^|[\s,，。；;!！])(?:(?:please\s+|continue\s+|go\s+ahead\s+|help\s+(?:me\s+)?|\u8bf7|\u7ee7\u7eed|\u76f4\u63a5|\u5e2e\u6211|\u628a|\u5c06|\u7ed9\u6211|\u518d)\s*){0,3}(?:implement|integrate|enable|wire\s+in|fix|optimize|improve|finish|complete|update|modify|edit|change|adjust|tweak|revise|replace|overwrite|refactor|build|create|generate|write|save|export|run|execute|apply|install|remove|delete|rename|move|upload|publish|deploy|commit|push|\u5b8c\u5584|\u4f18\u5316|\u4fee\u590d|\u4fee\u597d|\u5904\u7406|\u7f16\u8f91|\u6539\u597d|\u6539\u4e00\u4e0b|\u6539\u6210|\u6539\u52a8|\u5b9e\u73b0|\u96c6\u6210|\u63a5\u5165|\u542f\u7528|\u8865\u5168|\u8865\u4e0a|\u89e3\u51b3|\u641e\u5b9a|\u68c0\u67e5|\u6392\u67e5|\u8c03\u6574|\u66f4\u65b0|\u5347\u7ea7|\u91cd\u6784|\u6574\u7406|\u521b\u5efa|\u65b0\u5efa|\u751f\u6210|\u6784\u5efa|\u5199\u5165|\u4fdd\u5b58|\u8986\u76d6|\u66ff\u6362|\u53bb\u6389|\u79fb\u9664|\u5bfc\u51fa|\u6267\u884c|\u8fd0\u884c|\u5b89\u88c5|\u5220\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u4e0a\u4f20|\u53d1\u5e03|\u90e8\u7f72|\u63d0\u4ea4|\u63a8\u9001)/i
const OBJECT_FIRST_EXECUTION_INTENT = /(?:^|[\s,，。；;!！])(?:\u8bf7|\u5e2e\u6211|\u7ee7\u7eed|\u76f4\u63a5)?\s*(?:\u628a|\u5c06).{1,80}(?:\u5904\u7406\u597d|\u6539\u597d|\u6539\u4e00\u4e0b|\u6539\u6210|\u6539\u52a8|\u5b8c\u5584|\u4f18\u5316|\u4fee\u590d|\u4fee\u597d|\u4fee\u6539|\u7f16\u8f91|\u5b9e\u73b0|\u96c6\u6210|\u63a5\u5165|\u542f\u7528|\u8865\u5168|\u89e3\u51b3|\u641e\u5b9a|\u8c03\u6574|\u66f4\u65b0|\u5347\u7ea7|\u91cd\u6784|\u6574\u7406|\u521b\u5efa|\u65b0\u5efa|\u751f\u6210|\u6784\u5efa|\u8986\u76d6|\u66ff\u6362|\u53bb\u6389|\u79fb\u9664|\u5220\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u4e0a\u4f20|\u53d1\u5e03|\u90e8\u7f72|\u63d0\u4ea4|\u63a8\u9001)/i
const OBJECT_TRANSFORMATION_EXECUTION_INTENT = /(?:^|[\s,，。；;!！])(?:\u8bf7|\u5e2e\u6211|\u7ee7\u7eed|\u76f4\u63a5)?\s*(?:\u628a|\u5c06)[^\u3002\uff01\uff1f!?\n]{1,96}?(?:\u505a\u6210|\u6539\u6210|\u6539\u4e3a|\u6539\u9020(?:\u6210|\u4e3a)|\u53d8\u6210|\u8f6c\u6210|\u8f6c\u4e3a)/i
const OBJECT_TAIL_EXECUTION_INTENT = /^(?![\s\S]{0,200}(?:\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u5982\u4f55|\u600e\u4e48|\u662f\u5426|\u80fd\u5426|\u4ec0\u4e48|\u5417|\u5462|[?\uff1f]))(?![\s\S]{0,80}(?:\u4f1a|\u5df2\u7ecf|\u6b63\u5728|\u66fe\u7ecf|\u81ea\u52a8)[\s\S]{0,24}(?:\u6dfb\u52a0|\u589e\u52a0|\u53bb\u6389|\u79fb\u9664|\u5220\u9664))[\s\S]{1,160}?(?:\u6dfb\u52a0|\u589e\u52a0|\u8865\u4e0a|\u53bb\u6389|\u79fb\u9664|\u5220\u9664)(?:[\s\S]{0,80})?[\u3002\uff01!]?\s*$/i
const ROUTING_IMPERATIVE_EXECUTION_INTENT = /(?:^|[\s,\uff0c\u3002\uff1b;!\uff01])(?:(?:\u8bf7|\u5e2e\u6211|\u76f4\u63a5|\u73b0\u5728|\u7ee7\u7eed|\u518d|\u8981)\s*){0,3}(?:\u4fee\u6539|\u6dfb\u52a0|\u589e\u52a0|\u8865\u4e0a|(?:\u6309\u9700)?\u6302\u8f7d|\u5206\u914d)/i
const REWIND_MUTATION_INTENT = /\b(?:rewrite|revert|undo|rollback)\b|\brestore\b[^.!?\r\n]{0,40}\b(?:file|change|edit|original|previous|state)\b|(?:\u56de\u6eda|\u64a4\u9500|\u6062\u590d\u539f\u72b6|\u8fd8\u539f(?:\u6587\u4ef6|\u6539\u52a8|\u4fee\u6539|\u66f4\u6539|\u539f\u72b6)?)/i
const REWIND_IMPERATIVE_EXECUTION_INTENT = /(?:^|[\s,\uff0c\u3002\uff1b;!\uff01])(?:(?:please|directly|now|then|\u8bf7|\u76f4\u63a5|\u73b0\u5728|\u7136\u540e|\u7ee7\u7eed)\s*){0,3}(?:(?:rewrite|revert|undo|rollback)\b|(?:\u56de\u6eda|\u64a4\u9500|\u6062\u590d\u539f\u72b6|\u8fd8\u539f))/i
const ANSWER_ONLY_LEAD = /^\s*(?:(?:\u6211(?:\u53ea\u662f)?\u60f3(?:\u77e5\u9053|\u4e86\u89e3|\u95ee(?:\u4e00\u4e0b)?)|\u53ea\u662f\u60f3(?:\u77e5\u9053|\u4e86\u89e3))\s*[,\uff0c\uff1a:]?\s*|(?:\u8bf7)?(?:\u89e3\u91ca|\u8bf4\u660e|\u4ecb\u7ecd|\u544a\u8bc9\u6211|\u6bd4\u8f83)|(?:\u4ec0\u4e48\u662f|\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u5982\u4f55|\u600e\u4e48|\u80fd\u5426|\u662f\u5426)|(?:what|why|how|explain|describe|compare|tell\s+me|can\s+you|could\s+you)\b)/i
const EXPLANATION_ONLY_LEAD = /^\s*(?:(?:\u6211(?:\u53ea\u662f)?\u60f3(?:\u77e5\u9053|\u4e86\u89e3|\u95ee(?:\u4e00\u4e0b)?)|\u53ea\u662f\u60f3(?:\u77e5\u9053|\u4e86\u89e3))\s*[,\uff0c\uff1a:]?\s*|(?:\u8bf7)?(?:\u89e3\u91ca|\u8bf4\u660e|\u4ecb\u7ecd|\u544a\u8bc9\u6211|\u6bd4\u8f83)|(?:\u4ec0\u4e48\u662f|\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u5982\u4f55|\u600e\u4e48)|(?:what|why|how|explain|describe|compare|tell\s+me)\b)/i
const FOLLOW_UP_EXECUTION = /(?:\u5e76\u4e14|\u5e76|\u7136\u540e|\u540c\u65f6|\u987a\u4fbf|and\s+then|then|also).{0,48}(?:(?:\u8bf7|\u5e2e\u6211|please|help\s+(?:me\s+)?)\s*)?(?:\u5b8c\u5584|\u4f18\u5316|\u4fee\u590d|\u5904\u7406|\u4fee\u6539|\u5b9e\u73b0|\u89e3\u51b3|\u6267\u884c|\u521b\u5efa|\u751f\u6210|fix|implement|apply|update|create|run)/i
const DELEGATED_EXECUTION_INTENT = /^(?:please\s+)?(?:handle|resolve|finish|complete|take\s+care\s+of|sort\s+out)\b|(?:\u4f60\u6765|\u4ea4\u7ed9\u4f60|\u7531\u4f60|\u9ebb\u70e6\u4f60|\u52b3\u70e6\u4f60|\u8bf7\u4f60|\u4f60(?:\u6839\u636e.{0,32})?\u6765(?:\u8fdb\u884c)?|\u4f60(?:\u76f4\u63a5|\u73b0\u5728\u5c31|\u8d1f\u8d23|\u8fdb\u884c)).{0,80}(?:\u5904\u7406\u597d|\u6539\u597d|\u5b8c\u5584|\u4f18\u5316|\u4fee\u590d|\u4fee\u6539|\u5b9e\u73b0|\u8865\u5168|\u89e3\u51b3|\u641e\u5b9a|\u8c03\u6574|\u66f4\u65b0|\u91cd\u6784|\u521b\u5efa|\u751f\u6210|\u6267\u884c)/i
const LOCAL_FILE_REQUIREMENTS_LEAD = /(?:\u73b0\u5728|\u63a5\u4e0b\u6765|\u53e6\u5916|\u6b64\u5916|\u7136\u540e)?\s*(?:\u6211\s*)?(?:\u8fd8\s*)?(?:\u6709|\u8865\u5145|\u63d0\u51fa)\s*(?:\u51e0\u4e2a|\u4ee5\u4e0b|\u8fd9\u4e9b|\u5982\u4e0b)?\s*(?:\u9700\u6c42|\u8981\u6c42|\u6539\u52a8|\u8c03\u6574)|(?:\u9700\u6c42|\u8981\u6c42|\u6539\u52a8|\u8c03\u6574)\s*(?:\u5982\u4e0b|\u6709)/i
const LOCAL_FILE_REQUIREMENTS_READ_ONLY = /(?:\u8bf7|\u53ea|\u4ec5)?\s*(?:\u5206\u6790|\u89e3\u91ca|\u8bf4\u660e|\u8bc4\u4f30|\u5ba1\u67e5|\u8ba8\u8bba|\u68b3\u7406|\u603b\u7ed3|\u5217\u51fa|\u8bc6\u522b)(?:\u4e00\u4e0b)?\s*(?:\u8fd9\u4e9b|\u4ee5\u4e0b|\u4e0a\u8ff0)?\s*(?:\u9700\u6c42|\u8981\u6c42)|(?:\u80fd\u5426|\u662f\u5426|\u53ef\u4e0d\u53ef\u4ee5|\u80fd\u4e0d\u80fd).{0,20}(?:\u6ee1\u8db3|\u5b9e\u73b0|\u5b8c\u6210|\u5904\u7406)?\s*(?:\u8fd9\u4e9b|\u4ee5\u4e0b)?\s*(?:\u9700\u6c42|\u8981\u6c42)/i
const NUMBERED_REQUIREMENT_ITEM = /(?:\d{1,2}[.)\u3001\uff0e](?!\d)|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]{1,3}[\u3001.\uff0e])/gu
const CAPABILITY_CHALLENGE_EXPLICIT_READ_ONLY = /\b(?:read[- ]only|no[- ]write)\b|(?:\u53ea\u8bfb|\u4ec5\u5206\u6790|\u53ea\u5206\u6790|\u53ea\u89e3\u91ca|\u4e0d\u8981\u4fee\u6539|\u65e0\u9700\u4fee\u6539|\u4e0d\u5fc5\u4fee\u6539)/i
const CAPABILITY_CHALLENGE_EXPLANATION_ONLY = /^(?:(?:(?:\u8bf7|\u9ebb\u70e6)?\u4f60?(?:\u80fd|\u53ef\u4ee5|\u80fd\u5426|\u53ef\u5426)?\s*(?:\u89e3\u91ca|\u8bf4\u660e|\u544a\u8bc9\u6211))|(?:(?:can|could|would)\s+you\s+(?:explain|describe|tell\s+me)\b))/i
const CHINESE_CAPABILITY_CHALLENGE_LEAD = /^(?:\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u600e\u4e48|\u600e\u6837|\u4f60(?:\u81ea\u5df1)?|\u4e0d\u80fd|\u65e0\u6cd5|\u6ca1\u6cd5|\u4e0d\u53ef\u4ee5|\u6ca1(?:\u6709)?)/i
const CHINESE_CAPABILITY_LIMITATION = /(?:\u4e0d\u80fd|\u65e0\u6cd5|\u6ca1\u6cd5|\u4e0d\u53ef\u4ee5|\u4e0d\u662f(?:\u53ef\u4ee5|\u80fd|\u6709)|\u4e0d\u76f4\u63a5|\u4e0d\u81ea\u5df1|\u505a\u4e0d\u4e86|\u6ca1(?:\u6709)?|\u627e\u4e0d\u5230|\u770b\u4e0d\u5230|(?:\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u600e\u4e48|\u5374)?\u4e0d(?:\u76f4\u63a5|\u81ea\u5df1|\u4fee\u6539|\u4fee\u590d|\u7f16\u8f91|\u6539|\u5199\u5165|\u5199|\u4f7f\u7528|\u7528|\u6267\u884c))/i
const CHINESE_MUTATION_CAPABILITY = /(?:\u4fee\u6539|\u4fee\u590d|\u7f16\u8f91|\u6539\u52a8|\u6539|\u5199\u5165|\u5199|\u4fdd\u5b58|\u8986\u76d6|\u66ff\u6362|\u6253\u8865\u4e01|\u6267\u884c|\u64cd\u4f5c|\u5199\u5165\u5de5\u5177|\u7f16\u8f91\u5de5\u5177|\u4fee\u6539\u5de5\u5177)/i
const CHINESE_ASSISTANT_CAPABILITY_REFERENT = /(?:\u4f60|\u81ea\u5df1|\u7531\u4f60|\u8ba9\u4f60|\u5e2e\u6211|\u66ff\u6211|\u5de5\u5177|\u80fd\u529b|\u73af\u5883|\u8fd9\u91cc)/i
const CHINESE_THIRD_PARTY_SUBJECT = /(?:\u7528\u6237|\u8bbf\u5ba2|\u7ba1\u7406\u5458|\u6210\u5458|\u5ba2\u6237|\u5458\u5de5|\u5b66\u751f|\u5f00\u53d1\u8005)/i
const CHINESE_NON_ASSISTANT_CAPABILITY_SUBJECT = /(?:(?:\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u600e\u4e48|\u600e\u6837)\s*)?(?:(?:\u5f53\u524d|\u8fd9\u4e2a|\u8be5|\u672c)\s*)?(?:\u7528\u6237|\u8bbf\u5ba2|\u7cfb\u7edf\u7ba1\u7406\u5458|\u7ba1\u7406\u5458|\u6210\u5458|\u5ba2\u6237|\u5458\u5de5|\u5b66\u751f|\u5f00\u53d1\u8005|\u9875\u9762|\u7f51\u9875|\u5e94\u7528|\u7cfb\u7edf|\u5b57\u6bb5|\u8868\u5355)[^,\uff0c\u3002.!?\uff1f\uff01;\uff1b\r\n]{0,32}(?:\u4e0d\u80fd|\u65e0\u6cd5|\u6ca1\u6cd5|\u4e0d\u53ef\u4ee5|\u505a\u4e0d\u4e86)/i
const ENGLISH_CAPABILITY_CHALLENGE_LEAD = /^(?:why|how|you|can(?:not|'t)|could(?:not|n't)|won't|don't|is\s+there\s+no|are\s+there\s+no)\b/i
const ENGLISH_CAPABILITY_LIMITATION = /\b(?:can(?:not|'t)|could(?:not|n't)|won't|don't|unable|not\s+able|no|missing|unavailable|absent)\b/i
const ENGLISH_MUTATION_CAPABILITY = /\b(?:edit|modify|change|fix|write|save|overwrite|replace|patch|execute|write[- ]tool|editing[- ]tool|modification[- ]tool)\w*\b|\b(?:do\s+it|make\s+the\s+change)\b/i
const ENGLISH_ASSISTANT_CAPABILITY_REFERENT = /\b(?:you|yourself|tool|capability|environment|available)\b/i
const ENGLISH_THIRD_PARTY_SUBJECT = /\b(?:users?|visitors?|admins?|administrators?|members?|customers?|employees?|students?|developers?)\b/i
const ENGLISH_NON_ASSISTANT_CAPABILITY_SUBJECT = /\b(?:(?:the|a|an)\s+)?(?:(?:current|this|that)\s+)?(?:users?|visitors?|admins?|administrators?|members?|customers?|employees?|students?|developers?|systems?|pages?|apps?|applications?|sites?|fields?|forms?)\b[^.!?\r\n]{0,40}\b(?:cannot|can't|couldn't|won't|unable|not\s+able)\b/i

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

function hasDelegatedLocalFileRequirements(text) {
  const prompt = String(text || '').trim()
  if (!prompt || !FILE_TARGET_REFERENCE.test(prompt) || LOCAL_FILE_REQUIREMENTS_READ_ONLY.test(prompt)) {
    return false
  }
  const lead = LOCAL_FILE_REQUIREMENTS_LEAD.exec(prompt)
  if (!lead) return false
  const requirementText = prompt.slice(lead.index + lead[0].length)
  const numberedItems = requirementText.match(NUMBERED_REQUIREMENT_ITEM) || []
  return numberedItems.length >= 2
    || (numberedItems.length >= 1 && /(?:\u5982\u4e0b|\u4ee5\u4e0b)/i.test(lead[0]))
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
  const actionablePrompt = prompt
    .replace(NEGATED_MUTATION_CLAUSE, ' ')
    .replace(NEGATED_ROUTING_MUTATION_CLAUSE, ' ')
    .replace(NEGATED_REWIND_MUTATION_CLAUSE, ' ')
    .trim()
  if (!actionablePrompt) return false
  // A capability challenge is not a fresh standalone write order. The chat
  // router and tool loop may inherit execution from the immediately preceding
  // mutation request, but lexical fragments such as "write the file" must not
  // make the question executable without that context.
  if (isExecutionCapabilityChallenge(actionablePrompt)) return false
  // Conversational Chinese often names a concrete file and directly lists
  // requested changes without repeating the verb "modify".
  if (hasDelegatedLocalFileRequirements(actionablePrompt)) return true
  // Explanation questions may contain a filename and mutation terminology,
  // but those words describe the topic rather than an instruction. A distinct
  // later work order still wins ("Why...? Please fix it now.").
  const firstBoundary = actionablePrompt.search(/[?\uff1f.!\u3002;\uff1b\n]/)
  const laterClause = firstBoundary >= 0 ? actionablePrompt.slice(firstBoundary + 1).trim() : ''
  const hasLaterExecutionOrder = Boolean(laterClause) && (
    IMPERATIVE_EXECUTION_INTENT.test(laterClause)
    || OBJECT_FIRST_EXECUTION_INTENT.test(laterClause)
    || OBJECT_TRANSFORMATION_EXECUTION_INTENT.test(laterClause)
    || OBJECT_TAIL_EXECUTION_INTENT.test(laterClause)
    || ROUTING_IMPERATIVE_EXECUTION_INTENT.test(laterClause)
    || REWIND_IMPERATIVE_EXECUTION_INTENT.test(laterClause)
    || DELEGATED_EXECUTION_INTENT.test(laterClause)
  )
  const hasFollowUpExecution = FOLLOW_UP_EXECUTION.test(actionablePrompt) || hasLaterExecutionOrder
  if (EXPLANATION_ONLY_LEAD.test(actionablePrompt) && !hasFollowUpExecution) return false
  if (hasActionableNumberedSteps(actionablePrompt)) return true
  if (DIRECT_EXECUTION_INTENT.test(actionablePrompt)) return true
  if (EXTERNAL_ACTION_ORDER.test(actionablePrompt)) return true
  if ((MUTATION_EXECUTION_INTENT.test(actionablePrompt)
    || REWIND_MUTATION_INTENT.test(actionablePrompt))
    && FILE_TARGET_REFERENCE.test(actionablePrompt)) return true
  if (DELEGATED_EXECUTION_INTENT.test(actionablePrompt)) return true
  // A question may be followed by a separate, explicit work order. Inspect the
  // text after the first sentence boundary so the leading "How/如何" does not
  // downgrade "Please fix it now/直接帮我修复好" to an answer-only request.
  if (!IMPERATIVE_EXECUTION_INTENT.test(actionablePrompt)
    && !OBJECT_FIRST_EXECUTION_INTENT.test(actionablePrompt)
    && !OBJECT_TRANSFORMATION_EXECUTION_INTENT.test(actionablePrompt)
    && !OBJECT_TAIL_EXECUTION_INTENT.test(actionablePrompt)
    && !ROUTING_IMPERATIVE_EXECUTION_INTENT.test(actionablePrompt)
    && !REWIND_IMPERATIVE_EXECUTION_INTENT.test(actionablePrompt)
    && !hasFollowUpExecution) return false
  if (ANSWER_ONLY_LEAD.test(actionablePrompt) && !hasFollowUpExecution) return false
  return true
}

export function hasMutationExecutionIntent(text = '') {
  // A verification-only follow-up often says "do not regenerate/write". The
  // mutation words inside that prohibition are constraints, not a fresh write
  // order. Clause boundaries keep mixed requests safe: "do not edit A; create
  // B" still retains the affirmative creation clause.
  const prompt = String(text || '')
    .replace(NEGATED_MUTATION_CLAUSE, ' ')
    .replace(NEGATED_ROUTING_MUTATION_CLAUSE, ' ')
    .replace(NEGATED_REWIND_MUTATION_CLAUSE, ' ')
  if (ANSWER_ONLY_LEAD.test(prompt) && !shouldRequireExecution({ text: prompt })) return false
  return MUTATION_EXECUTION_INTENT.test(prompt)
    || EXTERNAL_MUTATION_INTENT.test(prompt)
    || hasDelegatedLocalFileRequirements(prompt)
    || OBJECT_TRANSFORMATION_EXECUTION_INTENT.test(prompt)
    || OBJECT_TAIL_EXECUTION_INTENT.test(prompt)
    || REWIND_MUTATION_INTENT.test(prompt)
}

/**
 * A short challenge to a prior "I cannot edit/write" answer is an execution
 * continuation only when the caller also confirms that the preceding user
 * turn was a real mutation request. Keeping that context check outside this
 * helper prevents ordinary capability questions from becoming write orders.
 */
export function isExecutionCapabilityChallenge(text = '') {
  const prompt = String(text || '').trim()
  if (!prompt
    || prompt.length > 180
    || CAPABILITY_CHALLENGE_EXPLICIT_READ_ONLY.test(prompt)
    || CAPABILITY_CHALLENGE_EXPLANATION_ONLY.test(prompt)) return false
  const quoteNormalizedPrompt = prompt.replace(/[\u2018\u2019]/g, "'")
  let normalizedPrompt = quoteNormalizedPrompt.replace(/^(?:(?:\u90a3(?:\u4e48)?|\u6240\u4ee5|\u53ef(?:\u662f)?|\u4f46(?:\u662f)?|\u4e0d\u8fc7|\u96be\u9053)\s*)+/u, '')
  normalizedPrompt = normalizedPrompt
    .replace(/^(?:(?:\u65e2\u7136|\u660e\u660e|\u4e0d\u662f)[^,\uff0c\u3002.!?\uff1f]{0,48}[,\uff0c]\s*)/u, '')
    .replace(/^(?:(?:but|so|then|still)\s+)+/i, '')
  const chineseLeadIndex = normalizedPrompt.search(/(?:\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u600e\u4e48|\u600e\u6837|\u96be\u9053|\u4f60(?:\u81ea\u5df1)?|\u4e0d\u80fd|\u65e0\u6cd5|\u6ca1\u6cd5|\u4e0d\u53ef\u4ee5|\u6ca1(?:\u6709)?)/u)
  const chineseChallengeClause = chineseLeadIndex >= 0
    ? normalizedPrompt.slice(chineseLeadIndex)
    : normalizedPrompt
  const chineseReferent = CHINESE_ASSISTANT_CAPABILITY_REFERENT.test(prompt)
    || ((chineseChallengeClause.includes('\u76f4\u63a5') || chineseChallengeClause.includes('\u505a\u4e0d\u4e86'))
      && !CHINESE_THIRD_PARTY_SUBJECT.test(prompt))
  const englishReferent = ENGLISH_ASSISTANT_CAPABILITY_REFERENT.test(prompt)
    || (/\bdirectly\b/i.test(normalizedPrompt) && !ENGLISH_THIRD_PARTY_SUBJECT.test(prompt))
  const chineseNonAssistantSubject = CHINESE_NON_ASSISTANT_CAPABILITY_SUBJECT.test(chineseChallengeClause)
  const englishNonAssistantSubject = ENGLISH_NON_ASSISTANT_CAPABILITY_SUBJECT.test(normalizedPrompt)
  const chinese = CHINESE_CAPABILITY_CHALLENGE_LEAD.test(chineseChallengeClause)
    && CHINESE_CAPABILITY_LIMITATION.test(chineseChallengeClause)
    && CHINESE_MUTATION_CAPABILITY.test(chineseChallengeClause)
    && chineseReferent
    && !chineseNonAssistantSubject
  const english = ENGLISH_CAPABILITY_CHALLENGE_LEAD.test(normalizedPrompt)
    && ENGLISH_CAPABILITY_LIMITATION.test(normalizedPrompt)
    && ENGLISH_MUTATION_CAPABILITY.test(normalizedPrompt)
    && englishReferent
    && !englishNonAssistantSubject
  return chinese || english
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
