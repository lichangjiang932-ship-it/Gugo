export function migrateToV34(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turn_events_retention
      ON turn_events(user_id, created_at, turn_id);
  `)
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', '34')
}
