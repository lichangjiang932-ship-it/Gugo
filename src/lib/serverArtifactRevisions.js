// Keep the normal stream and reconnect stream on the same cache-revision
// policy. A revision is an opaque UI token, not evidence of verification.
export function appendServerArtifact(artifact, artifacts, dispatchMessage) {
  const index = artifacts.findIndex((item) => item.id === artifact.id)
  const existing = index >= 0 ? artifacts[index] : null
  if (existing && (typeof artifact.previewRevision !== 'string' || !artifact.previewRevision
    || artifact.previewRevision === existing.previewRevision)) return false
  const filename = artifact.filename || existing?.filename || 'artifact'
  const type = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'file'
  const next = { ...existing, ...artifact, filename, type }
  if (existing?.url && !artifact.url) next.url = existing.url
  if (index < 0) artifacts.push(next)
  else artifacts[index] = next
  dispatchMessage('UPDATE_LAST_MESSAGE_META', { serverArtifacts: [...artifacts] })
  return true
}
