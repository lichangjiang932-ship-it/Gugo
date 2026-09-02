export function createUserAccountStore(getDb) {
  function getUserById(id) {
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) || null
  }

  function getUserByEmail(email) {
    return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) || null
  }

  function createUser({ id, email, now = Date.now() }) {
    getDb().prepare(
      'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at'
    ).run(id, email, now, now)
    return getUserById(id)
  }

  function setUserPassword({ id, passwordHash, passwordSalt, now = Date.now() }) {
    getDb().prepare(
      'UPDATE users SET password_hash = ?, password_salt = ?, password_set_at = ?, updated_at = ? WHERE id = ?'
    ).run(passwordHash, passwordSalt, now, now, id)
    return getUserById(id)
  }

  function clearUserPassword({ id, now = Date.now() }) {
    getDb().prepare(
      'UPDATE users SET password_hash = NULL, password_salt = NULL, password_set_at = NULL, updated_at = ? WHERE id = ?'
    ).run(now, id)
    return getUserById(id)
  }

  return {
    clearUserPassword,
    createUser,
    getUserByEmail,
    getUserById,
    setUserPassword,
  }
}
