import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import {
  LATEST_SCHEMA_VERSION,
  hasColumn,
  runSchemaMigrations,
} from './migrations/index.js'

export const DB_SCHEMA_VERSION = LATEST_SCHEMA_VERSION

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

function setSchemaVersionInternal(db, version) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('schema_version', String(version))
}

// Historical definitions remain inline to avoid destabilizing existing upgrade
// paths, while the shared registry owns ordering and version advancement.
const LEGACY_SCHEMA_MIGRATIONS = [
  migrateToV2,
  migrateToV3,
  migrateToV4,
  migrateToV5,
  migrateToV6,
  migrateToV7,
  migrateToV8,
  migrateToV9,
  migrateToV10,
  migrateToV11,
  migrateToV12,
  migrateToV13,
  migrateToV14,
  migrateToV15,
  migrateToV16,
  migrateToV17,
  migrateToV18,
  migrateToV19,
  migrateToV20,
  migrateToV21,
  migrateToV22,
  migrateToV23,
  migrateToV24,
  migrateToV25,
  migrateToV26,
  migrateToV27,
  migrateToV28,
  migrateToV29,
  migrateToV30,
].map((up, index) => ({ version: index + 2, up }))
function runMigrations(db) {
  // ★ 防御性：某些旧 DB 直接从更高版本起步（meta.schema_version=13 但 users 表是 v0 的样子），
  // 导致 v3 的 ALTER TABLE 永远不会重跑，setUserPassword 会抛 "no such column: password_hash"。
  // 这里独立于 schema_version 检查，缺什么列就补什么列，重复执行安全。
  ensureUserPasswordColumns(db)
  ensureUserToolPermissionsTable(db)
  runSchemaMigrations(db, { legacyMigrations: LEGACY_SCHEMA_MIGRATIONS })
  runReasonixMigrations(db)
}

function ensureUserToolPermissionsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_tool_permissions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, tool_name)
    );
    CREATE INDEX IF NOT EXISTS idx_user_tool_permissions_user
      ON user_tool_permissions(user_id);
  `)
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
 * chat rows reuse `token` as the stable session id. Auth rows keep both `id`
 * and `title` null; chat rows have at least a stable `id`, even without a title.
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

/**
 * V14: Desk Notes + Mobile Access Keys (Hanako parity)
 *
 * - desk_notes：Agent 书桌便笺。可选 agent_id；pinned 排序在前。
 * - mobile_access_keys：移动端 / LAN 远程登录凭据。key_hash 不存明文，
 *   show-once 在创建路由里返回。expires_at 可空（NULL = 不过期）。
 */
function migrateToV14(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS desk_notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_desk_notes_user
      ON desk_notes(user_id, pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_desk_notes_agent
      ON desk_notes(agent_id);

    CREATE TABLE IF NOT EXISTS mobile_access_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_keys_user
      ON mobile_access_keys(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mobile_keys_hash
      ON mobile_access_keys(key_hash);
  `)
  setSchemaVersionInternal(db, 14)
}

/**
 * V15 (E2/E4 数据一致性 + 工具权限 gate) —— 远端 main 已占 v7~v14，本批顺延为 V15。
 *   - jobs.user_id 补 NOT NULL + REFERENCES users(id) ON DELETE CASCADE（账户归属链路）
 *   - job_steps.parent_step_id 补索引 (E4)
 *   - user_tool_permissions 表（功能补全：per-user 工具 gate）
 *
 * 注：E3（给 tool_audit/subagent_runs/subagents_custom/hooks/compaction_archive 补外键）
 * 已撤回——这些表的 user_id 是既有弱引用契约，多处调用不建 user 行直写，强加 FK 会破坏契约。
 *
 * SQLite 无法用 ALTER TABLE 给现有表加外键/NOT NULL,必须「建新表→搬数据→换名」。
 * 迁移**保留现有数据**:搬迁前先清理孤儿行。绝不 DELETE 全表。
 */
function migrateToV15(db) {
  // 外键迁移期间必须临时关掉 foreign_keys,否则建表/改名过程中的中间态会触发约束。
  db.pragma('foreign_keys = OFF')
  const tx = db.transaction(() => {
    rebuildJobsWithUserFk(db)
    // E4: parent_step_id 自引用层级补索引
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_steps_parent ON job_steps(parent_step_id);')
    // 功能补全: per-user 工具权限 gate(默认放行,仅存显式覆盖)
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_tool_permissions (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, tool_name)
      );
      CREATE INDEX IF NOT EXISTS idx_user_tool_permissions_user ON user_tool_permissions(user_id);
    `)
    setSchemaVersionInternal(db, 15)
  })
  tx()
  db.pragma('foreign_keys = ON')
  // 迁移后做一次完整性自检(开发期暴露问题;生产仅 log)
  const violations = db.pragma('foreign_key_check')
  if (violations.length && process.env.NODE_ENV !== 'production') {
    console.warn('[db] migrateToV15 后存在外键违规:', violations)
  }
}

/**
 * V16: user-scoped OpenAI-compatible model providers.
 * Secrets stay server-side; API responses only expose their presence.
 */
function migrateToV16(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_providers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_key TEXT NOT NULL,
      label TEXT NOT NULL,
      base_url TEXT NOT NULL,
      secret_json TEXT NOT NULL,
      headers_json TEXT NOT NULL DEFAULT '{}',
      models_json TEXT NOT NULL,
      default_model TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, provider_key)
    );
    CREATE INDEX IF NOT EXISTS idx_model_providers_user
      ON model_providers(user_id, enabled, provider_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_providers_one_default
      ON model_providers(user_id) WHERE is_default = 1;
  `)
  setSchemaVersionInternal(db, 16)
}

/** V17: accept the current MCP Streamable HTTP transport name. */
function migrateToV17(db) {
  db.pragma('foreign_keys = OFF')
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE mcp_servers__v17 (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        transport TEXT NOT NULL CHECK (transport IN ('stdio','sse','http')),
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
      INSERT INTO mcp_servers__v17
        SELECT id,user_id,name,transport,command,args_json,env_json,cwd,url,headers_json,enabled,auto_approve_json,created_at,updated_at
        FROM mcp_servers;
      DROP TABLE mcp_servers;
      ALTER TABLE mcp_servers__v17 RENAME TO mcp_servers;
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers(user_id, enabled);
    `)
    setSchemaVersionInternal(db, 17)
  })
  tx()
  db.pragma('foreign_keys = ON')
}

/** V18: user-approved local file and folder access. */
function migrateToV18(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_file_access_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      all_files_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_file_grants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      root_path TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('file','directory')),
      access_mode TEXT NOT NULL CHECK (access_mode IN ('read_only','read_write')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, root_path)
    );
    CREATE INDEX IF NOT EXISTS idx_local_file_grants_user
      ON local_file_grants(user_id, created_at);
  `)
  setSchemaVersionInternal(db, 18)
}

/**
 * v19: 审批门控(approval gating)。服务端 agent 循环在执行高风险工具前把调用
 * 挂起写进这张表,等用户在收件箱里批准/拒绝/改写后再继续。
 *
 * 这是「运行中、每次调用」的门控,和 user_tool_permissions 那种「运行前、每工具名」
 * 的静态开关是两回事,两者并存。
 */
function migrateToV19(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      origin TEXT NOT NULL CHECK (origin IN ('job','subagent','chat')),
      job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
      step_id TEXT,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','denied','edited','expired','cancelled')),
      decided_args_json TEXT,
      decided_by TEXT,
      decided_at INTEGER,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_user_status
      ON pending_approvals(user_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_job
      ON pending_approvals(job_id);
  `)
  // notifications.kind 是表级 CHECK,SQLite 不能 ALTER,只能重建表把 'approval' 加进去。
  // 不改 migrateToV8(AGENTS.md 2.5.1),在这里重建。
  widenNotificationKinds(db)
  setSchemaVersionInternal(db, 19)
}

/**
 * v20: 审批模式(对齐 Claude Code / Codex 的权限档位)。
 *
 * 以前审批只有一个 env 级的 APPROVAL_MODE,用户改不了,且没有「总是允许」——
 * 同一个工具第 N 次还在问,只能一次次点。现在:
 *   - mode: 每用户一个档位,前端可切
 *   - approval_tool_grants: 用户点「总是允许这个工具」后记在这里
 */
function migrateToV20(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_approval_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'normal'
        CHECK (mode IN ('normal','acceptEdits','plan','bypass')),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approval_tool_grants (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, tool_name)
    );
  `)
  setSchemaVersionInternal(db, 20)
}

/**
 * v21: durable steering inbox for long-running jobs.
 *
 * Messages are leased at an engine iteration boundary and acknowledged only
 * after the model has accepted the request. A restart returns outstanding
 * leases to queued, so an in-flight user correction is never silently lost.
 */
function migrateToV21(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_steering_messages (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','leased','consumed')),
      lease_id TEXT,
      leased_at INTEGER,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_steering_pending
      ON job_steering_messages(job_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_job_steering_user
      ON job_steering_messages(user_id, created_at DESC);
  `)
  setSchemaVersionInternal(db, 21)
}

/**
 * Persist the active model/tool turn for a job step. Recovery uses this durable
 * outbox instead of replaying the whole step after a process restart.
 */
function migrateToV22(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_turn_checkpoints (
      step_id TEXT PRIMARY KEY REFERENCES job_steps(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_turn_checkpoints_job
      ON job_turn_checkpoints(job_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_turn_checkpoints_user
      ON job_turn_checkpoints(user_id, updated_at DESC);
  `)
  setSchemaVersionInternal(db, 22)
}

/** Durable self-wake timers for the same job/thread (not a new cron job). */
function migrateToV23(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_wakeups (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL REFERENCES job_steps(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      wake_at INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled','fired','cancelled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      fired_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_job_wakeups_due
      ON job_wakeups(status, wake_at);
    CREATE INDEX IF NOT EXISTS idx_job_wakeups_user
      ON job_wakeups(user_id, status, wake_at);
  `)
  setSchemaVersionInternal(db, 23)
}

/** Park inbound bridge messages until the external sender is explicitly trusted. */
function migrateToV24(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_contacts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','allowed','blocked')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      decided_at INTEGER,
      PRIMARY KEY (user_id, integration_id, provider, external_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_contacts_user_status
      ON bridge_contacts(user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS bridge_parked_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      sender_name TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'parked'
        CHECK (status IN ('parked','delivering','delivered','rejected','failed')),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      decided_at INTEGER,
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_parked_user_status
      ON bridge_parked_messages(user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bridge_parked_contact
      ON bridge_parked_messages(user_id, integration_id, provider, external_user_id, status);
  `)
  setSchemaVersionInternal(db, 24)
}

/** Declarative persona manifest for agent capabilities and safe defaults. */
function migrateToV25(db) {
  if (!hasColumn(db, 'agents', 'persona_manifest_json')) {
    db.exec('ALTER TABLE agents ADD COLUMN persona_manifest_json TEXT')
  }
  setSchemaVersionInternal(db, 25)
}

/** Durable, one-time OAuth handshakes for connector authorization across restarts. */
function migrateToV26(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_oauth_sessions (
      id TEXT PRIMARY KEY,
      state_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      integration_id TEXT REFERENCES integrations(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','exchanging','completed','failed','expired')),
      code_verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_integration_oauth_user
      ON integration_oauth_sessions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_integration_oauth_expiry
      ON integration_oauth_sessions(status, expires_at);
  `)
  setSchemaVersionInternal(db, 26)
}

/** Command tools remember a safe command prefix, never a tool-wide wildcard. */
function migrateToV27(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE approval_tool_grants_v27 (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        command_prefix TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, tool_name, command_prefix)
      );
      INSERT INTO approval_tool_grants_v27 (user_id, tool_name, command_prefix, created_at)
        SELECT user_id, tool_name, '', created_at
          FROM approval_tool_grants
         WHERE tool_name <> 'bash_exec';
      DROP TABLE approval_tool_grants;
      ALTER TABLE approval_tool_grants_v27 RENAME TO approval_tool_grants;
    `)
    setSchemaVersionInternal(db, 27)
  })()
}

/**
 * V28: per-provider 能力与超时配置。
 *
 * ★ 背景:超时、上下文窗口、是否支持工具/流式/视觉,原来全是**全局 env**,
 * 一个用户同时接了 Ollama(8k 窗口、CPU 很慢)和 DeepSeek(128k、很快)时,
 * 这些值只能取一个折中 —— 结果是两边都配不对:
 *   - 按云端配 → 本地模型正在吐字就被超时砍断
 *   - 按本地配 → 云端请求白等十分钟
 *
 * 这些列全部可空。空 = 走 server/utils/endpointProfile.js 的推断值,
 * 所以老数据不需要任何回填,行为和升级前一致。
 */
function migrateToV28(db) {
  db.transaction(() => {
    const columns = [
      // 端点类型:ollama / lmstudio / llamacpp / vllm / openai-compatible
      // 空 = 从 URL 端口和主机名自动推断
      ['kind', 'TEXT'],
      // 模型真实上下文窗口。Ollama 可由 /api/show 自动探测填入
      ['context_window', 'INTEGER'],
      // 三态:1 支持 / 0 不支持 / NULL 按 kind 默认推断
      ['supports_tools', 'INTEGER'],
      ['supports_streaming', 'INTEGER'],
      ['supports_vision', 'INTEGER'],
      // 首 token 超时 / 两个 chunk 之间的空闲超时(毫秒)
      ['first_token_timeout_ms', 'INTEGER'],
      ['idle_timeout_ms', 'INTEGER'],
      // 这个 provider 失败时允不允许切到别的 provider。
      // 本地端点默认关(见 endpointProfile),避免「本地慢 → 偷偷切云端」
      ['failover_enabled', 'INTEGER'],
      // Ollama keep_alive,如 '30m'。避免每次请求都重新加载模型权重
      ['keep_alive', 'TEXT'],
    ]
    for (const [name, type] of columns) {
      if (!hasColumn(db, 'model_providers', name)) {
        db.exec(`ALTER TABLE model_providers ADD COLUMN ${name} ${type}`)
      }
    }
    setSchemaVersionInternal(db, 28)
  })()
}
function migrateToV29(db) { db.exec(`CREATE TABLE IF NOT EXISTS turn_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE, turn_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, UNIQUE(user_id, session_id, turn_id, sequence)); CREATE INDEX IF NOT EXISTS idx_turn_events_replay ON turn_events(user_id, session_id, turn_id, sequence);`); setSchemaVersionInternal(db, 29) }
function migrateToV30(db) { db.exec(`CREATE TABLE IF NOT EXISTS turn_artifacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE, turn_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, filename TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_turn_artifacts_turn ON turn_artifacts(user_id, session_id, turn_id, created_at); CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_artifacts_filename ON turn_artifacts(filename);`); setSchemaVersionInternal(db, 30) }
/** 重建 notifications 表,把 kind 的 CHECK 放宽到含 'approval'。 */
function widenNotificationKinds(db) {
  const sql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'")
    .get()?.sql
  // 已经含 approval(全新库由本函数之外的路径建过)就跳过,幂等
  if (!sql || sql.includes("'approval'")) return

  db.exec(`
    CREATE TABLE notifications_v19 (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('info','success','warn','error','job','approval')),
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      link TEXT,
      data_json TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL
    );
    INSERT INTO notifications_v19 (id, user_id, kind, title, body, link, data_json, read_at, created_at)
      SELECT id, user_id, kind, title, body, link, data_json, read_at, created_at FROM notifications;
    DROP TABLE notifications;
    ALTER TABLE notifications_v19 RENAME TO notifications;
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read_at, created_at DESC);
  `)
}

/**
 * 重建 jobs 表:user_id 加 NOT NULL + 外键级联。先删孤儿 job(及其子表),保留有主 job。
 */
function rebuildJobsWithUserFk(db) {
  if (!hasColumn(db, 'jobs', 'user_id')) {
    // 理论上 v2 已加列;若没有则补一个裸列再继续(防御)。
    db.exec('ALTER TABLE jobs ADD COLUMN user_id TEXT')
  }
  // 清理孤儿:user_id 为空或指向不存在的用户。级联会顺带清子表,但此刻 FK 关掉,手动清。
  db.exec(`
    DELETE FROM job_events WHERE job_id IN (
      SELECT id FROM jobs WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users)
    );
    DELETE FROM job_steps WHERE job_id IN (
      SELECT id FROM jobs WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users)
    );
    DELETE FROM job_artifacts WHERE job_id IN (
      SELECT id FROM jobs WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users)
    );
    DELETE FROM jobs WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users);
  `)
  db.exec(`
    CREATE TABLE jobs__v15 (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    INSERT INTO jobs__v15 (id, user_id, title, prompt, status, progress, cancel_requested, created_at, updated_at, started_at, finished_at, error)
      SELECT id, user_id, title, prompt, status, progress, cancel_requested, created_at, updated_at, started_at, finished_at, error FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs__v15 RENAME TO jobs;
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status);
  `)
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

export function createUser({ id, email, now = Date.now() }) {
  const db = getDb()
  const stmt = db.prepare(
    'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at'
  )
  stmt.run(id, email, now, now)
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

/* ── User Tool Permissions (per-user 工具 gate) ── */

/**
 * 设置某用户对某工具的权限。enabled=false 表示显式禁用(默认放行,只存覆盖)。
 */
export function setUserToolPermission({ userId, toolName, enabled, now = Date.now() }) {
  const db = getDb()
  db.prepare(
    `INSERT INTO user_tool_permissions (user_id, tool_name, enabled, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, tool_name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).run(userId, toolName, enabled ? 1 : 0, now)
}

/**
 * 返回该用户的显式权限覆盖 map: { toolName: boolean }。只含显式设过的工具。
 */
export function getUserToolPermissions(userId) {
  const db = getDb()
  const rows = db
    .prepare('SELECT tool_name, enabled FROM user_tool_permissions WHERE user_id = ?')
    .all(userId)
  const map = {}
  for (const row of rows) map[row.tool_name] = !!row.enabled
  return map
}

/**
 * 工具是否对该用户放行。默认放行(无显式覆盖即 true);只有显式 enabled=0 才拒绝。
 */
export function isToolPermittedForUser(userId, toolName) {
  if (!userId) return true // 无用户上下文(系统/匿名内部调用)不 gate
  const db = getDb()
  const row = db
    .prepare('SELECT enabled FROM user_tool_permissions WHERE user_id = ? AND tool_name = ?')
    .get(userId, toolName)
  if (!row) return true
  return !!row.enabled
}

/* ── Sessions (auth tokens) ── */

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export function createSession({ token, userId, now = Date.now(), ttlMs = TOKEN_TTL_MS }) {
  const db = getDb()
  // 清理过期 session
  db.prepare('DELETE FROM sessions WHERE id IS NULL AND title IS NULL AND expires_at < ?').run(now)
  const stmt = db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at
     WHERE sessions.id IS NULL AND sessions.title IS NULL AND sessions.user_id = excluded.user_id`
  )
  const result = stmt.run(token, userId, now + ttlMs, now)
  if (result.changes !== 1) throw new Error('session token already exists')
  return { token, userId, expiresAt: now + ttlMs }
}

export function getSessionByToken(token, now = Date.now()) {
  const db = getDb()
  const stmt = db.prepare(`
    SELECT * FROM sessions
    WHERE token = ? AND id IS NULL AND title IS NULL AND expires_at > ?
  `)
  return stmt.get(token, now) || null
}

export function deleteSession(token) {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE token = ? AND id IS NULL AND title IS NULL').run(token)
}

export function deleteExpiredSessions(now = Date.now()) {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE id IS NULL AND title IS NULL AND expires_at < ?').run(now)
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
  const insertUser = db.prepare(
    'INSERT INTO users (id, email, credits, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, credits = excluded.credits'
  )
  const insertLedger = db.prepare(
    'INSERT OR IGNORE INTO ledger (id, user_id, type, package_id, model_name, credits, balance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  db.transaction(() => {
    for (const user of Object.values(store.users || {})) {
      const createdAt = user.createdAt || now
      insertUser.run(user.id, user.email, user.credits || 0, createdAt, createdAt)
    }
    for (const [token, userId] of Object.entries(store.sessions || {})) {
      createSession({ token, userId, now, ttlMs: TOKEN_TTL_MS })
    }
    for (const entry of store.ledger || []) {
      insertLedger.run(
        entry.id,
        entry.userId,
        entry.type,
        entry.packageId || null,
        entry.modelName || null,
        entry.credits,
        entry.balance,
        entry.createdAt || now,
      )
    }
  })()
}
