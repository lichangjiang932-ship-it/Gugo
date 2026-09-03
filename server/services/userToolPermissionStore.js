export function createUserToolPermissionStore(getDb) {
  /** Set an explicit per-user tool permission override. */
  function setUserToolPermission({ userId, toolName, enabled, now = Date.now() }) {
    getDb().prepare(
      `INSERT INTO user_tool_permissions (user_id, tool_name, enabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, tool_name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
    ).run(userId, toolName, enabled ? 1 : 0, now)
  }

  /** Return only permissions that the user explicitly overrode. */
  function getUserToolPermissions(userId) {
    const rows = getDb()
      .prepare('SELECT tool_name, enabled FROM user_tool_permissions WHERE user_id = ?')
      .all(userId)
    const permissions = {}
    for (const row of rows) permissions[row.tool_name] = Boolean(row.enabled)
    return permissions
  }

  /** Missing overrides, including calls without user context, remain allowed. */
  function isToolPermittedForUser(userId, toolName) {
    if (!userId) return true
    const row = getDb()
      .prepare('SELECT enabled FROM user_tool_permissions WHERE user_id = ? AND tool_name = ?')
      .get(userId, toolName)
    return row ? Boolean(row.enabled) : true
  }

  return {
    getUserToolPermissions,
    isToolPermittedForUser,
    setUserToolPermission,
  }
}
