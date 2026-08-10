const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+)/u
const TRAILING_SENTENCE_PUNCTUATION = /[.\u3002\uFF0E]+$/u
const TRAILING_PARENTHETICAL_SUFFIX = /(\(([^()\r\n]{1,160})\)|\uFF08([^\uFF08\uFF09\r\n]{1,160})\uFF09)(\s*(?:(?:\u4e2d|\u5185|\u4e0b|\u91cc)\s*)?(?:(?:\u8fdb\u884c|\u5b8c\u6210)\s*)?(?:\u8f93\u51fa|\u521b\u5efa|\u5199\u5165|\u751f\u6210|\u5bfc\u51fa|\u4fdd\u5b58|\u5b58\u653e)(?:[^\r\n]{0,160})?)?$/u

const CHINESE_EXPLANATORY_NOTES = [
  /^(?:(?:\u8be5|\u6b64)?(?:\u76ee\u5f55|\u8def\u5f84)?(?:\u4ece\u672a|\u5c1a\u672a|\u8fd8\u672a|\u672a\u66fe|\u672a|\u6ca1\u6709|\u65e0)(?:\u83b7\u5f97|\u83b7|\u7ecf)?\u6388\u6743)(?:\s*[,\uFF0C;\uFF1B:\uFF1A-].*)?$/u,
  /^(?:(?:\u8be5|\u6b64)?(?:\u76ee\u5f55|\u8def\u5f84)?(?:\u9700\u8981|\u9700|\u5f85|\u8bf7\u5148)(?:\u83b7\u5f97|\u83b7|\u7ecf)?\u6388\u6743)(?:\s*[,\uFF0C;\uFF1B:\uFF1A-].*)?$/u,
  /^(?:\u6388\u6743|(?:\u8bbf\u95ee)?\u6743\u9650)(?:\u5c1a\u672a|\u8fd8\u672a|\u672a)?(?:\u5b8c\u6210|\u786e\u8ba4|\u6388\u4e88|\u901a\u8fc7|\u6279\u51c6|\u63d0\u4f9b|\u83b7\u5f97|\u4e0d\u8db3|\u7f3a\u5931|\u9700\u8981|\u5f85\u786e\u8ba4)(?:\s*[,\uFF0C;\uFF1B:\uFF1A-].*)?$/u,
  /^(?:\u8bf4\u660e|\u5907\u6ce8|\u6ce8\u91ca|\u63d0\u793a)(?:\s*[:\uFF1A].*)?$/u,
]

const ENGLISH_EXPLANATORY_NOTE = /^(?:not\s+(?:yet\s+)?authori[sz]ed|never\s+authori[sz]ed|unauthori[sz]ed|unapproved|authori[sz]ation\s+(?:required|needed|pending|missing|not\s+granted)|permission\s+(?:required|needed|pending|missing|not\s+granted)|(?:requires?|needs?|awaiting)\s+(?:authori[sz]ation|permission)|note\s*:.+)(?:\s*[,;:-].*)?$/iu

function isWindowsAbsolutePath(value) {
  return WINDOWS_ABSOLUTE_PATH.test(value)
}

function isExplanatoryNote(value) {
  const note = String(value || '').trim()
  if (!note) return false
  return ENGLISH_EXPLANATORY_NOTE.test(note)
    || CHINESE_EXPLANATORY_NOTES.some((pattern) => pattern.test(note))
}

function pathExists(pathExistsFn, value) {
  if (typeof pathExistsFn !== 'function') return false
  try {
    return pathExistsFn(value) === true
  } catch {
    return false
  }
}

/**
 * Clean only an untrusted directory suggestion before it is shown to the user.
 * This must not be used on a path the user already confirmed for authorization.
 */
export function sanitizeSuggestedDirectoryPath(value, { pathExists: pathExistsFn = null } = {}) {
  const input = String(value || '').trim()
  if (!input || !isWindowsAbsolutePath(input)) return input

  const withoutSentencePunctuation = input.replace(TRAILING_SENTENCE_PUNCTUATION, '').trimEnd()
  const match = withoutSentencePunctuation.match(TRAILING_PARENTHETICAL_SUFFIX)
  if (!match) return withoutSentencePunctuation

  const note = match[2] || match[3]
  const trailingAction = match[4] || ''
  const explanatoryNote = isExplanatoryNote(note)
  if (!explanatoryNote && !trailingAction) return withoutSentencePunctuation

  // A real directory may legitimately contain parentheses, even words that
  // resemble an annotation or action phrase. Preserve the complete value when
  // the host can prove it exists.
  if (pathExists(pathExistsFn, withoutSentencePunctuation)) return withoutSentencePunctuation

  // An authorization annotation is not part of the path. For an ordinary
  // parenthesized directory followed by Chinese prose such as "\u4e2d\u8f93\u51fa", keep
  // the parenthesized directory and remove only the prose.
  const basePath = explanatoryNote
    ? withoutSentencePunctuation.slice(0, match.index).trimEnd()
    : withoutSentencePunctuation.slice(0, match.index + match[1].length).trimEnd()
  return isWindowsAbsolutePath(basePath) ? basePath : withoutSentencePunctuation
}
