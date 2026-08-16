import assert from 'node:assert/strict'
import test from 'node:test'

import { groupModelOptions, modelProviderLabel } from '../src/pages/ChatSplit/modelPickerGroups.js'

test('model picker groups configured models by provider while preserving group and model order', () => {
  const alpha = { name: 'alpha', provider: 'cloud-main', providerLabel: 'Cloud Main' }
  const beta = { name: 'beta', provider: 'local-lab', providerLabel: 'Local Lab' }
  const gamma = { name: 'gamma', provider: 'cloud-main', providerLabel: 'Cloud Main' }

  const groups = groupModelOptions([alpha, beta, gamma])

  assert.deepEqual(groups.map(({ key, label, startIndex, models }) => ({
    key,
    label,
    startIndex,
    models: models.map((model) => model.name),
  })), [
    { key: 'cloud-main', label: 'Cloud Main', startIndex: 0, models: ['alpha', 'gamma'] },
    { key: 'local-lab', label: 'Local Lab', startIndex: 2, models: ['beta'] },
  ])
})

test('model picker labels known providers and keeps unscoped models in the default group', () => {
  assert.equal(modelProviderLabel('openai'), 'OpenAI')
  assert.equal(modelProviderLabel('private_gateway'), 'Private Gateway')
  assert.deepEqual(groupModelOptions([{ name: 'fallback' }]).map((group) => ({
    key: group.key,
    label: group.label,
    startIndex: group.startIndex,
  })), [{ key: '__default__', label: '', startIndex: 0 }])
})
