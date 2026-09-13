import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import Database from 'better-sqlite3'

// Test-only transport failure, scoped to one file in a freshly generated root.
// Production tool execution, ledger transitions and recovery are unmodified.
const root = fs.realpathSync(process.env.GUGO_CLI_INLINE_TEST_ROOT)
assert.ok(path.basename(root).startsWith('gugo-cli-inline-e2e-'))
const target = path.join(root, 'workspace', 'unknown-target.txt')
const trace = path.join(root, 'write-attempts.jsonl')
assert.equal(path.resolve(process.env.APP_DB_PATH), path.join(root, 'data', 'app.db'))
assert.equal(fs.realpathSync(process.cwd()), path.join(root, 'workspace'))
const originalWrite = fs.writeFileSync
const append = fs.appendFileSync
let attempt = 0
fs.writeFileSync = function fixtureWriteFault(file, ...args) {
  if (typeof file !== 'string' || path.resolve(file) !== target) return originalWrite.call(this, file, ...args)
  attempt += 1
  const performed = attempt > 1 || process.env.GUGO_CLI_INLINE_FAULT !== 'before'
  if (performed) originalWrite.call(this, file, ...args)
  append(trace, `${JSON.stringify({ attempt, performed })}\n`)
  if (!performed) throw Object.assign(new Error('Fixture write transport failed before writing the target.'), {
    code: 'CLI_FIXTURE_WRITE_DISCONNECTED',
  })
}

const originalPrepare = Database.prototype.prepare
let failedCommit = false
Database.prototype.prepare = function prepareWithFixtureFault(sql) {
  const statement = originalPrepare.call(this, sql)
  if (this.name !== process.env.APP_DB_PATH || !/UPDATE side_effect_executions\s+SET status = \?, outcome_json/u.test(sql)
    || !sql.includes("status = 'executing'")) return statement
  const originalRun = statement.run
  statement.run = function failExactOutcomeCommit(...params) {
    if (!failedCommit && params.at(-1) === 'inline-unknown-write') {
      failedCommit = true
      process.stderr.write(`[fixture probe] actualTargetExists=${fs.existsSync(target)}; actualWriteAttempts=${attempt}\n`)
      throw Object.assign(new Error('Fixture disconnected while persisting this tool outcome.'), { code: 'CLI_FIXTURE_OUTCOME_COMMIT_FAILED' })
    }
    return originalRun.apply(this, params)
  }
  return statement
}
syncBuiltinESMExports()
