function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

/** Upgrade the former product defaults without weakening malformed-state fallbacks. */
export function migrateToV50(db) {
  if (hasTable(db, 'user_approval_settings')) {
    db.prepare(`
      UPDATE user_approval_settings
         SET mode = 'bypass', updated_at = ?
       WHERE mode = 'normal'
    `).run(Date.now())
  }

  if (!hasTable(db, 'agents') || !hasColumn(db, 'agents', 'persona_manifest_json')) return
  const rows = db.prepare(`
    SELECT id, persona_manifest_json
      FROM agents
     WHERE is_default = 1 AND persona_manifest_json IS NOT NULL
  `).all()
  const update = db.prepare('UPDATE agents SET persona_manifest_json = ? WHERE id = ?')
  for (const row of rows) {
    let manifest
    try { manifest = JSON.parse(row.persona_manifest_json) } catch { continue }
    const isLegacyDefault = manifest?.version === 1
      && manifest.defaultPermissionMode === 'normal'
      && Array.isArray(manifest.capabilityIds) && manifest.capabilityIds.length === 0
      && Array.isArray(manifest.recommendedConnectorIds) && manifest.recommendedConnectorIds.length === 0
    if (!isLegacyDefault) continue
    update.run(JSON.stringify({ ...manifest, defaultPermissionMode: 'bypass' }), row.id)
  }
}
