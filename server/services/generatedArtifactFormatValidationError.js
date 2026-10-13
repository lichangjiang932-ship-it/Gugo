/**
 * What a validation code means to the model that has to react to it.
 *
 * The codes look alike and are not alike. Most say the bytes are malformed —
 * a broken ZIP, an unparseable part, a file that is not the format it claims —
 * and a better generation can get past them, so they are worth another attempt.
 *
 * One does not: `ACTIVE_CONTENT_FORBIDDEN` comes from the closed allow-lists in
 * `officeArtifactSafety.js` (safe part patterns, safe content types, safe
 * relationship kinds). Nothing about the bytes decides it — the *feature* the
 * document needs is refused, and regenerating the same kind of file cannot
 * change that. In a real DOCX turn the reader asked for a page background, which
 * needs a `word/settings.xml` part that all three lists refuse; the model was
 * told only "declares a forbidden content type" with `retryable: true`, and
 * spent twenty-four tool calls and five minutes learning otherwise.
 *
 * The rest are about the environment rather than the artifact — a path that is
 * not there, a file too large to read — where retrying is not what helps.
 */
const RETRYABLE_FORMAT_CODES = new Set([
  'ARTIFACT_FORMAT_ZIP_INVALID',
  'ARTIFACT_FORMAT_ZIP_ENTRY_INVALID',
  'ARTIFACT_FORMAT_ZIP_CRC_MISMATCH',
  'ARTIFACT_FORMAT_ZIP_COMPRESSION_UNSUPPORTED',
  'ARTIFACT_FORMAT_XML_INVALID',
  'ARTIFACT_FORMAT_STRUCTURE_INVALID',
  'ARTIFACT_FORMAT_PDF_INVALID',
  'ARTIFACT_FORMAT_IMAGE_INVALID',
  'ARTIFACT_FORMAT_IMAGE_LIMIT_EXCEEDED',
  'ARTIFACT_FORMAT_TYPE_MISMATCH',
  'ARTIFACT_FORMAT_EXTENSION_MISMATCH',
])

/**
 * Refused by policy, not by the bytes: the same kind of file can be generated
 * any number of times and will be refused every time.
 */
const POLICY_BLOCKED_FORMAT_CODES = new Set([
  'ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN',
])

/** @returns {{ retryable: boolean, policyBlocked: boolean }} */
export function classifyGeneratedArtifactFormatCode(code) {
  const normalized = String(code || '').trim().toUpperCase()
  return {
    retryable: RETRYABLE_FORMAT_CODES.has(normalized),
    policyBlocked: POLICY_BLOCKED_FORMAT_CODES.has(normalized),
  }
}

export class GeneratedArtifactFormatError extends Error {
  constructor(code, message, cause = null) {
    super(message)
    this.name = 'GeneratedArtifactFormatError'
    this.code = code
    const { retryable, policyBlocked } = classifyGeneratedArtifactFormatCode(code)
    this.retryable = retryable
    this.policyBlocked = policyBlocked
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
