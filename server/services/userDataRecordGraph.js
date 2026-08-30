export function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function tableCatalog(db) {
  const definitions = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all()
  const virtualRoots = definitions
    .filter((entry) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(String(entry.sql || '')))
    .map((entry) => entry.name)
  return definitions
    .filter((entry) => !virtualRoots.some((root) => entry.name === root || entry.name.startsWith(`${root}_`)))
    .map((entry) => {
      const name = entry.name
      const quoted = quoteIdentifier(name)
      const columns = db.prepare(`PRAGMA table_info(${quoted})`).all()
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all()
      return {
        name,
        columns,
        columnNames: new Set(columns.map((column) => column.name)),
        foreignKeys,
      }
    })
}

export function rowKey(row) {
  return JSON.stringify(row, (_key, value) => (
    Buffer.isBuffer(value) ? { __gugoBinary: value.toString('base64') } : value
  ))
}

function mergeRows(target, rows) {
  const seen = new Set(target.map(rowKey))
  let added = 0
  for (const row of rows) {
    const key = rowKey(row)
    if (seen.has(key)) continue
    target.push(row)
    seen.add(key)
    added += 1
  }
  return added
}

export function foreignKeyGroups(table) {
  const groups = new Map()
  for (const entry of table.foreignKeys) {
    const id = Number(entry.id)
    const group = groups.get(id) || []
    group.push(entry)
    groups.set(id, group)
  }
  return [...groups.values()].map((group) => (
    group.sort((left, right) => Number(left.seq) - Number(right.seq))
  ))
}

export function primaryKeyColumns(table) {
  return table.columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
}

function chatSessionPredicate(table) {
  if (table.name !== 'sessions') return null
  const columns = ['id', 'title'].filter((name) => table.columnNames.has(name))
  if (!columns.length) return '0 = 1'
  return `(${columns.map((name) => `${quoteIdentifier(name)} IS NOT NULL`).join(' OR ')})`
}

export function userOwnershipColumn(table) {
  if (table.columnNames.has('user_id')) return 'user_id'
  if (table.name === 'side_effect_executions' && table.columnNames.has('owner_id')) return 'owner_id'
  return null
}

function rowsForUser(db, table, userId) {
  const ownerColumn = userOwnershipColumn(table)
  if (!ownerColumn) return []
  const predicates = [`${quoteIdentifier(ownerColumn)} IS ?`]
  const sessionPredicate = chatSessionPredicate(table)
  if (sessionPredicate) predicates.push(sessionPredicate)
  return db.prepare(`
    SELECT * FROM ${quoteIdentifier(table.name)}
    WHERE ${predicates.join(' AND ')}
  `).all(userId)
}

function rowsForRelation(db, child, mappings, parentRows, userId) {
  const tuples = []
  const seen = new Set()
  for (const row of parentRows) {
    const tuple = mappings.map(({ parentColumn }) => row[parentColumn])
    if (tuple.some((value) => value === null || value === undefined)) continue
    const key = rowKey(tuple)
    if (seen.has(key)) continue
    seen.add(key)
    tuples.push(tuple)
  }
  const rows = []
  const chunkSize = Math.max(1, Math.floor(400 / mappings.length))
  for (let offset = 0; offset < tuples.length; offset += chunkSize) {
    const chunk = tuples.slice(offset, offset + chunkSize)
    const relationPredicate = chunk.map(() => `(
      ${mappings.map(({ childColumn }) => `${quoteIdentifier(childColumn)} IS ?`).join(' AND ')}
    )`).join(' OR ')
    const predicates = [`(${relationPredicate})`]
    const parameters = chunk.flat()
    const ownerColumn = userOwnershipColumn(child)
    if (ownerColumn) {
      predicates.push(`${quoteIdentifier(ownerColumn)} IS ?`)
      parameters.push(userId)
    }
    const sessionPredicate = chatSessionPredicate(child)
    if (sessionPredicate) predicates.push(sessionPredicate)
    rows.push(...db.prepare(`
      SELECT * FROM ${quoteIdentifier(child.name)}
      WHERE ${predicates.join(' AND ')}
    `).all(...parameters))
  }
  return rows
}

function isSensitiveUserAuthenticationColumn(name) {
  const normalized = String(name || '').toLowerCase()
  return normalized.includes('password')
    || /(?:auth(?:entication)?|access|refresh|session)[_-]?token/.test(normalized)
    || /(?:mfa|totp)[_-]?(?:secret|seed|key)/.test(normalized)
    || /recovery[_-]?codes?/.test(normalized)
    || /private[_-]?key/.test(normalized)
    || normalized.includes('credential')
}

function sanitizeUserRecord(user) {
  const record = {}
  const removedFields = []
  for (const [name, value] of Object.entries(user)) {
    if (isSensitiveUserAuthenticationColumn(name)) {
      removedFields.push(name)
      continue
    }
    record[name] = value
  }
  return { record, removedFields: removedFields.sort() }
}

function userNotFoundError() {
  const error = new Error('User does not exist')
  error.code = 'USER_DATA_USER_NOT_FOUND'
  error.statusCode = 404
  return error
}

export function collectDatabaseRows(db, userId, { excludedTables = [] } = {}) {
  const excluded = new Set(excludedTables.map((name) => String(name)))
  const catalog = tableCatalog(db)
  const byName = new Map(catalog.map((table) => [table.name, table]))
  const records = new Map()
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  if (!user) throw userNotFoundError()
  const sanitizedUser = sanitizeUserRecord(user)
  records.set('users', [sanitizedUser.record])

  for (const table of catalog) {
    if (excluded.has(table.name)) continue
    if (!userOwnershipColumn(table)) continue
    records.set(table.name, rowsForUser(db, table, userId))
  }

  let changed = true
  while (changed) {
    changed = false
    for (const child of catalog) {
      if (excluded.has(child.name)) continue
      for (const group of foreignKeyGroups(child)) {
        const parentName = group[0]?.table
        const parentRows = records.get(parentName)
        const parent = byName.get(parentName)
        if (!parentRows?.length || !parent) continue
        const parentPrimaryKey = primaryKeyColumns(parent)
        const mappings = group.map((foreignKey, index) => ({
          childColumn: foreignKey.from,
          parentColumn: foreignKey.to || parentPrimaryKey[index]?.name,
        }))
        if (mappings.some(({ childColumn, parentColumn }) => (
          !childColumn || !parentColumn || !child.columnNames.has(childColumn)
        ))) continue
        const related = rowsForRelation(db, child, mappings, parentRows, userId)
        if (!related.length) continue
        const target = records.get(child.name) || []
        if (mergeRows(target, related) > 0) changed = true
        records.set(child.name, target)
      }
    }
  }

  return {
    catalog,
    excludedTables: [...excluded].sort(),
    redactedFields: { users: sanitizedUser.removedFields },
    records: Object.fromEntries(
      [...records.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, rows]) => [name, rows]),
    ),
  }
}

export function sanitizeExportDatabase({ records, redactedFields, excludedTables = [] }) {
  return {
    records,
    redactedFields,
    excludedTables,
  }
}
