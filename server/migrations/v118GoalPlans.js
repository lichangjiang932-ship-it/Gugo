/**
 * Server-side goal plan with step-level evidence binding.
 *
 * A plan is versioned: a rewrite does not mutate steps in place, it creates a
 * new plan revision and marks the previous one `superseded`, so history stays
 * auditable. Every step status change is appended to `goal_plan_events`.
 *
 * Two independent counters, on purpose:
 *   - `revision` identifies a rewrite generation (1, 2, 3 ...) and is what
 *     `supersedes_plan_id` links across.
 *   - `version` is a row-level optimistic-lock counter bumped by every write,
 *     so a concurrent writer can fail closed instead of silently overwriting.
 *
 * Evidence is stored twice: `evidence_json` is the exact claim the caller
 * submitted, and the promoted `evidence_turn_id` / `evidence_tool_call_id`
 * columns exist so a partial unique index can stop one tool call from being
 * cited as proof for more than one step.
 */
export function migrateToV118(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_plans (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT,
      objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 8000),
      status TEXT NOT NULL CHECK (status IN (
        'awaiting_approval', 'approved', 'completed', 'blocked', 'cancelled', 'superseded'
      )),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      supersedes_plan_id TEXT REFERENCES goal_plans(id) ON DELETE SET NULL,
      approved_at INTEGER,
      approved_by TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_plans_user_updated
      ON goal_plans(user_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_goal_plans_user_session
      ON goal_plans(user_id, session_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS goal_plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES goal_plans(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'blocked', 'skipped')),
      evidence_json TEXT NOT NULL DEFAULT '{}',
      evidence_verified INTEGER NOT NULL DEFAULT 0 CHECK (evidence_verified IN (0, 1)),
      evidence_turn_id TEXT,
      evidence_tool_call_id TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      UNIQUE (plan_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_plan_steps_plan
      ON goal_plan_steps(plan_id, ordinal);
    -- One persisted tool call proves one step. A turn without a tool call can
    -- still support several steps, so the index is partial on the tool call id.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_plan_steps_evidence
      ON goal_plan_steps(user_id, evidence_turn_id, evidence_tool_call_id)
      WHERE evidence_tool_call_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS goal_plan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL REFERENCES goal_plans(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL CHECK (created_at >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_plan_events_plan
      ON goal_plan_events(plan_id, id);
  `)
}
