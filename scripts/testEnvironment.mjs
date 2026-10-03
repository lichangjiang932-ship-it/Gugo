import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { threadId } from 'node:worker_threads'

const configuredRoot = String(process.env.YMA_TEST_DATA_ROOT || '').trim()
const ownsRoot = !configuredRoot
const root = configuredRoot
  ? path.resolve(configuredRoot)
  : mkdtempSync(path.join(tmpdir(), 'yma-test-run-'))

mkdirSync(root, { recursive: true })
if (ownsRoot) {
  process.env.YMA_TEST_DATA_ROOT = root
  process.once('exit', () => {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best-effort test cleanup */ }
  })
}

const workerDir = mkdtempSync(path.join(root, `${process.pid}-${threadId}-`))
const artifactDir = path.join(workerDir, 'artifacts')
const outputDir = path.join(workerDir, 'output')
mkdirSync(artifactDir, { recursive: true })
mkdirSync(outputDir, { recursive: true })
// Keep every default temporary-file fallback inside this test process. This
// prevents parallel node:test workers from contending for shared lock files.
process.env.TMPDIR = workerDir
process.env.TMP = workerDir
process.env.TEMP = workerDir
process.env.APP_DATA_DIR = workerDir
process.env.APP_DB_PATH = path.join(workerDir, 'app.db')
// Verification tools invoke npm even in offline tests. Keep their debug cache
// and config lookup away from the developer's real npmrc and user cache.
process.env.npm_config_cache = path.join(workerDir, 'npm-cache')
process.env.npm_config_userconfig = path.join(workerDir, 'empty-user.npmrc')
process.env.npm_config_globalconfig = path.join(workerDir, 'empty-global.npmrc')
process.env.npm_config_update_notifier = 'false'
// Real artifact executors are exercised by several integration tests. Keep
// both their managed copies and default-output copies out of the checkout,
// including when a test imports this setup without the npm test wrapper.
process.env.ARTIFACT_DIR = artifactDir
process.env.YMA_TEST_DEFAULT_OUTPUT_DIR = outputDir
