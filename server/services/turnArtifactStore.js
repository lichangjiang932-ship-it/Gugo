import { getDb } from '../db.js'
import { assertManagedArtifactMutationAllowed } from './userDataClearGuard.js'

function mapArtifact(row) {
  return row ? {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    type: row.type,
    title: row.title,
    url: row.url,
    filename: row.filename,
    createdAt: row.created_at,
  } : null
}

export function appendTurnArtifact({
  id, userId, sessionId, turnId, type, title, url, filename, createdAt = Date.now(),
}) {
  if (!id || !userId || !sessionId || !turnId || !filename) throw new Error('invalid turn artifact')
  const db = getDb()
  return db.transaction(() => {
    assertManagedArtifactMutationAllowed(
      db,
      'Artifacts cannot change while local data is being cleared',
    )
    db.prepare(`INSERT INTO turn_artifacts
      (id, user_id, session_id, turn_id, type, title, url, filename, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, sessionId, turnId, type, title, url, filename, createdAt)
    return mapArtifact(db.prepare('SELECT * FROM turn_artifacts WHERE id = ? AND user_id = ?').get(id, userId))
  }).immediate()
}

export function listTurnArtifacts({ userId, sessionId, turnId }) {
  if (!userId || !sessionId || !turnId) return []
  return getDb().prepare(`SELECT * FROM turn_artifacts
    WHERE user_id = ? AND session_id = ? AND turn_id = ? ORDER BY created_at ASC`)
    .all(userId, sessionId, turnId).map(mapArtifact)
}

export function listSessionTurnArtifacts({ userId, sessionId }) {
  if (!userId || !sessionId) return []
  return getDb().prepare(`SELECT * FROM turn_artifacts
    WHERE user_id = ? AND session_id = ? ORDER BY created_at ASC`)
    .all(userId, sessionId).map(mapArtifact)
}

export function getTurnArtifactById({ id, userId, sessionId }) {
  if (!id || !userId || !sessionId) return null
  return mapArtifact(getDb().prepare(`SELECT * FROM turn_artifacts
    WHERE id = ? AND user_id = ? AND session_id = ?`).get(id, userId, sessionId))
}

export function getTurnArtifactByIdInTurn({ id, userId, sessionId, turnId }) {
  if (!id || !userId || !sessionId || !turnId) return null
  return mapArtifact(getDb().prepare(`SELECT * FROM turn_artifacts
    WHERE id = ? AND user_id = ? AND session_id = ? AND turn_id = ?`)
    .get(id, userId, sessionId, turnId))
}

export function getTurnArtifactByIdForUser({ id, userId }) {
  if (!id || !userId) return null
  return mapArtifact(getDb().prepare(`SELECT * FROM turn_artifacts
    WHERE id = ? AND user_id = ?`).get(id, userId))
}

export function getTurnArtifactByFilename(filename) {
  if (!filename) return null
  return mapArtifact(getDb().prepare('SELECT * FROM turn_artifacts WHERE filename = ?').get(filename))
}

export function listTurnArtifactsByFilename(filename) {
  if (!filename) return []
  return getDb().prepare('SELECT * FROM turn_artifacts WHERE filename = ? ORDER BY created_at ASC')
    .all(filename)
    .map(mapArtifact)
}
