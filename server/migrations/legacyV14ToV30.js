import { hasColumn } from './index.js'
import { setSchemaVersionInternal } from './legacyV2ToV13.js'

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

export const LEGACY_SCHEMA_MIGRATIONS_V14_TO_V30 = [
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
]
