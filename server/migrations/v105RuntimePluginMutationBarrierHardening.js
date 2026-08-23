import { migrateToV103 } from './v103RuntimePluginMutationBarrier.js'

const IDENTITY_TABLES = Object.freeze([
  'runtime_plugin_states',
  'runtime_plugin_releases',
  'runtime_plugin_release_pins',
  'runtime_plugin_permission_grants',
])

const JSON_REFERENCES = Object.freeze([
  ['turn_checkpoints', 'state_json'],
  ['job_turn_checkpoints', 'state_json'],
  ['turn_events', 'payload_json'],
  ['event_write_failures', 'checkpoint_state_json'],
  ['event_write_failures', 'payload_json'],
])

function v103TriggerNames() {
  const names = [
    'trg_runtime_plugin_states_release_identity_insert',
    'trg_runtime_plugin_states_release_identity_update',
    'trg_runtime_plugin_mutation_barrier_generation_insert',
    'trg_runtime_plugin_mutation_barrier_generation_update',
    'trg_runtime_plugin_mutation_barrier_generation_delete',
    'trg_runtime_plugin_mutation_barrier_generation_match_insert',
    'trg_runtime_plugin_mutation_barrier_generation_claim_insert',
    'trg_runtime_plugin_mutation_barrier_generation_identity_update',
    'trg_runtime_plugin_mutation_barrier_phase_update',
  ]
  for (const table of IDENTITY_TABLES) {
    names.push(
      `trg_${table}_plugin_mutation_barrier_insert`,
      `trg_${table}_plugin_mutation_barrier_update`,
    )
  }
  for (const [table, column] of JSON_REFERENCES) {
    const base = `trg_${table}_${column}_plugin_mutation_barrier`
    names.push(
      `${base}_insert_invalid_json`,
      `${base}_insert`,
      `${base}_update_invalid_json`,
      `${base}_update`,
    )
  }
  return names
}

/**
 * Re-apply the complete barrier trigger contract for databases that already
 * ran an earlier v103 draft. The first pass validates existing identities
 * before any trigger is dropped; the migration runner supplies one IMMEDIATE
 * transaction while the final pass recreates the authoritative definitions.
 */
export function migrateToV105(db) {
  migrateToV103(db)
  db.exec(v103TriggerNames().map((name) => `DROP TRIGGER IF EXISTS ${name};`).join('\n'))
  migrateToV103(db)
}
