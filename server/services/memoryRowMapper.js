/** Shared SQLite memory row → public memory projection. */

export function row2memory(row) {
  if (!row) return null
  let frontmatter = {}
  try { frontmatter = row.frontmatter_json ? JSON.parse(row.frontmatter_json) : {} } catch { /* keep empty */ }
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    slug: row.slug,
    body: row.body,
    frontmatter,
    pinned: !!row.pinned,
    sourceSessionId: row.source_session_id || null,
    sourceMessageId: row.source_message_id || null,
    agentId: row.agent_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }
}
