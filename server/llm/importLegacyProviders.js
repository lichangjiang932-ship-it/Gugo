import { listModelProviders } from '../services/modelProviderStore.js'
import { isValidProviderId } from '../../shared/llmProviderCatalog.js'
import { providersFromSettings, readSettings, writeSettings } from './llmConfigStore.js'
import { setCredential } from './llmProviderService.js'

/**
 * Bring providers that only exist in the old `model_providers` table into
 * settings.yaml, so the configuration page shows what the user already has.
 *
 * Idempotent by construction: a provider whose derived id is already in the
 * file is skipped, never overwritten, so running it twice changes nothing.
 */
export function legacyProviderId(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
}

export function importLegacyProviders({ userId, env = process.env, listImpl = listModelProviders } = {}) {
  // A disabled provider still counts as skipped: the reader is told what was
  // left behind, not just what arrived.
  const rows = typeof userId === 'string' && userId
    ? (listImpl({ userId, includeSecrets: true }) || []).filter(Boolean)
    : []
  const settings = readSettings(env)
  const providers = { ...providersFromSettings(settings) }
  let imported = 0
  let skipped = 0
  let credentials = 0
  for (const row of rows) {
    if (row.enabled === false) {
      skipped += 1
      continue
    }
    const id = legacyProviderId(row.key || row.id)
    if (!id || !isValidProviderId(id) || providers[id]) {
      skipped += 1
      continue
    }
    providers[id] = {
      displayName: String(row.label || id),
      api: 'openai-completions',
      baseURL: String(row.baseUrl || ''),
      apiKeyEnv: '',
      custom: true,
      models: (Array.isArray(row.models) ? row.models : []).map((model) => ({ id: String(model) })),
    }
    if (row.apiKey) {
      setCredential(id, row.apiKey, env)
      credentials += 1
    }
    if (row.isDefault && row.defaultModel) {
      settings['agent-default-model'] = { provider: id, model: String(row.defaultModel) }
    }
    imported += 1
  }
  writeSettings({ ...settings, llm: { ...(settings.llm || {}), providers } }, env)
  return { imported, skipped, credentials }
}
