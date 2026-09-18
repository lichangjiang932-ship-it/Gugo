/** Derived, rebuildable search data. Source memories and legacy duplicates remain unchanged. */
export function migrateToV120(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_search_index (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT,
      type TEXT NOT NULL,
      source_auto INTEGER NOT NULL CHECK (source_auto IN (0, 1)),
      memory_order INTEGER NOT NULL,
      search_title TEXT NOT NULL,
      search_slug TEXT NOT NULL,
      search_body TEXT NOT NULL,
      search_tags_json TEXT NOT NULL,
      exact_title_key TEXT NOT NULL,
      dedup_title_key TEXT NOT NULL,
      dedup_body_key TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_search_pending (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT,
      memory_order INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_search_owner_order
      ON memory_search_index(user_id, memory_order);
    CREATE INDEX IF NOT EXISTS idx_memory_search_title
      ON memory_search_index(user_id, agent_id, search_title);
    CREATE INDEX IF NOT EXISTS idx_memory_search_slug
      ON memory_search_index(user_id, agent_id, search_slug);
    CREATE INDEX IF NOT EXISTS idx_memory_search_exact_title
      ON memory_search_index(user_id, agent_id, type, exact_title_key);
    CREATE INDEX IF NOT EXISTS idx_memory_search_auto_title
      ON memory_search_index(user_id, agent_id, source_auto, dedup_title_key);
    CREATE INDEX IF NOT EXISTS idx_memory_search_auto_body
      ON memory_search_index(user_id, agent_id, source_auto, type, dedup_body_key);
    CREATE INDEX IF NOT EXISTS idx_memory_search_pending_scope
      ON memory_search_pending(user_id, agent_id, memory_order);
    CREATE TRIGGER IF NOT EXISTS memory_search_insert_pending AFTER INSERT ON memories
    BEGIN
      INSERT INTO memory_search_pending(memory_id,user_id,agent_id,memory_order)
      VALUES(NEW.id,NEW.user_id,NEW.agent_id,NEW.rowid)
      ON CONFLICT(memory_id) DO UPDATE SET user_id=excluded.user_id,
        agent_id=excluded.agent_id,memory_order=excluded.memory_order;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_search_update_pending
    AFTER UPDATE OF user_id,agent_id,type,title,slug,body,frontmatter_json ON memories
    BEGIN
      DELETE FROM memory_search_index WHERE memory_id=OLD.id;
      INSERT INTO memory_search_pending(memory_id,user_id,agent_id,memory_order)
      VALUES(NEW.id,NEW.user_id,NEW.agent_id,NEW.rowid)
      ON CONFLICT(memory_id) DO UPDATE SET user_id=excluded.user_id,
        agent_id=excluded.agent_id,memory_order=excluded.memory_order;
    END;
    INSERT INTO memory_search_pending(memory_id,user_id,agent_id,memory_order)
      SELECT m.id,m.user_id,m.agent_id,m.rowid FROM memories m
      WHERE NOT EXISTS(SELECT 1 FROM memory_search_index i WHERE i.memory_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM memory_search_pending p WHERE p.memory_id=m.id);
  `)
}
