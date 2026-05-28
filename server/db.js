import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

export const DB_SCHEMA_VERSION = 13

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'server-data')

function getDataDir() {
  return process.env.APP_DATA_DIR || DEFAULT_DATA_DIR
}

function getDbPath() {
  return process.env.APP_DB_PATH || path.join(getDataDir(), 'app.db')
}

let _db = null

function ensureDataDir() {
  const dir = getDataDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function getDb() {
  if (_db) return _db
  ensureDataDir()
  _db = new Database(getDbPath())
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  // ★ #37: 写入并发时遇到 SQLITE_BUSY 自动等待最多 5s 而不是立刻报错
  _db.pragma('busy_timeout = 5000')
  // synchronous=NORMAL 配合 WAL 是耐久性/性能折中,符合本应用 (本地工作台) 场景
  _db.pragma('synchronous = NORMAL')
  initSchema(_db)
  runMigrations(_db)
  return _db
}

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  return rows.some((row) => row.name === column)
}

function ensureUserPasswordColumns(db) {
  if (!hasColumn(db, 'users', 'password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT')
  }
  if (!hasColumn(db, 'users', 'password_salt')) {
    db.exec('ALTER TABLE users ADD COLUMN password_salt TEXT')
  }
  if (!hasColumn(db, 'users', 'password_set_at')) {
    db.exec('ALTER TABLE users ADD COLUMN password_set_at INTEGER')
  }
}

function getSchemaVersionInternal(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  return row ? Number(row.value) : 0
}

function setSchemaVersionInternal(db, version) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('schema_version', String(version))
}

function runMigrations(db) {
  // ★ 防御性：某些旧 DB 直接从更高版本起步（meta.schema_version=13 但 users 表是 v0 的样子），
  // 导致 v3 的 ALTER TABLE 永远不会重跑，setUserPassword 会抛 "no such column: password_hash"。
  // 这里独立于 schema_version 检查，缺什么列就补什么列，重复执行安全。
  ensureUserPasswordColumns(db)
  const version = getSchemaVersionInternal(db)
  if (version < 2) migrateToV2(db)
  if (getSchemaVersionInternal(db) < 3) migrateToV3(db)
  if (getSchemaVersionInternal(db) < 4) migrateToV4(db)
  if (getSchemaVersionInternal(db) < 5) migrateToV5(db)
  if (getSchemaVersionInternal(db) < 6) migrateToV6(db)
  if (getSchemaVersionInternal(db) < 7) migrateToV7(db)
  if (getSchemaVersionInternal(db) < 8) migrateToV8(db)
  if (getSchemaVersionInternal(db) < 9) migrateToV9(db)
  if (getSchemaVersionInternal(db) < 10) migrateToV10(db)
  if (getSchemaVersionInternal(db) < 11) migrateToV11(db)
  if (getSchemaVersionInternal(db) < 12) migrateToV12(db)
  if (getSchemaVersionInternal(db) < 13) migrateToV13(db)
  runReasonixMigrations(db)
}

/**
 * Reasonix 集成迁移：使用独立的 reasonix_schema_version meta key，与主迁移链解耦，
 * 这样与主迁移任意先后合并都不冲突。
 */
function runReasonixMigrations(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'reasonix_schema_version'").get()
  const current = row ? Number(row.value) : 0
  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pinned_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'user',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pinned_memories_user ON pinned_memories(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        project TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_todos_user_status ON todos(user_id, status, priority DESC);

      CREATE TABLE IF NOT EXISTS effort_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        effort TEXT NOT NULL DEFAULT 'medium',
        max_steps INTEGER NOT NULL DEFAULT 12,
        reasoning_depth INTEGER NOT NULL DEFAULT 2,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_meters (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        tokens_cached INTEGER NOT NULL DEFAULT 0,
        cost_credits INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_meters_user ON session_meters(user_id, updated_at DESC);
    `)
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('reasonix_schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run()
  }
}

/**
 * Migration v2:为 jobs / job_artifacts / skills 引入 user_id 归属列。
 * v1 阶段后台作业 / 技能未做用户隔离,理论上所有历史数据都属于「无归属」,
 * 而 v2 之后所有写入都强制带 user_id。为避免历史孤儿数据被错误访问,
 * 一次性清空这几张表(本项目尚未公开,清理代价可控),然后加列。
 */
function migrateToV2(db) {
  if (!hasColumn(db, 'jobs', 'user_id')) {
    db.exec('DELETE FROM job_artifacts; DELETE FROM job_events; DELETE FROM job_steps; DELETE FROM jobs;')
    db.exec('ALTER TABLE jobs ADD COLUMN user_id TEXT')
  }
  if (!hasColumn(db, 'job_artifacts', 'user_id')) {
    db.exec('ALTER TABLE job_artifacts ADD COLUMN user_id TEXT')
  }
  if (!hasColumn(db, 'skills', 'user_id')) {
    db.exec('DELETE FROM skill_assets; DELETE FROM skills;')
    db.exec('ALTER TABLE skills ADD COLUMN user_id TEXT')
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_job_artifacts_user ON job_artifacts(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id, created_at);
  `)
  setSchemaVersionInternal(db, 2)
}

/**
 * Migration v3：一次性引入 MCP / 子代理 / 记忆 / 压缩 / Hooks 全部新表
 * 同时给 users 表加 password_hash/salt/set_at（邮箱验证码仍可用，密码是额外快捷登录方式）。
 * 全部走 CREATE TABLE IF NOT EXISTS / hasColumn 守卫 — 重复跑安全；所有表都带 user_id 列做隔离。
 */
function migrateToV3(db) {
  // password-login 合并进来的用户密码列
  if (!hasColumn(db, 'users', 'password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT')
    db.exec('ALTER TABLE users ADD COLUMN password_salt TEXT')
    db.exec('ALTER TABLE users ADD COLUMN password_set_at INTEGER')
  }
  db.exec(`
    -- MCP 配置（feature 1）
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK (transport IN ('stdio','sse')),
      command TEXT,
      args_json TEXT,
      env_json TEXT,
      cwd TEXT,
      url TEXT,
      headers_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      auto_approve_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers(user_id, enabled);

    -- 统一审计日志（MCP / Hooks / 子代理 共用）
    CREATE TABLE IF NOT EXISTS tool_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      server_id TEXT,
      args_hash TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_audit_user_time ON tool_audit(user_id, created_at);

    -- 子代理（feature 2）
    CREATE TABLE IF NOT EXISTS subagent_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      parent_session_id TEXT,
      parent_message_id TEXT,
      agent_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      result_text TEXT,
      trace_json TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      credits INTEGER,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_runs_user_time ON subagent_runs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_subagent_runs_status ON subagent_runs(status);

    CREATE TABLE IF NOT EXISTS subagents_custom (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      tool_whitelist_json TEXT NOT NULL,
      system_prompt TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subagents_custom_user ON subagents_custom(user_id);

    -- 记忆（feature 3）
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('user','feedback','project','reference')),
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      body TEXT NOT NULL,
      frontmatter_json TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      source_session_id TEXT,
      source_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_user_type ON memories(user_id, type);
    CREATE INDEX IF NOT EXISTS idx_memories_user_slug ON memories(user_id, slug);
    CREATE INDEX IF NOT EXISTS idx_memories_user_pinned ON memories(user_id, pinned, last_used_at);
    CREATE INDEX IF NOT EXISTS idx_memories_user_agent ON memories(user_id, agent_id, pinned, last_used_at);

    CREATE TABLE IF NOT EXISTS memory_links (
      from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      to_slug TEXT NOT NULL,
      PRIMARY KEY (from_id, to_slug)
    );

    -- 压缩归档（feature 6）
    CREATE TABLE IF NOT EXISTS compaction_archive (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      replaced_message_count INTEGER NOT NULL,
      archived_messages_json TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_user_session ON compaction_archive(user_id, session_id, created_at);

    -- Hooks（feature 7）
    CREATE TABLE IF NOT EXISTS hooks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('user_prompt_submit','pre_tool_use','post_tool_use','stop')),
      tool_pattern TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('shell','http')),
      command TEXT,
      url TEXT,
      headers_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      blocking INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER NOT NULL DEFAULT 5000,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hooks_user_event ON hooks(user_id, event, enabled);
  `)
  setSchemaVersionInternal(db, 3)
}

/**
 * Migration v4: 知识图谱 — entities / relations / observations 三张表。
 * 参考 Reasonix 的 memory_* 工具集设计。
 *   entities:   { id, user_id, name, entity_type, created_at, updated_at }
 *   relations:  { id, user_id, from_entity_id, to_entity_id, relation_type, created_at }
 *   observations: { id, entity_id, content, created_at }
 */
function migrateToV4(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'general',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id, name);
    CREATE INDEX IF NOT EXISTS idx_entities_user_type ON entities(user_id, entity_type);

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      to_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_user ON relations(user_id);

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
  `)
  setSchemaVersionInternal(db, 4)
}

/**
 * V5: Agents 表 —— 用户可拥有多个 Agent 人格（SOUL + IDENTITY 卡片）
 *
 *   agents: { id, user_id, name, soul_md, identity_md, avatar_url, is_default, created_at, updated_at }
 *
 * 不直接接入 chat 注入流程（那是阶段 4 的事），本阶段只提供管理能力。
 */
function migrateToV5(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      soul_md TEXT NOT NULL DEFAULT '',
      identity_md TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_user_name ON agents(user_id, name);
  `)
  setSchemaVersionInternal(db, 5)
}

/**
 * 阶段 6：memories 补上可选 agent_id，实现“不同 agent 看到不同记忆切片”。
 * - agent_id IS NULL 表示全局记忆（所有 agent 可见）
 * - agent_id 具体 表示仅该 agent 可见
 * - ON DELETE SET NULL：删除 agent 后它的记忆退回全局
 */
function migrateToV6(db) {
  if (!hasColumn(db, 'memories', 'agent_id')) {
    db.exec('ALTER TABLE memories ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_user_agent ON memories(user_id, agent_id, pinned, last_used_at)')
  setSchemaVersionInternal(db, 6)
}

/**
 * A3: Agent 可选绑定内置 Yuan/persona 模板。
 */
function migrateToV7(db) {
  if (!hasColumn(db, 'agents', 'persona_template')) {
    db.exec('ALTER TABLE agents ADD COLUMN persona_template TEXT')
  }
  setSchemaVersionInternal(db, 7)
}

/**
 * A6: Unified notifications for web UI, SSE, and background jobs.
 */
function migrateToV8(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('info','success','warn','error','job')),
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      link TEXT,
      data_json TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at, created_at DESC);
  `)
  setSchemaVersionInternal(db, 8)
}

/**
 * A4: Chat sessions archive state + cross-session message search.
 *
 * The existing `sessions` table stores auth sessions. To keep old auth rows and tests intact,
 * chat rows reuse `token` as the stable session id and only rows with a non-null `title`
 * are treated as chat sessions by the session store.
 */
function migrateToV9(db) {
  if (!hasColumn(db, 'sessions', 'id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN id TEXT')
  }
  if (!hasColumn(db, 'sessions', 'title')) {
    db.exec('ALTER TABLE sessions ADD COLUMN title TEXT')
  }
  if (!hasColumn(db, 'sessions', 'updated_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN updated_at INTEGER')
  }
  if (!hasColumn(db, 'sessions', 'last_viewed_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN last_viewed_at INTEGER')
  }
  if (!hasColumn(db, 'sessions', 'archived_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN archived_at INTEGER')
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_archived ON sessions(user_id, archived_at, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
      content TEXT NOT NULL DEFAULT '',
      session_title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at);
  `)

  if (!hasColumn(db, 'messages', 'session_title')) {
    db.exec("ALTER TABLE messages ADD COLUMN session_title TEXT NOT NULL DEFAULT ''")
  }
  if (!hasColumn(db, 'messages', 'updated_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN updated_at INTEGER')
    db.exec('UPDATE messages SET updated_at = COALESCE(updated_at, created_at, 0)')
  }
  db.exec(`
    UPDATE messages
    SET session_title = COALESCE((
      SELECT title FROM sessions WHERE sessions.token = messages.session_id
    ), session_title, '')
    WHERE session_title = '';

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      role UNINDEXED,
      session_title,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, role, session_title)
      VALUES (new.rowid, new.content, new.role, new.session_title);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, role, session_title)
      VALUES ('delete', old.rowid, old.content, old.role, old.session_title);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content, role, session_title)
      VALUES ('delete', old.rowid, old.content, old.role, old.session_title);
      INSERT INTO messages_fts(rowid, content, role, session_title)
      VALUES (new.rowid, new.content, new.role, new.session_title);
    END;

    CREATE TRIGGER IF NOT EXISTS sessions_title_au AFTER UPDATE OF title ON sessions
    WHEN old.title IS NOT new.title AND new.title IS NOT NULL
    BEGIN
      UPDATE messages
      SET session_title = COALESCE(new.title, '')
      WHERE session_id = new.token;
    END;
  `)

  const ftsCount = db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get()?.count || 0
  if (ftsCount === 0) {
    db.prepare(`
      INSERT INTO messages_fts(rowid, content, role, session_title)
      SELECT rowid, content, role, session_title FROM messages
    `).run()
  }
  setSchemaVersionInternal(db, 9)
}

/**
 * S2: Studio cron + per-agent heartbeat scheduler.
 */
function migrateToV10(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('heartbeat','cron')),
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('at','every','cron')),
      schedule_value TEXT NOT NULL,
      exec_type TEXT NOT NULL CHECK (exec_type IN ('agent_session','direct_notify','plugin_action')),
      exec_payload_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_user ON cron_jobs(user_id, enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_user_agent ON cron_jobs(user_id, agent_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_next ON cron_jobs(enabled, next_run_at);
  `)
  setSchemaVersionInternal(db, 10)
}

/**
 * S1: Multi-agent channels.
 *
 * Channels are intentionally parallel to chat sessions/messages. The legacy
 * sessions/messages tables remain the single-agent chat path; channel tables
 * model DM/group collaboration between one user and one or more agents.
 */
function migrateToV11(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('dm','group')),
      default_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_channels_user_updated ON channels(user_id, archived_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_channels_user_kind ON channels(user_id, kind, updated_at DESC);

    CREATE TABLE IF NOT EXISTS channel_agents (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','owner')),
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_agents_agent ON channel_agents(agent_id, channel_id);

    CREATE TABLE IF NOT EXISTS channel_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      sender_kind TEXT NOT NULL CHECK (sender_kind IN ('user','agent')),
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      mentions_json TEXT NOT NULL DEFAULT '[]',
      parent_message_id TEXT REFERENCES channel_messages(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created ON channel_messages(channel_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_channel_messages_parent ON channel_messages(parent_message_id);
    CREATE INDEX IF NOT EXISTS idx_channel_messages_sender ON channel_messages(channel_id, sender_kind, sender_id, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS channel_messages_fts USING fts5(
      content,
      channel_id UNINDEXED,
      sender_kind UNINDEXED,
      content='channel_messages',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS channel_messages_ai AFTER INSERT ON channel_messages BEGIN
      INSERT INTO channel_messages_fts(rowid, content, channel_id, sender_kind)
      VALUES (new.rowid, new.content, new.channel_id, new.sender_kind);
    END;

    CREATE TRIGGER IF NOT EXISTS channel_messages_ad AFTER DELETE ON channel_messages BEGIN
      INSERT INTO channel_messages_fts(channel_messages_fts, rowid, content, channel_id, sender_kind)
      VALUES ('delete', old.rowid, old.content, old.channel_id, old.sender_kind);
    END;

    CREATE TRIGGER IF NOT EXISTS channel_messages_au AFTER UPDATE ON channel_messages BEGIN
      INSERT INTO channel_messages_fts(channel_messages_fts, rowid, content, channel_id, sender_kind)
      VALUES ('delete', old.rowid, old.content, old.channel_id, old.sender_kind);
      INSERT INTO channel_messages_fts(rowid, content, channel_id, sender_kind)
      VALUES (new.rowid, new.content, new.channel_id, new.sender_kind);
    END;
  `)

  const ftsCount = db.prepare('SELECT COUNT(*) AS count FROM channel_messages_fts').get()?.count || 0
  if (ftsCount === 0) {
    db.prepare(`
      INSERT INTO channel_messages_fts(rowid, content, channel_id, sender_kind)
      SELECT rowid, content, channel_id, sender_kind FROM channel_messages
    `).run()
  }
  setSchemaVersionInternal(db, 11)
}

/**
 * V12 — 第三方集成（社交平台 / IM）配置 + 视觉辅助模型
 * - integrations 表：每用户多条记录，记录 provider/credentials/enabled，凭据 JSON 落库不再走 .env
 * - 用于 QQ / Feishu / WeChat / DingTalk / Discord / Telegram / Slack / 其他自定义平台
 * - 也可承载 vision-assist 副驾配置（kind='vision_assist'）
 */
function migrateToV12(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      secret_json TEXT NOT NULL DEFAULT '{}',
      last_test_at INTEGER,
      last_test_ok INTEGER,
      last_test_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_integrations_user ON integrations(user_id, kind, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_user_provider ON integrations(user_id, kind, provider);
  `)
  setSchemaVersionInternal(db, 12)
}

function migrateToV13(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL DEFAULT 'dm',
      external_user_id TEXT,
      external_username TEXT,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_sessions_unique
      ON bridge_sessions(user_id, integration_id, provider, external_chat_id);
    CREATE INDEX IF NOT EXISTS idx_bridge_sessions_channel
      ON bridge_sessions(channel_id);
  `)
  setSchemaVersionInternal(db, 13)
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      package_id TEXT,
      model_name TEXT,
      credits INTEGER NOT NULL,
      balance INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);

    CREATE TABLE IF NOT EXISTS job_steps (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      parent_step_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      input_json TEXT,
      output_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_job_steps_job_sort ON job_steps(job_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_job_steps_status ON job_steps(status);

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      step_id TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_events_job_created ON job_events(job_id, created_at, id);

    CREATE TABLE IF NOT EXISTS job_artifacts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      user_id TEXT,
      step_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      filename TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_created ON job_artifacts(job_id, created_at);

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      version TEXT NOT NULL,
      icon TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_assets (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (skill_id, path)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 迁移：如果 meta 表没有 schema_version，插入初始值（runMigrations 会推到当前版本）
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
  `)
}

// G6 health: 健康探针只看「能否打开 db + 拿到 schema_version」, 不做写入,
// 用于 /api/health 给运维一眼判断 db 子系统状态.
export function getDbStatus() {
  try {
    const db = getDb()
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((table) => table.name)
    return {
      ok: true,
      schemaVersion: row?.value || null,
      path: getDbPath(),
      tables,
    }
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      path: getDbPath(),
    }
  }
}

export function closeDb() {
  if (_db) {
    _db.close()
    _db = null
  }
}

/* ── Users ── */

export function createUser({ id, email, credits = 0, now = Date.now() }) {
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO users (id, email, credits, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, credits = excluded.credits'
  )
  stmt.run(id, email, credits, now, now)
  return getUserById(id)
}

export function getUserById(id) {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?')
  return stmt.get(id) || null
}

export function getUserByEmail(email) {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?')
  return stmt.get(email) || null
}

export function setUserPassword({ id, passwordHash, passwordSalt, now = Date.now() }) {
  const db = getDb()
  const stmt = db.prepare(
    'UPDATE users SET password_hash = ?, password_salt = ?, password_set_at = ?, updated_at = ? WHERE id = ?'
  )
  stmt.run(passwordHash, passwordSalt, now, now, id)
  return getUserById(id)
}

export function clearUserPassword({ id, now = Date.now() }) {
  const db = getDb()
  db.prepare(
    'UPDATE users SET password_hash = NULL, password_salt = NULL, password_set_at = NULL, updated_at = ? WHERE id = ?'
  ).run(now, id)
  return getUserById(id)
}

export function updateUserCredits({ id, credits, now = Date.now() }) {
  const db = getDb()
  const stmt = db.prepare('UPDATE users SET credits = ?, updated_at = ? WHERE id = ?')
  stmt.run(credits, now, id)
  return getUserById(id)
}

export function deductUserCredits({ id, amount, now = Date.now() }) {
  const db = getDb()
  const stmt = db.prepare(
    'UPDATE users SET credits = credits - ?, updated_at = ? WHERE id = ? AND credits >= ?'
  )
  const result = stmt.run(amount, now, id, amount)
  return { changed: result.changes > 0, user: getUserById(id) }
}

/* ── Sessions (auth tokens) ── */

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export function createSession({ token, userId, now = Date.now(), ttlMs = TOKEN_TTL_MS }) {
  const db = getDb()
  // 清理过期 session
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
  const stmt = db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at'
  )
  stmt.run(token, userId, now + ttlMs, now)
  return { token, userId, expiresAt: now + ttlMs }
}

export function getSessionByToken(token, now = Date.now()) {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
  return stmt.get(token, now) || null
}

export function deleteSession(token) {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

export function deleteExpiredSessions(now = Date.now()) {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
}

/* ── Login Codes ── */

export function createLoginCode({ email, code, now = Date.now(), ttlMs = 10 * 60 * 1000 }) {
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO login_codes (email, code, attempts, expires_at, created_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(email) DO UPDATE SET code = excluded.code, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at'
  )
  stmt.run(email, code, now + ttlMs, now)
  return { email, code, expiresAt: now + ttlMs }
}

export function getLoginCode(email) {
  const db = getDb()
  const stmt = db.prepare('SELECT * FROM login_codes WHERE email = ?')
  return stmt.get(email) || null
}

export function incrementLoginAttempts(email) {
  const db = getDb()
  const stmt = db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?')
  stmt.run(email)
}

export function deleteLoginCode(email) {
  const db = getDb()
  db.prepare('DELETE FROM login_codes WHERE email = ?').run(email)
}

export function deleteExpiredCodes(now = Date.now()) {
  const db = getDb()
  db.prepare('DELETE FROM login_codes WHERE expires_at < ?').run(now)
}

/* ── Ledger ── */

export function addLedgerEntry({ id, userId, type, packageId, modelName, credits, balance, now = Date.now(), ignoreDuplicate = false }) {
  const db = getDb()
  const stmt = db.prepare(
    `${ignoreDuplicate ? 'INSERT OR IGNORE' : 'INSERT'} INTO ledger (id, user_id, type, package_id, model_name, credits, balance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  stmt.run(id, userId, type, packageId || null, modelName || null, credits, balance, now)
  return getLedgerForUser(userId)
}

export function getLedgerForUser(userId, limit = 50) {
  const db = getDb()
  const stmt = db.prepare(
    'SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  )
  return stmt.all(userId, limit)
}

/* ── Rate Limits ── */

export function checkRateLimit({ key, windowMs, maxRequests, now = Date.now() }) {
  const db = getDb()
  return db.transaction(() => {
    // 只清理当前 key 的旧窗口；不同限流器可能窗口长度不同，不能互相删记录。
    db.prepare('DELETE FROM rate_limits WHERE key = ? AND window_start < ?').run(key, now - windowMs)

    const row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key)
    if (!row) {
      db.prepare('INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)').run(key, now)
      return { allowed: true, remaining: maxRequests - 1 }
    }

    if (row.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt: row.window_start + windowMs }
    }

    db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key)
    return { allowed: true, remaining: maxRequests - row.count - 1 }
  })()
}

/* ── Migration ── */

export function getSchemaVersion() {
  const db = getDb()
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  return row ? Number(row.value) : 0
}

export function setSchemaVersion(version) {
  const db = getDb()
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema_version', String(version))
}

export function deleteExpiredRates(now = Date.now()) {
  const db = getDb()
  db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(now)
}

/* ── 旧 JSON 数据迁移 ── */

export function migrateFromJson(store) {
  const db = getDb()
  const now = Date.now()
  db.transaction(() => {
    for (const user of Object.values(store.users || {})) {
      createUser({ id: user.id, email: user.email, credits: user.credits || 0, now: user.createdAt || now })
    }
    for (const [token, userId] of Object.entries(store.sessions || {})) {
      createSession({ token, userId, now, ttlMs: TOKEN_TTL_MS })
    }
    for (const entry of store.ledger || []) {
      addLedgerEntry({
        id: entry.id,
        userId: entry.userId,
        type: entry.type,
        packageId: entry.packageId,
        modelName: entry.modelName,
        credits: entry.credits,
        balance: entry.balance,
        now: entry.createdAt || now,
        ignoreDuplicate: true,
      })
    }
  })()
}
