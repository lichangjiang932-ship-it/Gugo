/** Called inside the transaction that explicitly replaces or deletes transcript rows. */
export function fenceSessionTranscriptRecovery(db, { userId, sessionId, turnIds = null }) {
  const scopedTurnIds = Array.isArray(turnIds)
    ? [...new Set(turnIds.map((turnId) => String(turnId || '').trim()).filter(Boolean))]
    : null
  if (scopedTurnIds?.length === 0) return
  // Include a persisted message whose first event was never committed. Its -1
  // fence prevents a client recovery stub, but permits any real later event.
  db.prepare(`
    WITH known_turn_sequences AS (
      SELECT turn_id, sequence FROM turn_events
      WHERE user_id = @userId AND session_id = @sessionId
      UNION ALL
      SELECT json_extract(model_context_json, '$.turnId'), -1 FROM messages
      WHERE user_id = @userId AND session_id = @sessionId
        AND json_valid(model_context_json)
        AND json_type(model_context_json, '$.turnId') = 'text'
    )
    INSERT INTO session_transcript_recovery_fences
      (user_id, session_id, turn_id, suppressed_through_sequence)
    SELECT @userId, @sessionId, turn_id, MAX(sequence)
    FROM known_turn_sequences
    WHERE turn_id IS NOT NULL AND length(trim(turn_id)) > 0
      AND (@turnIds IS NULL OR turn_id IN (SELECT value FROM json_each(@turnIds)))
    GROUP BY turn_id
    ON CONFLICT(user_id, session_id, turn_id) DO UPDATE SET
      suppressed_through_sequence = MAX(
        session_transcript_recovery_fences.suppressed_through_sequence,
        excluded.suppressed_through_sequence
      )
  `).run({ userId, sessionId, turnIds: scopedTurnIds === null ? null : JSON.stringify(scopedTurnIds) })
}

export function suppressedTranscriptRecoveryTurnIds(db, { userId, sessionId }) {
  return new Set(db.prepare(`
    SELECT fence.turn_id
    FROM session_transcript_recovery_fences AS fence
    WHERE fence.user_id = ? AND fence.session_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM turn_events AS event
        WHERE event.user_id = fence.user_id AND event.session_id = fence.session_id
          AND event.turn_id = fence.turn_id
          AND event.sequence > fence.suppressed_through_sequence
      )
  `).all(userId, sessionId).map((row) => row.turn_id))
}
