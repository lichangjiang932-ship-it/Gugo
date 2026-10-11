/**
 * Remember which tools a conversation has already been shown.
 *
 * The tool set is re-selected every turn from the current message, and it swings
 * — measured over 91 consecutive pairs in one install, the tool fingerprint
 * changed 15 times, moving between 4 and 21 tools and back. Tools come first in
 * the provider's cache hierarchy (tools → system → messages), so every swing
 * re-bills the system prompt and the whole transcript behind it: 316k of the
 * 481k re-billed tokens in that install.
 *
 * A set that only ever grows converges after the opening turns and then stops
 * moving. This table is where a conversation remembers what it has already
 * disclosed, so the next turn can union rather than replace.
 *
 * A new table rather than a column on `sessions`: that table is read and written
 * on every conversation switch, and this is touched by one path only.
 */
export function migrateToV122(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_tool_disclosures (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id  TEXT NOT NULL,
      tool_names  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_tool_disclosures_session
      ON session_tool_disclosures(session_id);
  `)
}
