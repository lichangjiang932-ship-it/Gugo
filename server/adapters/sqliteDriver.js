function toPlainRow(row) {
  return row && typeof row === 'object' ? { ...row } : row
}

function wrapStatement(statement) {
  return {
    run: (...params) => statement.run(...params),
    get: (...params) => toPlainRow(statement.get(...params)),
    all: (...params) => statement.all(...params).map(toPlainRow),
    iterate: (...params) => (function* rows() {
      for (const row of statement.iterate(...params)) yield toPlainRow(row)
    }()),
  }
}

export function createNodeSqliteDatabase(DatabaseSync) {
  return class NodeSqliteDatabase {
    constructor(filename, options = {}) {
      this.database = new DatabaseSync(filename, options)
      this.savepointId = 0
      this.transactionDepth = 0
    }

    get inTransaction() {
      return this.transactionDepth > 0
    }

    prepare(sql) {
      return wrapStatement(this.database.prepare(sql))
    }

    exec(sql) {
      return this.database.exec(sql)
    }

    pragma(source, options = {}) {
      const rows = this.database.prepare(`PRAGMA ${source}`).all().map(toPlainRow)
      if (options.simple) return rows[0] ? Object.values(rows[0])[0] : undefined
      return rows
    }

    transaction(callback) {
      const run = (...args) => {
        const nested = this.transactionDepth > 0
        const savepoint = nested ? `gugo_tx_${++this.savepointId}` : null
        this.database.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN')
        this.transactionDepth += 1
        try {
          const result = callback(...args)
          this.database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
          return result
        } catch (error) {
          try {
            this.database.exec(nested
              ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`
              : 'ROLLBACK')
          } catch {
            // Keep the original transaction error.
          }
          throw error
        } finally {
          this.transactionDepth -= 1
        }
      }
      run.deferred = run
      run.immediate = (...args) => this.runTransactionMode('IMMEDIATE', callback, args)
      run.exclusive = (...args) => this.runTransactionMode('EXCLUSIVE', callback, args)
      return run
    }

    runTransactionMode(mode, callback, args) {
      if (this.transactionDepth > 0) return this.transaction(callback)(...args)
      this.database.exec(`BEGIN ${mode}`)
      this.transactionDepth += 1
      try {
        const result = callback(...args)
        this.database.exec('COMMIT')
        return result
      } catch (error) {
        try { this.database.exec('ROLLBACK') } catch { /* keep original error */ }
        throw error
      } finally {
        this.transactionDepth -= 1
      }
    }

    close() {
      return this.database.close()
    }
  }
}

async function resolveDatabaseDriver() {
  if (process.env.GUGO_SQLITE_DRIVER === 'node') {
    const { DatabaseSync } = await import('node:sqlite')
    return createNodeSqliteDatabase(DatabaseSync)
  }
  return (await import('better-sqlite3')).default
}

const Database = await resolveDatabaseDriver()

export default Database
