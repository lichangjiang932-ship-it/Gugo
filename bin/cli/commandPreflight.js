import { CliUsageError } from './errors.js'

/** Argument-only helpers: never load runtime configuration, storage, or identity. */
export function commandOptionValue(value, flag) {
  const text = value === undefined ? '' : String(value)
  if (!text.trim() || text.startsWith('--')) {
    throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${flag} requires a value`)
  }
  return text
}

export function commandPositiveInteger(value, { flag, code, fallback, max = Number.MAX_SAFE_INTEGER }) {
  if (value === undefined) return fallback
  const text = String(value).trim()
  const number = Number(text)
  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new CliUsageError(code, `${flag} must be an integer between 1 and ${max}`)
  }
  return number
}

export function assertCommandPositionals(positional, maximum, label) {
  if (positional.length > maximum) {
    throw new CliUsageError('CLI_ARGUMENT_UNEXPECTED', `${label} accepts at most ${maximum} positional argument(s)`)
  }
}
