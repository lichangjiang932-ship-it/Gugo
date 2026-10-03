const SNAPSHOT_ACTIONS = new Set(['APPLY_SERVER_SESSION_SNAPSHOT', 'APPLY_SERVER_SESSION_MESSAGES'])

function isArtifactMetadataAction(action) {
  if (SNAPSHOT_ACTIONS.has(action.type)) return true
  if (action.type === 'UPDATE_LAST_MESSAGE_META') return Object.hasOwn(action.payload || {}, 'serverArtifacts')
  return action.type === 'RECEIVE_MESSAGE' && Object.hasOwn(action.payload?.meta || {}, 'serverArtifacts')
}

function fileIdentity(file) {
  return file?.id && file?.url ? `${file.id}\u0000${file.url}` : ''
}

function isPptxFile(file) {
  return /\.ppt[xm]$/i.test(file?.filename || file?.title || '')
    || ['pptx', 'pptm'].includes(file?.type)
    || String(file?.mimeType || file?.type || '').includes('presentationml')
}

function changedArtifactRevisions(previous, next) {
  const changed = new Map()
  const priorSessions = new Map((previous.sessions || []).map((session) => [session.id, session]))
  for (const session of next.sessions || []) {
    const priorSession = priorSessions.get(session.id)
    if (session.messages === priorSession?.messages) continue
    const priorMessages = new Map((priorSession?.messages || []).map((message) => [message.id, message]))
    const artifacts = new Map()
    for (const message of session.messages || []) {
      if (message.role !== 'assistant' || message.meta?.serverArtifacts === priorMessages.get(message.id)?.meta?.serverArtifacts) continue
      for (const artifact of Array.isArray(message.meta?.serverArtifacts) ? message.meta.serverArtifacts : []) {
        const identity = fileIdentity(artifact)
        if (identity && isPptxFile(artifact) && typeof artifact.previewRevision === 'string' && artifact.previewRevision) {
          artifacts.set(identity, artifact.previewRevision)
        }
      }
    }
    if (artifacts.size) changed.set(session.id, artifacts)
  }
  return changed
}

/** Refresh only already-open same-file tabs after the owning reducer accepts
 * metadata. Never open a draft, change a URL/receipt, or steal the active tab. */
export function syncOpenPreviewArtifactRevisions(previous, next, action) {
  if (previous.sessions === next.sessions || !isArtifactMetadataAction(action)) return next
  const tabs = Array.isArray(next.previewTabs) ? next.previewTabs : []
  if (!tabs.length && !next.previewArtifact?.directFile) return next
  const changed = changedArtifactRevisions(previous, next)
  if (!changed.size) return next
  const owners = new Map((next.sessions || []).flatMap((session) => (session.messages || []).map((message) => [message.id, session.id])))
  const refresh = (artifact) => {
    const file = artifact?.directFile
    if (!isPptxFile(file)) return artifact
    const owner = artifact.messageId ? owners.get(artifact.messageId) : next.activeSessionId
    const revision = changed.get(owner)?.get(fileIdentity(file))
    if (!revision || file.previewRevision === revision) return artifact
    return { ...artifact, directFile: { ...file, previewRevision: revision } }
  }
  let updated = false
  const previewTabs = tabs.map((tab) => {
    const artifact = refresh(tab.artifact)
    if (artifact === tab.artifact) return tab
    updated = true
    return { ...tab, artifact }
  })
  const previewArtifact = previewTabs.find((tab) => tab.id === next.previewActiveId)?.artifact
    || refresh(next.previewArtifact)
  if (!updated && previewArtifact === next.previewArtifact) return next
  return { ...next, previewArtifact, ...(updated ? { previewTabs } : {}) }
}
