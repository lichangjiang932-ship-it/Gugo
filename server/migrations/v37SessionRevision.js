function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

function hasTable(db, table) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table)
}

export function migrateToV37(db) {
  if (hasTable(db, 'sessions') && !hasColumn(db, 'sessions', 'revision')) {
    db.exec('ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
  }
  if (hasTable(db, 'sessions') && hasTable(db, 'messages')) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_revision_after_insert
      AFTER INSERT ON messages
      BEGIN
        UPDATE sessions
        SET revision = revision + 1
        WHERE token = NEW.session_id AND user_id = NEW.user_id;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_revision_after_update
      AFTER UPDATE ON messages
      BEGIN
        UPDATE sessions
        SET revision = revision + 1
        WHERE token = NEW.session_id AND user_id = NEW.user_id;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_revision_after_delete
      AFTER DELETE ON messages
      BEGIN
        UPDATE sessions
        SET revision = revision + 1
        WHERE token = OLD.session_id AND user_id = OLD.user_id;
      END;
    `)
  }
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', '37')
}
