import { mergeServerSessionMessages } from '../sessionServerSync.js'

function applyWorkspacePath(target, metadata) {
  if (!Object.prototype.hasOwnProperty.call(metadata || {}, 'workspacePath')) return target
  const workspacePath = String(metadata.workspacePath || '').trim()
  if (workspacePath) target.workspacePath = workspacePath
  else delete target.workspacePath
  return target
}

function applyTurnEventRevision(target, metadata) {
  const revision = Number(metadata?.turnEventRevision)
  if (Number.isInteger(revision) && revision >= 0) target.serverTurnEventRevision = revision
  return target
}

function clearServerTranscriptStale(target) {
  delete target.serverTranscriptStale
  return target
}

function catalogSourceChanged(previous, current) {
  return previous != null
    && current != null
    && (
      Number(previous.version) !== Number(current.version)
      || previous.backendInstanceId !== current.backendInstanceId
      || previous.workspaceScope?.key !== current.workspaceScope?.key
    )
}

function serverSessionProjection(
  metadata,
  localSession,
  { preserveTranscript = false, preservePendingTranscript = false } = {},
) {
  const revision = Number(metadata?.revision)
  if (!metadata?.id || !Number.isInteger(revision) || revision < 0) return localSession || null
  if (Number.isInteger(localSession?.serverRevision) && localSession.serverRevision > revision) {
    return localSession
  }
  const localRevision = Number.isInteger(localSession?.serverRevision)
    ? localSession.serverRevision
    : null
  const turnEventRevision = Number(metadata?.turnEventRevision)
  const hasTurnEventRevision = Number.isInteger(turnEventRevision) && turnEventRevision >= 0
  const localTurnEventRevision = Number.isInteger(localSession?.serverTurnEventRevision)
    ? localSession.serverTurnEventRevision
    : null
  const sameTurnEventRevision = !hasTurnEventRevision
    || (localTurnEventRevision === null
      ? turnEventRevision === 0
      : localTurnEventRevision === turnEventRevision)
  const hasPendingTranscript = localSession?.messages?.some((message) => (
    message?.meta?.pendingServerSync === true || message?.meta?.streaming === true
  ))
  const pendingTranscriptPreserved = preservePendingTranscript && hasPendingTranscript
  const serverWatermarkChanged = localRevision !== null && localRevision !== revision
    || (hasTurnEventRevision && localTurnEventRevision !== turnEventRevision)
  const keepLocalTranscript = preserveTranscript
    || pendingTranscriptPreserved
    || (localRevision === revision && sameTurnEventRevision)
  const projected = applyTurnEventRevision({
    ...(localSession || {}),
    id: metadata.id,
    title: metadata.title || localSession?.title || 'Untitled',
    messages: keepLocalTranscript && Array.isArray(localSession?.messages)
      ? localSession.messages
      : [],
    createdAt: Number(metadata.createdAt) || Number(localSession?.createdAt) || 0,
    updatedAt: Number(metadata.updatedAt)
      || Number(metadata.createdAt)
      || Number(localSession?.updatedAt)
      || 0,
    lastViewedAt: metadata.lastViewedAt ?? null,
    archivedAt: metadata.archivedAt ?? null,
    pinnedAt: metadata.pinnedAt ?? null,
    parentSessionId: metadata.parentSessionId || null,
    branchLabel: metadata.branchLabel || null,
    forkedAt: metadata.forkedAt ?? null,
    serverRevision: revision,
  }, metadata)
  if (pendingTranscriptPreserved
    && (serverWatermarkChanged || localSession?.serverTranscriptStale === true)) {
    projected.serverTranscriptStale = true
  } else if (!keepLocalTranscript) {
    delete projected.serverTranscriptStale
  }
  return applyWorkspacePath(projected, metadata)
}

export function reconcileServerSessionCatalog(
  state,
  catalog,
  {
    preserveLocalOnly = false,
    serverAuthoritativeIds = [],
    importedSessionIds = [],
    preserveSessionIds = [],
    legacySessionIdMappings = [],
  } = {},
) {
  const idMappings = new Map()
  for (const mapping of Array.isArray(legacySessionIdMappings) ? legacySessionIdMappings : []) {
    const sourceSessionId = String(mapping?.sourceSessionId || '').trim()
    const sessionId = String(mapping?.sessionId || '').trim()
    if (sourceSessionId && sessionId && sourceSessionId !== sessionId) {
      idMappings.set(sourceSessionId, sessionId)
    }
  }
  const localSessions = (Array.isArray(state?.sessions) ? state.sessions : []).map((session) => {
    const sessionId = idMappings.get(session?.id)
    if (!sessionId) return session
    return {
      ...session,
      id: sessionId,
      // Recovery copies use deterministically re-keyed message ids. Force one
      // canonical snapshot read instead of retaining incompatible browser ids.
      messages: [],
    }
  })
  const localById = new Map(localSessions.map((session) => [session.id, session]))
  const serverIds = new Set()
  const authoritativeIds = new Set(Array.isArray(serverAuthoritativeIds) ? serverAuthoritativeIds : [])
  const importedIds = new Set(Array.isArray(importedSessionIds) ? importedSessionIds : [])
  const protectedIds = new Set(Array.isArray(preserveSessionIds) ? preserveSessionIds : [])
  const serverSessions = []

  for (const metadata of Array.isArray(catalog) ? catalog : []) {
    const id = String(metadata?.id || '').trim()
    if (!id || serverIds.has(id)) continue
    const localSession = localById.get(id)
    const projected = serverSessionProjection(
      { ...metadata, id },
      localSession,
      {
        preserveTranscript: importedIds.has(id),
        // Catalog rows contain metadata, not an authoritative transcript.
        // Never blank optimistic background rows. A changed server watermark
        // marks the retained transcript for snapshot hydration when selected.
        preservePendingTranscript: true,
      },
    )
    if (!projected) continue
    serverIds.add(id)
    serverSessions.push(projected)
  }

  const localOnly = localSessions.filter((session) => (
    (preserveLocalOnly || protectedIds.has(session.id))
    && !serverIds.has(session.id)
    && !authoritativeIds.has(session.id)
    && !Number.isInteger(session.serverRevision)
  ))
  const sessions = [...localOnly, ...serverSessions]
  const mappedActiveSessionId = idMappings.get(state.activeSessionId) || state.activeSessionId
  // Catalog refresh is background synchronization, not navigation. If the
  // current session disappeared—or the user explicitly started a draft—stay
  // on the blank draft instead of opening an unrelated historical session.
  const activeSessionId = sessions.some((session) => session.id === mappedActiveSessionId)
    ? mappedActiveSessionId
    : null
  const retainedIds = new Set(sessions.map((session) => session.id))
  const sessionDrafts = {}
  for (const [sourceSessionId, draft] of Object.entries(state.sessionDrafts || {})) {
    const sessionId = idMappings.get(sourceSessionId) || sourceSessionId
    if (retainedIds.has(sessionId)) sessionDrafts[sessionId] = draft
  }

  return { ...state, sessions, activeSessionId, sessionDrafts }
}

export function reduceServerSessionState(state, action) {
  switch (action.type) {
    case 'RECONCILE_SERVER_SESSION_CATALOG': {
      const reconciled = reconcileServerSessionCatalog(
        state,
        action.payload?.sessions,
        {
          preserveLocalOnly: action.payload?.preserveLocalOnly === true,
          serverAuthoritativeIds: action.payload?.serverAuthoritativeIds,
          importedSessionIds: action.payload?.importedSessionIds,
          preserveSessionIds: action.payload?.preserveSessionIds,
          legacySessionIdMappings: action.payload?.legacySessionIdMappings,
        },
      )
      const migrated = action.payload?.clearPendingLegacySessions === true
        ? { ...reconciled, pendingLegacySessions: [] }
        : reconciled
      if (!Object.prototype.hasOwnProperty.call(action.payload || {}, 'source')) return migrated
      const source = action.payload?.source ?? null
      const changed = catalogSourceChanged(state.sessionCatalogSource, source)
      return {
        ...migrated,
        sessionCatalogSource: source,
        sessionCatalogSourceMismatch: changed
          ? { previous: state.sessionCatalogSource, current: source }
          : state.sessionCatalogSourceMismatch,
      }
    }

    case 'APPLY_SERVER_SESSION_SNAPSHOT': {
      const { sessionId, snapshot } = action.payload || {}
      if (!sessionId || snapshot?.complete !== true || !Array.isArray(snapshot.messages)) return state
      const revision = Math.max(0, Number(snapshot.revision) || 0)
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== sessionId || revision < (Number(session.serverRevision) || 0)) return session
          return clearServerTranscriptStale(applyTurnEventRevision(applyWorkspacePath({
            ...session,
            messages: mergeServerSessionMessages(session.messages, snapshot.messages),
            ...(Object.prototype.hasOwnProperty.call(snapshot.session || {}, 'pinnedAt')
              ? { pinnedAt: snapshot.session.pinnedAt }
              : {}),
            serverRevision: revision,
            updatedAt: Math.max(Number(session.updatedAt) || 0, revision),
          }, snapshot.session), snapshot))
        }),
      }
    }

    case 'APPLY_SERVER_SESSION_METADATA': {
      const { sessionId, session: metadata } = action.payload || {}
      const revision = Number(metadata?.revision)
      if (!sessionId || !Number.isInteger(revision)) return state
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== sessionId) return session
          if (Number.isInteger(session.serverRevision) && revision < session.serverRevision) return session
          return applyTurnEventRevision(applyWorkspacePath({
            ...session,
            ...(Object.prototype.hasOwnProperty.call(metadata, 'archivedAt')
              ? { archivedAt: metadata.archivedAt }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(metadata, 'pinnedAt')
              ? { pinnedAt: metadata.pinnedAt }
              : {}),
            serverRevision: revision,
            updatedAt: Math.max(Number(session.updatedAt) || 0, Number(metadata.updatedAt) || 0),
          }, metadata), metadata)
        }),
      }
    }

    case 'APPLY_SERVER_SESSION_MESSAGES': {
      const { sessionId, messages, revision } = action.payload || {}
      if (!sessionId || !Array.isArray(messages) || !Number.isInteger(revision)) return state
      return {
        ...state,
        sessions: state.sessions.map((session) => {
          if (session.id !== sessionId) return session
          if (Number.isInteger(session.serverRevision) && revision < session.serverRevision) return session
          return clearServerTranscriptStale({
            ...session,
            messages,
            serverRevision: revision,
            updatedAt: Math.max(Number(session.updatedAt) || 0, revision),
          })
        }),
      }
    }

    case 'APPLY_SERVER_SESSION_DELETE': {
      const sessionId = action.payload?.sessionId
      if (!sessionId) return state
      const sessions = state.sessions.filter((session) => session.id !== sessionId)
      const sessionDrafts = { ...(state.sessionDrafts || {}) }
      delete sessionDrafts[sessionId]
      return {
        ...state,
        sessions,
        activeSessionId: state.activeSessionId === sessionId
          ? null
          : state.activeSessionId,
        sessionDrafts,
      }
    }

    case 'COMPACT_SESSION': {
      const targetId = action.payload?.sessionId || state.activeSessionId
      const messages = Array.isArray(action.payload?.messages) ? action.payload.messages : null
      if (!targetId || !messages) return state
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === targetId
            ? { ...s, messages, updatedAt: Date.now() }
            : s
        ),
      }
    }

    case 'EXPAND_COMPACTED': {
      const targetId = action.payload?.sessionId || state.activeSessionId
      const archiveId = action.payload?.archiveId
      const archivedMessages = Array.isArray(action.payload?.archivedMessages) ? action.payload.archivedMessages : []
      if (!targetId || !archiveId || archivedMessages.length === 0) return state
      return {
        ...state,
        sessions: state.sessions.map((s) => {
          if (s.id !== targetId) return s
          const nextMessages = []
          for (const msg of s.messages) {
            if (msg?.meta?.archiveId === archiveId || msg?.meta?.compactionArchiveId === archiveId) {
              nextMessages.push(...archivedMessages)
            } else {
              nextMessages.push(msg)
            }
          }
          return { ...s, messages: nextMessages, updatedAt: Date.now() }
        }),
      }
    }

    default:
      return null
  }
}
