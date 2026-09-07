function signatureError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  return error
}

export function suspendInstallerRegistration(updater) {
  // A previously ready installer may share this candidate's filename. Revoke
  // installability before replacement, while retaining reusable cache bytes.
  // Reattach the helper only after verification and cache registration succeed.
  updater.downloadedUpdateHelper = null
}

export async function verifyInstallerSignature(updater, installerPath) {
  if (typeof updater.verifySignature !== 'function') {
    throw signatureError('update signature verifier is unavailable', 'UPDATE_SIGNATURE_VERIFIER_UNAVAILABLE')
  }
  let signatureStatus
  try {
    // NsisUpdater reads publisherName from this installation's app-update.yml.
    // Unsigned installations legitimately return null without a signer; signed
    // installations must retain their existing publisher policy.
    signatureStatus = await updater.verifySignature(installerPath)
  } catch (cause) {
    throw signatureError('update installer signature verification failed', 'UPDATE_SIGNATURE_VERIFICATION_FAILED', cause)
  }
  if (signatureStatus !== null) {
    throw signatureError('update installer does not match this installation\'s signature policy', 'UPDATE_SIGNATURE_INVALID')
  }
}
