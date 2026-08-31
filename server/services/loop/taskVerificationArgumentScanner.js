function tokenizeArguments(value) {
  return String(value || '').match(/"[^"\r\n]*"|'[^'\r\n]*'|\S+/gu)?.map((token) => (
    token.replace(/^(?:["'])(.*)(?:["'])$/u, '$1')
  )) || []
}

/**
 * Scan a supported verification CLI profile. Unknown switches fail closed by
 * marking the command targeted. Concrete selector values are returned so the
 * repair state can attribute a targeted check to the relevant subtree.
 */
export function scanVerificationArguments(argumentText, {
  selectorOptions = [],
  selectorFlags = [],
  pathSelectorOptions = [],
  valueOptions = [],
  optionalValueOptions = [],
  flagOptions = [],
  cwdValueOptions = {},
} = {}) {
  const selectors = new Set(selectorOptions.map((option) => option.toLowerCase()))
  const selectorOnly = new Set(selectorFlags.map((option) => option.toLowerCase()))
  const pathSelectors = new Set(pathSelectorOptions.map((option) => option.toLowerCase()))
  const valued = new Set(valueOptions.map((option) => option.toLowerCase()))
  const optionallyValued = new Set(optionalValueOptions.map((option) => option.toLowerCase()))
  const flags = new Set(flagOptions.map((option) => option.toLowerCase()))
  const cwdValued = new Map(Object.entries(cwdValueOptions).map(([option, values]) => [
    option.toLowerCase(),
    new Set(values.map((value) => String(value).replace(/\\/gu, '/').toLowerCase())),
  ]))
  const positional = []
  const selectorValues = []
  let targeted = false
  const tokens = tokenizeArguments(argumentText)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') continue
    const separator = token.indexOf('=')
    const option = (separator >= 0 ? token.slice(0, separator) : token).toLowerCase()
    if (selectors.has(option)) {
      targeted = true
      const inlineValue = separator >= 0 ? token.slice(separator + 1) : ''
      const followingValue = separator < 0
        && index + 1 < tokens.length
        && !tokens[index + 1].startsWith('-')
        ? tokens[index + 1]
        : ''
      if (pathSelectors.has(option) && (inlineValue || followingValue)) {
        selectorValues.push(inlineValue || followingValue)
      }
      if (followingValue) index += 1
      continue
    }
    if (selectorOnly.has(option)) {
      targeted = true
      continue
    }
    if (cwdValued.has(option)) {
      const inlineValue = separator >= 0 ? token.slice(separator + 1) : ''
      const followingValue = separator < 0
        && index + 1 < tokens.length
        && !tokens[index + 1].startsWith('-')
        ? tokens[index + 1]
        : ''
      const optionValue = inlineValue || followingValue
      if (!optionValue
        || !cwdValued.get(option).has(optionValue.replace(/\\/gu, '/').toLowerCase())) {
        targeted = true
        if (optionValue) selectorValues.push(optionValue)
      }
      if (followingValue) index += 1
      continue
    }
    if (valued.has(option)) {
      if (separator >= 0) {
        if (separator === token.length - 1) targeted = true
      } else if (index + 1 < tokens.length && !tokens[index + 1].startsWith('-')) {
        index += 1
      } else {
        targeted = true
      }
      continue
    }
    if (optionallyValued.has(option)) {
      if (separator < 0
        && index + 1 < tokens.length
        && /^(?:true|false|\d+)$/iu.test(tokens[index + 1])) index += 1
      continue
    }
    // A flag is safe only as the exact, valueless token declared by the
    // profile. Treat `--flag=false` (and every other assigned form) as
    // targeted unless that boolean value is explicitly modelled elsewhere.
    // Several CLIs interpret false-y assignments differently from the bare
    // flag, so accepting them here could let a narrower check clear debt from
    // a full verification run.
    if (separator < 0
      && (flags.has(option) || (flags.has('-v') && /^-v+$/iu.test(token)))) continue
    if (token.startsWith('-')) {
      targeted = true
      continue
    }
    positional.push(token)
  }
  return { positional, selectorValues, targeted }
}
