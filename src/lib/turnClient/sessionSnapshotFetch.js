import {
  DEFAULT_SNAPSHOT_PAGE_SIZE,
  DEFAULT_SNAPSHOT_REVISION_ATTEMPTS,
  headers,
  parseResponse,
} from './turnTransport.js'

function snapshotSyncError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export async function fetchServerSessionSnapshotPages({
  sessionId,
  signal,
  fetchImpl = fetch,
  pageSize = DEFAULT_SNAPSHOT_PAGE_SIZE,
  revisionAttempts = DEFAULT_SNAPSHOT_REVISION_ATTEMPTS,
}, normalizeSnapshot) {
  const safePageSize = Math.max(1, Math.min(2000, Number(pageSize) || DEFAULT_SNAPSHOT_PAGE_SIZE))
  const safeAttempts = Math.max(1, Number(revisionAttempts) || DEFAULT_SNAPSHOT_REVISION_ATTEMPTS)

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    let offset = 0
    let revision = null
    let turnEventRevision = null
    let totalMessages = null
    let firstPage = null
    const messages = []

    while (true) {
      const query = new URLSearchParams({ limit: String(safePageSize), offset: String(offset) })
      const response = await fetchImpl(
        `/api/sessions/${encodeURIComponent(sessionId)}/snapshot?${query}`,
        { headers: headers(), signal },
      )
      const page = (await parseResponse(response)).snapshot
      if (!page || !Array.isArray(page.messages) || !Number.isInteger(page.revision)) {
        throw snapshotSyncError('INVALID_SESSION_SNAPSHOT', 'Server returned an invalid session snapshot page')
      }

      if (revision === null) {
        revision = page.revision
        turnEventRevision = Number.isInteger(page.turnEventRevision)
          ? page.turnEventRevision
          : null
        totalMessages = Number.isInteger(page.totalMessages) ? page.totalMessages : null
        firstPage = page
      } else if (page.revision !== revision
        || (turnEventRevision !== null && page.turnEventRevision !== turnEventRevision)
        || (Number.isInteger(page.totalMessages) && totalMessages !== page.totalMessages)) {
        break
      }

      messages.push(...page.messages)
      if (page.complete === true) {
        if (totalMessages !== null && messages.length !== totalMessages) {
          throw snapshotSyncError(
            'INCOMPLETE_SESSION_SNAPSHOT',
            `Server completed a session snapshot with ${messages.length} of ${totalMessages} messages`,
          )
        }
        return normalizeSnapshot({
          ...firstPage,
          ...page,
          session: firstPage.session || page.session,
          messages,
          revision,
          ...(turnEventRevision !== null ? { turnEventRevision } : {}),
          totalMessages: totalMessages ?? messages.length,
          offset: 0,
          nextOffset: null,
          complete: true,
        })
      }

      const nextOffset = Number(page.nextOffset)
      if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
        throw snapshotSyncError('INVALID_SESSION_SNAPSHOT_PAGE', 'Session snapshot pagination did not advance')
      }
      offset = nextOffset
    }
  }

  throw snapshotSyncError(
    'SESSION_SNAPSHOT_CHANGED',
    'Session changed while its snapshot was being downloaded',
  )
}
