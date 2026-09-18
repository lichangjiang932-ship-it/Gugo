/** A diagnostic must not create WAL/SHM files merely by opening a read-only database. */
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createNodeSqliteDatabase } from '../adapters/sqliteDriver.js'

const MAX_MEMORY_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_EXPLICIT_MEMORY_IMAGE_BYTES = 128 * 1024 * 1024

function readerError(code) {
  return Object.assign(new Error('A side-effect-free database inspection is unavailable.'), { code, retryable: false })
}

function stamp(filename) {
  try {
    const stat = fs.statSync(filename)
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

function sourceStamp(filename) {
  return { database: stamp(filename), wal: stamp(`${filename}-wal`), journal: stamp(`${filename}-journal`) }
}

export function assertNoDoctorSqliteRecovery(filename) {
  if ((stamp(`${filename}-journal`)?.[2] || 0) > 0) throw readerError('DOCTOR_SQLITE_RECOVERY_REQUIRED')
}

export async function openDoctorDatabaseReader(filename, { integrity = false,
  loadNodeSqlite = () => import('node:sqlite'), loadBetterSqlite = () => import('better-sqlite3') } = {}) {
  const before = sourceStamp(filename)
  if (!before.database) throw readerError('DOCTOR_DATABASE_NOT_INITIALIZED')
  if ((before.journal?.[2] || 0) > 0) throw readerError('DOCTOR_SQLITE_RECOVERY_REQUIRED')
  // immutable reads intentionally ignore WAL. Never use one against a live WAL
  // and then present the older main-file image as the current configuration.
  if ((before.wal?.[2] || 0) > 0) throw readerError('DOCTOR_ACTIVE_WAL_UNAVAILABLE')
  let native = null
  try { native = await loadNodeSqlite() } catch (error) {
    if (!['ERR_UNKNOWN_BUILTIN_MODULE', 'ERR_MODULE_NOT_FOUND'].includes(error?.code)) throw error
  }
  let db
  let mode
  if (native?.DatabaseSync) {
    const uri = pathToFileURL(filename)
    uri.searchParams.set('mode', 'ro')
    uri.searchParams.set('immutable', '1')
    const Driver = createNodeSqliteDatabase(native.DatabaseSync)
    db = new Driver(uri.href, { readOnly: true })
    mode = 'node_sqlite_immutable'
  } else {
    const maximum = integrity ? MAX_EXPLICIT_MEMORY_IMAGE_BYTES : MAX_MEMORY_IMAGE_BYTES
    if (before.database[2] > maximum) throw readerError('DOCTOR_READONLY_IMAGE_LIMIT')
    const image = fs.readFileSync(filename)
    if (image.length > maximum) throw readerError('DOCTOR_READONLY_IMAGE_LIMIT')
    // A fully checkpointed WAL main-file has the same pages as a rollback-mode
    // image. Deserialization cannot use WAL: adjust only the in-memory header,
    // never the source bytes, after ruling out a live WAL/hot journal above.
    if (image.subarray(0, 16).toString('binary') === 'SQLite format 3\0' && image[18] === 2 && image[19] === 2) {
      image[18] = 1
      image[19] = 1
    }
    const { default: Driver } = await loadBetterSqlite()
    db = new Driver(image, { readonly: true })
    mode = 'bounded_memory_snapshot'
  }
  try { db.pragma('query_only = ON') } catch (error) { db.close(); throw error }
  return { database: db, mode, unchanged: () => JSON.stringify(before) === JSON.stringify(sourceStamp(filename)) }
}
