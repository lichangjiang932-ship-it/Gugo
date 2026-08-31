import { hasColumn } from './index.js'

export function setSchemaVersionInternal(db, version) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('schema_version', String(version))
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

export const LEGACY_SCHEMA_MIGRATIONS_V2_TO_V13 = [
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
]
