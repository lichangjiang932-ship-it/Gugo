import assert from 'node:assert/strict'
import test from 'node:test'
import { createEmptyAgentDraft } from '../src/pages/agents/useAgentListController.js'

test('new Agent drafts default to normal permission mode without sharing manifest state', () => {
  const first = createEmptyAgentDraft()
  const second = createEmptyAgentDraft()

  assert.equal(first.personaManifest.defaultPermissionMode, 'normal')
  assert.notEqual(first.personaManifest, second.personaManifest)
  assert.notEqual(first.personaManifest.capabilityIds, second.personaManifest.capabilityIds)
  assert.notEqual(first.personaManifest.recommendedConnectorIds, second.personaManifest.recommendedConnectorIds)
})
