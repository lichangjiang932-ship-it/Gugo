import { closeDb } from '../../server/db.js'
import { runRuntimeConfigStartupPreflight } from '../../server/services/runtimeConfigStartupService.js'

const { runtimeEnv } = runRuntimeConfigStartupPreflight({
  cwd: process.cwd(),
  env: {},
})
const { ARTIFACT_DIR } = await import('../../server/services/artifactStorage.js')

process.stdout.write(`${JSON.stringify({
  appDataDir: runtimeEnv.APP_DATA_DIR,
  appDbPath: runtimeEnv.APP_DB_PATH,
  artifactDir: runtimeEnv.ARTIFACT_DIR,
  importedArtifactDir: ARTIFACT_DIR,
})}\n`)
closeDb()
