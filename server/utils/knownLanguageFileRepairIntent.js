// Deliberately bounded fallback for direct file-repair requests. These are
// whole imperative clauses, not action-word dictionaries or language guesses.
// Other languages, compound requests, explanations and ambiguous phrasing
// stay on the existing explicit-intent/answer path. This never grants a tool
// permission; callers still enforce directory, read-only and approval gates.
const FILE_REPAIR_ORDERS = [
  // Spanish
  /^(?:por\s+favor,?\s+)?(?:corrige|corrija|arregla|repara)\s+el\s+(?:error|bug|fallo)\s+en\s+(?<target>.+?)[.!]?$/iu,
  /^(?:por\s+favor,?\s+)?(?:actualiza|actualice|modifica|modifique|edita|edite|corrige|corrija|arregla|repara)\s+(?<target>.+?)[.!]?$/iu,
  // French
  /^(?:s['’]il\s+(?:te|vous)\s+pla[îi]t,?\s+)?(?:corrige|corrigez|répare|réparez)\s+(?:le\s+bug|l['’]erreur)\s+dans\s+(?<target>.+?)[.!]?$/iu,
  /^(?:s['’]il\s+(?:te|vous)\s+pla[îi]t,?\s+)?(?:mets\s+à\s+jour|mettez\s+à\s+jour|modifie|modifiez|édite|éditez|corrige|corrigez|répare|réparez)\s+(?<target>.+?)[.!]?$/iu,
  // German
  /^(?:bitte\s+)?(?:repariere|behebe)\s+den\s+(?:fehler|bug)\s+in\s+(?<target>.+?)[.!]?$/iu,
  /^(?:bitte\s+)?(?:ändere|aktualisiere|bearbeite|korrigiere|repariere)\s+(?<target>.+?)[.!]?$/iu,
  // Japanese
  /^(?<target>.+?)\s*の\s*(?:バグ|エラー|不具合)\s*を\s*(?:修正|修復)して(?:ください|下さい)[。.!！]?$/u,
  /^(?<target>.+?)\s*を\s*(?:直して|更新して|編集して|修正して)(?:ください|下さい)?[。.!！]?$/u,
  // Korean
  /^(?<target>.+?)\s*(?:의\s*)?(?:버그|오류|에러)[를을]\s*(?:수정해\s*주세요|고쳐\s*주세요)[。.!！]?$/u,
  /^(?<target>.+?)\s*(?:을|를)?\s*(?:수정해\s*주세요|고쳐\s*주세요|업데이트해\s*주세요)[。.!！]?$/u,
  // Russian
  /^(?:пожалуйста,?\s+)?(?:исправь|исправьте|устрани|устраните)\s+(?:ошибку|баг)\s+в\s+(?<target>.+?)[.!]?$/iu,
  /^(?:пожалуйста,?\s+)?(?:почини|почините|исправь|исправьте|обнови|обновите|измени|измените|отредактируй|отредактируйте)\s+(?<target>.+?)[.!]?$/iu,
]

// Quoted filenames may contain spaces. Unquoted prose is not a filename:
// trailing "do not modify", explanations, second clauses and quoted orders
// must not be consumed as the target of an otherwise affirmative prefix.
const SINGLE_TARGET = /^(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'`<>]+))$/u

export function hasKnownLanguageFileRepairIntent(text, isFileTarget) {
  const prompt = String(text || '').trim()
  if (!prompt || prompt.length > 512 || /[\r\n]/u.test(prompt)) return false
  for (const pattern of FILE_REPAIR_ORDERS) {
    const order = pattern.exec(prompt)
    if (!order) continue
    const target = SINGLE_TARGET.exec(order.groups.target.trim())
    if (target && isFileTarget(target.slice(1).find((value) => value !== undefined))) return true
  }
  return false
}
