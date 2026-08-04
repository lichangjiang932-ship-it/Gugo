import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { threadId } from 'node:worker_threads'

const root = process.env.YMA_TEST_DATA_ROOT
if (root) {
  const workerDir = path.join(root, `${process.pid}-${threadId}`)
  mkdirSync(workerDir, { recursive: true })
  process.env.APP_DATA_DIR = workerDir
  process.env.APP_DB_PATH = path.join(workerDir, 'app.db')
}
