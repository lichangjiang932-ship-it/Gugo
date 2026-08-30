export function createUserDataGovernanceError(
  code,
  message,
  statusCode = 400,
  cause = null,
  details = {},
) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.statusCode = statusCode
  Object.assign(error, details)
  return error
}
