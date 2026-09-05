import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const runtimeSource = readFileSync(
  new URL('../server/services/subagentRuntime.js', import.meta.url),
  'utf8',
)
const runStateSource = readFileSync(
  new URL('../server/services/subagentRunState.js', import.meta.url),
  'utf8',
)
const portSource = readFileSync(
  new URL('../server/core/subagentRunPersistencePort.js', import.meta.url),
  'utf8',
)
const startupSource = readFileSync(
  new URL('../server/services/runtimeServerStartup.js', import.meta.url),
  'utf8',
)
const appServerSource = readFileSync(
  new URL('../server/appServer.js', import.meta.url),
  'utf8',
)
const appServerStartSupportSource = readFileSync(
  new URL('../server/appServerStartSupport.js', import.meta.url),
  'utf8',
)

test('subagent runtime owns no concrete database or subagent_runs SQL dependency', () => {
  const runtimeBoundarySource = `${runtimeSource}\n${runStateSource}`
  assert.doesNotMatch(runtimeBoundarySource, /from ['"]\.\.\/db\.js['"]/u)
  assert.doesNotMatch(runtimeBoundarySource, /\bsubagent_runs\b/u)
  assert.doesNotMatch(runtimeBoundarySource, /\.prepare\s*\(/u)
  assert.match(runStateSource, /getActiveSubagentRunPersistencePort/u)
  assert.match(runStateSource, /prepareSubagentRunPersistencePort/u)
})

test('core subagent persistence port remains free of adapter, service, and database imports', () => {
  assert.doesNotMatch(portSource, /from ['"][^'"]*(?:adapters|services|db\.js)/u)
  assert.doesNotMatch(portSource, /import\s*\(/u)
  assert.doesNotMatch(portSource, /\bsubagent_runs\b/u)
})

test('trusted startup selects one subagent adapter and passes it through the app composition root', () => {
  assert.match(startupSource, /resolveSubagentRunPersistenceAdapter\(dependencies\)/u)
  assert.match(
    startupSource,
    /startAppServer\(\{[\s\S]*?subagentRunPersistenceAdapter,[\s\S]*?\}\)/u,
  )
  assert.match(
    appServerSource,
    /bootstrap\(\{[\s\S]*?subagentRunPersistenceAdapter,[\s\S]*?\}\)/u,
  )
  assert.match(
    appServerStartSupportSource,
    /APP_SUBAGENT_RUN_PERSISTENCE_BOOTSTRAP_REQUIRED/u,
  )
})
