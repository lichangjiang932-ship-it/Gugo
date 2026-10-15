// @ts-check
/** Package checks only, not arbitrary npm lifecycle/deploy scripts or shell text. */
export const PROJECT_CHECK_NAME_PATTERN = '^[a-zA-Z][a-zA-Z0-9:_-]{0,79}$'
const pattern = new RegExp(PROJECT_CHECK_NAME_PATTERN, 'u')
/** @param {unknown} value */
export function projectCheckName(value) {
  if (typeof value !== 'string' || !pattern.test(value.trim())) return null
  const name = value.trim(), parts = name.split(':')
  return ['test', 'lint', 'build', 'check', 'typecheck'].includes(parts[0]) && parts.every(part => part.length > 0) ? name : null
}
