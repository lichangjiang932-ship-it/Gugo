import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { threadId } from 'node:worker_threads'

const root = process.env.YMA_TEST_DATA_ROOT
if (root) {
  mkdirSync(root, { recursive: true })
  const workerDir = mkdtempSync(path.join(root, `${process.pid}-${threadId}-`))
  const artifactDir = path.join(workerDir, 'artifacts')
  const outputDir = path.join(workerDir, 'output')
  mkdirSync(artifactDir, { recursive: true })
  mkdirSync(outputDir, { recursive: true })
  process.env.APP_DATA_DIR = workerDir
  process.env.APP_DB_PATH = path.join(workerDir, 'app.db')
  // Real artifact executors are exercised by several integration tests. Keep
  // both their managed copies and default-output copies out of the checkout.
  process.env.ARTIFACT_DIR = artifactDir
  process.env.YMA_TEST_DEFAULT_OUTPUT_DIR = outputDir
}
