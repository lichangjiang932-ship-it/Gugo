import { ARTIFACT_TERMS } from './artifactIntentSupport.js'

export const ARTIFACT_FILE_OUTPUT_DENIAL = /(?:不要|不必|不用|无需|禁止|别|不)(?:再)?\s*(?:生成|创建|制作|输出|导出|写入)[^，,；;。！？!?\n]{0,12}(?:文件|产物)|(?:do\s+not|don't|dont|never|without)\s+(?:creat(?:e|ing)|generat(?:e|ing)|produc(?:e|ing)|export(?:ing)?|writ(?:e|ing))[^,;.!?\n]{0,24}\b(?:files?|artifacts?)\b/i
export const ARTIFACT_REDO_VERB = /(?:重新\s*(?:制作|生成|创建|设计|做)|重做|重制|再\s*做|\b(?:redo|remake|rebuild|recreate|regenerate|redesign)\b)/i
const ARTIFACT_REDO_COMMAND = new RegExp(String.raw`(?:^|[\n。.!?！？；;，,])\s*(?:(?:请|帮我|麻烦(?:你)?|直接|继续|我想让你|我需要你|我希望你)\s*|please\s+|(?:can|could|would)\s+you\s+|i\s+(?:want|need|would\s+like)\s+you\s+to\s+)*(?<action>${ARTIFACT_REDO_VERB.source})(?<target>[^\n。.!?！？；;，,]{0,96})`, 'gi')
const ARTIFACT_REDO_IMPLICIT_TARGET = /^\s*(?:(?:一|1)(?:个|份|版|张|遍|套)|一?下|它|这个|这份|这版|上一版|(?:it|this|that|them|one|(?:a\s+)?(?:new|another)\s+(?:one|version)|the\s+(?:previous\s+version|whole\s+thing|layout|design|theme|style|typography|colou?r\s+scheme))\b)(?=$|[\s，,。.!！；;])|^\s*$/i
const ARTIFACT_REDO_SUBJECT_PREFIX = /^\s*(?:(?:(?:这|那|该|此)(?:个|份|张|套|版)?|(?:当前|刚才|上一版)(?:的)?)\s*|(?:the|this|that|these|those|current|previous|last)\s+)*$/i
export const ARTIFACT_SOFTWARE_SUBJECT_AFTER = /^\s*(?:(?:文件|文档|工作簿|file|document|workbook)\s*)?(?:的\s*)?(?:解析器|生成器|转换器|渲染器|工具|函数|接口|代码|识别逻辑|(?:parser|generator|renderer|adapter|tool|function|api|code|logic)\b)/i
export const ARTIFACT_REDO_DISCUSSION = new RegExp(String.raw`(?:^|[\n。.!?！？；;])\s*(?:请|先|只|仅|please\s+)?(?:解释|说明|讨论|explain\b|describe\b|discuss\b|how\b|why\b)[^\n]{0,96}${ARTIFACT_REDO_VERB.source}|(?:告诉我|tell\s+me)[^。！？!?\n]{0,40}(?:怎么|如何|how\b|why\b)[^。！？!?\n]{0,32}${ARTIFACT_REDO_VERB.source}|${ARTIFACT_REDO_VERB.source}[^。！？!?\n]{0,48}(?:代码(?:示例|逻辑|片段)?|源码|提示词识别|code\s+(?:example|logic|snippet)|prompt\s+(?:parser|logic))`, 'i')
// A format can precede feedback and an imperative: "This PPT is ugly, redo
// it". Bind only the adjacent subject to that command, never every earlier
// format mention. A named new target ("redo a website") is not a back-reference.
export function hasDirectArtifactRedo(text, occurrence = null, type = '') {
  for (const command of text.matchAll(ARTIFACT_REDO_COMMAND)) {
    const target = command.groups.target
    const actionEnd = command.index + command[0].length - target.length
    const implicitTarget = ARTIFACT_REDO_IMPLICIT_TARGET.test(target)
    if (!occurrence) {
      const subjectStart = text.slice(0, command.index).search(/[^\n。.!?！？；;，,]*$/)
      if (implicitTarget && artifactMentionsBetween(text, subjectStart, command.index)
        .some((mention) => ARTIFACT_SOFTWARE_SUBJECT_AFTER.test(text.slice(mention.index + mention.length, command.index)))) continue
      if (implicitTarget || artifactMentionsBetween(target, 0, target.length)
        .some((mention) => !ARTIFACT_SOFTWARE_SUBJECT_AFTER.test(target.slice(mention.index + mention.length)))) return true
      continue
    }
    if (occurrence.index >= actionEnd && occurrence.index < actionEnd + target.length) return true
    if (!implicitTarget || occurrence.index >= command.index) continue
    const gap = text.slice(occurrence.index + occurrence[0].length, command.index)
    if (gap.length > 64 || /[\n。.!?！？；;，,]/.test(gap)
      || ARTIFACT_SOFTWARE_SUBJECT_AFTER.test(gap)) continue
    const clauseStart = text.slice(0, occurrence.index).search(/[^\n。.!?！？；;，,]*$/)
    if (!ARTIFACT_REDO_SUBJECT_PREFIX.test(text.slice(clauseStart, occurrence.index))) continue
    if (artifactMentionsBetween(text, occurrence.index, command.index)
      .some((mention) => mention.type !== type)) continue
    return true
  }
  return false
}

export function artifactMentionsBetween(text, start, end) {
  const mentions = []
  for (const [type, matcher] of Object.entries(ARTIFACT_TERMS)) {
    const probe = new RegExp(matcher.source, matcher.flags.includes('g') ? matcher.flags : `${matcher.flags}g`)
    for (const mention of text.slice(start, end).matchAll(probe)) {
      mentions.push({ type, index: start + mention.index, length: mention[0].length })
    }
  }
  return mentions.sort((left, right) => left.index - right.index)
}
