/**
 * The error shape the desktop update path reports: a message the reader can act
 * on plus a stable code the caller can branch on.
 */
export function updateError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  return error
}
