const DISMISSAL_PREFIX = 'gugo.workspace-onboarding.dismissed.v1'

function stableIdentityHash(value) {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function workspaceOnboardingIdentity(user = {}, authMode = '') {
  const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : ''
  if (email) return email
  if (authMode === 'local') return 'local-owner'
  return ''
}

export function workspaceOnboardingDismissalKey(identity) {
  const normalized = typeof identity === 'string' ? identity.trim().toLowerCase() : ''
  return normalized ? `${DISMISSAL_PREFIX}.${stableIdentityHash(normalized)}` : ''
}

export function readWorkspaceOnboardingDismissal(storage, identity) {
  const key = workspaceOnboardingDismissalKey(identity)
  if (!key || !storage) return false
  try { return storage.getItem(key) === '1' } catch { return false }
}

export function writeWorkspaceOnboardingDismissal(storage, identity) {
  const key = workspaceOnboardingDismissalKey(identity)
  if (!key || !storage) return false
  try { storage.setItem(key, '1'); return true } catch { return false }
}

export function clearWorkspaceOnboardingDismissal(storage, identity) {
  const key = workspaceOnboardingDismissalKey(identity)
  if (!key || !storage) return false
  try { storage.removeItem(key); return true } catch { return false }
}

export function shouldAutoOpenWorkspaceOnboarding({ authenticated, complete, dismissed, pathname }) {
  return authenticated === true
    && complete === false
    && dismissed !== true
    && pathname !== '/permissions'
    && pathname !== '/settings'
}
