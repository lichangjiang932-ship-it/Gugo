import { argumentBudgetError, schemaPolicyError } from './toolSchemaBudget.js'

export const TOOL_PATTERN_INPUT_LIMIT = 4096

/** Conservative linear-ish subset: no groups, alternation, backrefs or nested repetition. */
export function assertSafeToolPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 512) throw schemaPolicyError('unsafe_pattern')
  let inClass = false
  let repeats = 0
  let unbounded = 0
  let alternatives = 1
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '\\') {
      const escaped = pattern[++index]
      if (!inClass && (/[1-9]/u.test(escaped || '') || escaped === 'k')) throw schemaPolicyError('unsafe_pattern')
      if (['p', 'P', 'u'].includes(escaped) && pattern[index + 1] === '{') {
        const close = pattern.indexOf('}', index + 2)
        if (close === -1) throw schemaPolicyError('invalid_pattern')
        index = close
      }
      continue
    }
    if (character === '[' && !inClass) { inClass = true; continue }
    if (character === ']' && inClass) { inClass = false; continue }
    if (inClass) continue
    if (['(', ')', '|'].includes(character)) throw schemaPolicyError('unsafe_pattern')
    if (character === '*' || character === '+') { unbounded += 1; repeats += 1 }
    if (character === '?') { alternatives *= 2; repeats += 1 }
    if (character === '{') {
      const close = pattern.indexOf('}', index + 1)
      const match = /^(\d+)(?:,(\d*))?$/u.exec(pattern.slice(index + 1, close))
      if (close === -1 || !match) throw schemaPolicyError('invalid_pattern')
      const minimum = Number(match[1])
      const maximum = match[2] === '' ? Infinity : Number(match[2] ?? match[1])
      if (minimum > 256 || (Number.isFinite(maximum) && maximum > 256)) throw schemaPolicyError('unsafe_pattern')
      if (!Number.isFinite(maximum)) unbounded += 1
      else alternatives *= Math.max(1, maximum - minimum + 1)
      repeats += 1
      index = close
    }
    if (unbounded > 1 || repeats > 8 || alternatives > 4096) throw schemaPolicyError('unsafe_pattern')
  }
  try { new RegExp(pattern, 'u') } catch { throw schemaPolicyError('invalid_pattern') }
}

export function boundedToolRegExp(pattern, flags) {
  const expression = new RegExp(pattern, flags)
  return {
    toString: () => expression.toString(),
    test(value) {
      if (value.length > TOOL_PATTERN_INPUT_LIMIT) throw argumentBudgetError('pattern_input')
      return expression.test(value)
    },
  }
}

boundedToolRegExp.code = 'boundedToolRegExp'
