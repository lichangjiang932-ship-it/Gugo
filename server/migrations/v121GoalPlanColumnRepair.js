/**
 * Add the goal-plan columns that an already-created table never received.
 *
 * v118 defines `goal_plans` and `goal_plan_steps` with `CREATE TABLE IF NOT
 * EXISTS`. That is a no-op whenever the table is already there — which is exactly
 * the case on any install that had these tables from an earlier build. Those
 * databases kept the old shape and never gained `version`, `approved_by`, or the
 * promoted evidence columns.
 *
 * The consequence was not a degraded feature but a dead one: every plan write
 * fails with `table goal_plans has no column named version`, so plans could not be
 * created, approved, or advanced at all. Reading appeared to work (the reads select
 * `*`), which is why it looked like "no plan yet" rather than an error.
 *
 * Additive and idempotent on purpose: each column is added only when it is absent,
 * so a database created from the current v118 is untouched by this migration.
 */
export function migrateToV121(db) {
  const hasColumn = (table, name) => db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .some((column) => column.name === name)

  const addColumnIfMissing = (table, name, definition) => {
    if (hasColumn(table, name)) return false
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
    return true
  }

  addColumnIfMissing('goal_plans', 'version', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('goal_plans', 'approved_by', 'TEXT')
  addColumnIfMissing('goal_plan_steps', 'evidence_turn_id', 'TEXT')
  addColumnIfMissing('goal_plan_steps', 'evidence_tool_call_id', 'TEXT')

  // This index is what stops one tool call from being cited as proof for two
  // different steps. It could not be created while its columns did not exist, so
  // a repaired database would otherwise silently lose that rule. The columns are
  // new and therefore empty, so creating it cannot collide with existing rows.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_plan_steps_evidence
      ON goal_plan_steps(user_id, evidence_turn_id, evidence_tool_call_id)
      WHERE evidence_tool_call_id IS NOT NULL;
  `)
}
