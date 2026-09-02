export class GeneratedArtifactFormatError extends Error {
  constructor(code, message, cause = null) {
    super(message)
    this.name = 'GeneratedArtifactFormatError'
    this.code = code
    this.retryable = true
    this.statusCode = 422
    this.artifactValidationFailure = true
    if (cause) this.cause = cause
  }
}

export function invalid(code, message, cause = null) {
  throw new GeneratedArtifactFormatError(code, message, cause)
}

export function isGeneratedArtifactFormatError(error) {
  return error?.artifactValidationFailure === true
    || /^ARTIFACT_FORMAT_/.test(String(error?.code || ''))
}
