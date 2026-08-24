import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')

test('first-party evolution workbench is a replaceable settings contribution', () => {
  const registry = read('../src/plugins/firstPartyUiContributions.js')
  const panel = [
    '../src/components/settings/SettingsEvolutionPanel.jsx',
    '../src/components/settings/evolutionPanel/useEvolutionSnapshot.js',
    '../src/components/settings/evolutionPanel/useEvolutionCanary.js',
    '../src/components/settings/evolutionPanel/useEvolutionPromotion.js',
  ].map(read).join('\n')
  assert.match(registry, /ui:settings-section:evolution-settings/)
  assert.match(registry, /slot: 'settings-section'/)
  assert.match(registry, /sectionId: 'evolution'/)
  assert.match(panel, /listEvolutionEvidenceApi/)
  assert.match(panel, /listEvolutionCandidatesApi/)
  assert.match(panel, /listEvolutionEvaluationsApi/)
  assert.match(panel, /listEvolutionApprovalsApi/)
  assert.match(panel, /listEvolutionCanariesApi/)
  assert.match(panel, /createEvolutionCanaryRollbackPolicyApi/)
  assert.match(panel, /getEvolutionPromotionReviewApi/)
  assert.match(panel, /createEvolutionPromotionApi/)
  assert.match(panel, /revokeEvolutionPromotionApi/)
})
