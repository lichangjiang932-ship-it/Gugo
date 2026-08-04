/**
 * Browser-only directory authorization bridge.
 *
 * Tool risk classification lives exclusively on the server. The browser only
 * renders persisted approval requests and submits the user's decision.
 */
export async function askDirectoryApproval({
  name,
  args,
  path,
  suggestGrantPath,
  requiredAccessMode,
}) {
  if (typeof window === 'undefined' || typeof window.__directoryApprovalGate !== 'function') {
    return { approved: false, reason: 'No directory authorization UI is available; access was denied.' }
  }
  try {
    const result = await window.__directoryApprovalGate({
      name,
      args,
      path,
      suggestGrantPath,
      requiredAccessMode,
    })
    if (typeof result === 'boolean') return { approved: result }
    return {
      approved: !!result?.approved,
      reason: typeof result?.reason === 'string' ? result.reason : undefined,
    }
  } catch {
    return { approved: false, reason: 'The directory authorization UI failed; access was denied.' }
  }
}
