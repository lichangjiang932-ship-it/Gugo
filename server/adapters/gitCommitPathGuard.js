/**
 * The credential screen a commit must pass before anything is staged.
 *
 * Only files the repository does *not* ignore reach this point: `git status`
 * omits ignored paths, so an ignored `.env` is already refused earlier as "not
 * changed". The gap this closes is the opposite one — a private key or dotenv
 * file the repository never got around to ignoring, which git happily commits.
 */
import { badReq } from './fsShellSupport.js'

// Credential paths that are never a legitimate commit even when the repository
// does not ignore them. Every other ignore decision is delegated to the
// repository's own rules, so this list must stay this small and this specific.
const CREDENTIAL_FILENAMES = /(?:^|\/)(?:\.env|\.env\.[^/]+|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519))$/iu
const CREDENTIAL_EXTENSIONS = /\.(?:pem|key|p12|pfx|jks|keystore)$/iu
const CREDENTIAL_TEMPLATES = /(?:^|\/)\.env\.(?:example|sample|template|dist)$/iu

export function isCommittableCredentialPath(file) {
  const value = String(file || '').trim()
  if (!value || CREDENTIAL_TEMPLATES.test(value)) return true
  // A public key is not a secret.
  if (/\.pub$/iu.test(value)) return true
  return !CREDENTIAL_FILENAMES.test(value) && !CREDENTIAL_EXTENSIONS.test(value)
}

export function assertSelectedFilesAreCommittable(selected) {
  const blocked = selected.filter((file) => !isCommittableCredentialPath(file)).sort()
  if (blocked.length === 0) return
  const error = badReq(
    `refusing to commit credential paths: ${blocked.join(', ')}. `
    + 'Commit them deliberately outside this tool, or add them to .gitignore, if that is really intended.',
    403,
  )
  error.code = 'GIT_COMMIT_SENSITIVE_FILES'
  error.files = blocked
  throw error
}
