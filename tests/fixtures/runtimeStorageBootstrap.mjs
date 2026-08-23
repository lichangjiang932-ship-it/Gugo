import { closeDb } from '../../server/db.js'
import { runRuntimeConfigStartupPreflight } from '../../server/services/runtimeConfigStartupService.js'

const { runtimeEnv } = runRuntimeConfigStartupPreflight({
  cwd: process.cwd(),
  env: {},
})

process.stdout.write(`${JSON.stringify({
  appDataDir: runtimeEnv.APP_DATA_DIR,
  appDbPath: runtimeEnv.APP_DB_PATH,
})}\n`)
closeDb()
