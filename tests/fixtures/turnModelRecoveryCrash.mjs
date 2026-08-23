import fs from 'node:fs'

const markerPath = String(process.env.TURN_MODEL_RECOVERY_MARKER || '').trim()
if (!markerPath) throw new Error('TURN_MODEL_RECOVERY_MARKER is required')

const { createUser } = await import('../../server/db.js')
const { TurnEngine } = await import('../../server/services/TurnEngine.js')
const { runToolLoop } = await import('../../server/services/loop/index.js')
const { upsertSession } = await import('../../server/services/sessionStore.js')
const { createTurnExecutionLeaseCoordinator } = await import('../../server/services/turnExecutionLeaseRuntime.js')

const userId = 'turn-model-recovery-runtime-user'
const sessionId = 'turn-model-recovery-runtime-session'
const turnId = 'turn-model-recovery-runtime-turn'
const toolImplementations = Object.freeze({
  version: 1,
  builtinRevision: `sha256-${'a'.repeat(64)}`,
  connectorRevision: null,
  mcpTools: [],
})

createUser({ id: userId, email: 'turn-model-recovery-runtime@example.test' })
upsertSession({ id: sessionId, userId, title: 'Turn model recovery runtime' })

const engine = new TurnEngine({
  runLoop: runToolLoop,
  scheduleMemoryExtraction: () => {},
  executionLeases: createTurnExecutionLeaseCoordinator({
    ownerId: 'turn-model-recovery-crashed-worker',
    leaseMs: 1_000,
  }),
  toolSpecs: [],
  readApprovalMode: () => 'normal',
  readFileAccessStatus: () => ({ grants: [] }),
  readRuntimePlugins: () => [],
  readRuntimePluginStates: () => [],
  resolveToolSpecs: async () => [],
  resolveToolImplementationRevisions: () => toolImplementations,
  runModel: async () => {
    fs.writeFileSync(markerPath, JSON.stringify({
      providerCalls: 1,
      response: { content: 'manually verified turn response', toolCalls: [] },
      receipt: { providerRequestId: 'turn-provider-request-1' },
    }))
    process.exit(86)
  },
})

await engine.startTurn({
  userId,
  sessionId,
  turnId,
  content: 'recover this turn without another provider request',
  modelName: 'turn-recovery-model',
})
await engine.waitForTurn({ userId, sessionId, turnId })
throw new Error('the crash boundary was not reached')
