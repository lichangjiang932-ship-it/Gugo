import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAssistantModelContext } from '../server/services/turnMessageContext.js'
import { normalizeServerSessionSnapshot } from '../src/lib/turnClient/sessionSnapshot.js'
import { compilerReuse } from '../shared/promptCompilerDiagnostics.js'
const wire = { version: 1, stage: 'wire', comparisonScope: 'same_owner_endpoint_model_config', prefixKind: 'leading_instructions', available: true, truncated: false, bodyBytes: 100,
  identityComparable: true, prefixBlocks: 1, messageCount: 2, toolCount: 0, ownerScopeFingerprint: 'a'.repeat(64), endpointFingerprint: 'b'.repeat(64), modelFingerprint: 'c'.repeat(64),
  configFingerprint: 'd'.repeat(64), bodyFingerprint: 'e'.repeat(64), prefixFingerprint: 'f'.repeat(64), toolsFingerprint: '0'.repeat(64) }
test('public diagnostics survive host message JSON persistence and actual snapshot hydration', () => {
  const context = buildAssistantModelContext({ turnId: 't', checkpointMessages: [], verifiedLocalFiles: [], requestDiagnostics: {
    modelWireDiagnostics: wire, modelCompilerDiagnostics: compilerReuse('checkpoint_reuse'), PRIVATE_KEY: 'never persist' } })
  assert.equal(context.modelWireDiagnostics.prefixFingerprint, wire.prefixFingerprint)
  assert.equal(context.PRIVATE_KEY, undefined)
  const message = JSON.parse(JSON.stringify({ id: 't:assistant', role: 'assistant', content: 'Public output', modelContext: context, createdAt: 1 }))
  const snapshot = normalizeServerSessionSnapshot({ complete: true, revision: 1, session: { id: 's' }, messages: [message] })
  assert.equal(snapshot.messages[0].meta.modelWireDiagnostics.prefixFingerprint, wire.prefixFingerprint)
  assert.equal(snapshot.messages[0].meta.modelCompilerDiagnostics.source, 'checkpoint_reuse')
})
test('invalid or future diagnostics degrade to absent display evidence without affecting execution evidence', () => {
  const context = buildAssistantModelContext({ turnId: 't', checkpointMessages: [], verifiedLocalFiles: [], requestDiagnostics: { modelWireDiagnostics: { ...wire, version: 99 } } })
  assert.equal(context.modelWireDiagnostics, undefined)
  assert.deepEqual(context.verifiedLocalFiles, [])
})
