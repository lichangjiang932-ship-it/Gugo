import {
  envPrefix,
  normalizeModelProfiles,
  parseModels,
  parseSubmittedModelProviderInteger,
  VALID_KINDS,
  writeTribool,
} from './modelProviderConfig.js'

export function assertProviderKeyAvailable({ db, userId, key, existing, env }) {
  const sameKey = db.prepare(
    'SELECT * FROM model_providers WHERE user_id = ? AND provider_key = ?',
  ).get(userId, key)
  if (sameKey && sameKey.id !== existing?.id) throw new Error(`Provider ID ${key} 已存在`)
  const runtimePrefix = envPrefix(key)
  const prefixConflict = db.prepare(
    'SELECT id, provider_key FROM model_providers WHERE user_id = ?',
  ).all(userId).find((row) => (
    row.id !== existing?.id && envPrefix(row.provider_key) === runtimePrefix
  ))
  if (prefixConflict) {
    throw Object.assign(
      new Error(`Provider ID ${key} 与 ${prefixConflict.provider_key} 会映射到同一运行时标识，请更换 ID。`),
      { code: 'MODEL_PROVIDER_KEY_COLLISION', statusCode: 409, field: 'key' },
    )
  }
  const environmentKeyConflict = String(env?.MODEL_PROVIDERS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .find((environmentKey) => environmentKey !== key && envPrefix(environmentKey) === runtimePrefix)
  if (environmentKeyConflict) {
    throw Object.assign(
      new Error(`Provider ID ${key} 与环境配置 ${environmentKeyConflict} 会映射到同一运行时标识，请更换 ID。`),
      {
        code: 'MODEL_PROVIDER_ENV_KEY_COLLISION',
        statusCode: 409,
        field: 'key',
        conflictingProviderKey: environmentKeyConflict,
      },
    )
  }
}

export function resolveProviderRuntimeOptions(provider, existing, models) {
  const pick = (field, column, writer) => (
    !Object.hasOwn(provider, field) ? (existing?.[column] ?? null) : writer(provider[field])
  )
  const pickNumeric = (field, column) => pick(
    field,
    column,
    (value) => parseSubmittedModelProviderInteger(value, field),
  )
  const previousModels = existing ? (() => {
    try { return parseModels(JSON.parse(existing.models_json || '[]')) } catch { return [] }
  })() : []
  return {
    kindRaw: provider.kind === undefined
      ? (existing?.kind ?? null)
      : (VALID_KINDS.has(String(provider.kind)) ? String(provider.kind) : null),
    contextWindow: pickNumeric('contextWindow', 'context_window'),
    supportsTools: pick('supportsTools', 'supports_tools', writeTribool),
    supportsStreaming: pick('supportsStreaming', 'supports_streaming', writeTribool),
    supportsVision: pick('supportsVision', 'supports_vision', writeTribool),
    supportsPdf: pick('supportsPdf', 'supports_pdf', writeTribool),
    firstTokenTimeoutMs: pickNumeric('firstTokenTimeoutMs', 'first_token_timeout_ms'),
    idleTimeoutMs: pickNumeric('idleTimeoutMs', 'idle_timeout_ms'),
    failoverEnabled: pick('failoverEnabled', 'failover_enabled', writeTribool),
    keepAlive: provider.keepAlive === undefined
      ? (existing?.keep_alive ?? null)
      : (String(provider.keepAlive || '').trim() || null),
    modelProfiles: provider.modelProfiles === undefined
      ? normalizeModelProfiles(existing?.model_profiles_json, models)
      : normalizeModelProfiles(provider.modelProfiles, models, { strictNumeric: true }),
    previousModels,
  }
}
