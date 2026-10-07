/**
 * The shape of the provider/model knowledge-base snapshot.
 *
 * This lives in `shared/` rather than next to the generator on purpose: the
 * generator writes the snapshot, but the *server* validates a refreshed copy at
 * runtime — and the desktop package ships `shared/` while it does not ship
 * `scripts/`. Keeping the contract here is what lets the packaged app import it.
 *
 * Everything upstream is treated as untrusted: models.dev is a third party, and
 * a refreshed document is parsed from the network into memory. Every field is
 * therefore bounded and typed on the way in rather than carried through.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1
export const CATALOG_SOURCE_URL = 'https://models.dev/api.json'

export const MAX_PROVIDERS = 400
export const MAX_MODELS_PER_PROVIDER = 400
export const MAX_TEXT = 200
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

function text(value, limit = MAX_TEXT) {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw.length > limit ? raw.slice(0, limit) : raw
}

function positiveInt(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : 0
}

function money(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

/**
 * One model, reduced to what the picker and the capability profiles need.
 *
 * `limit.output` is frequently 0 upstream meaning "unspecified", so it is
 * normalised to 0 here rather than being carried as an absent key — a caller
 * should not have to distinguish "no output limit" from "field missing".
 */
export function compactModel(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, MAX_TEXT) || text(fallbackId, MAX_TEXT)
  if (!id) return null
  const modalities = raw.modalities && typeof raw.modalities === 'object' ? raw.modalities : {}
  const inputs = Array.isArray(modalities.input) ? modalities.input.filter((entry) => typeof entry === 'string') : []
  const limit = raw.limit && typeof raw.limit === 'object' ? raw.limit : {}
  const cost = raw.cost && typeof raw.cost === 'object' ? raw.cost : null
  const model = {
    id,
    name: text(raw.name, 120) || id,
    context: positiveInt(limit.context),
    output: positiveInt(limit.output),
    tools: raw.tool_call === true,
    vision: inputs.includes('image'),
    pdf: inputs.includes('pdf'),
    reasoning: raw.reasoning === true,
  }
  const released = text(raw.release_date, 32)
  if (released) model.released = released
  if (raw.status === 'deprecated') model.deprecated = true
  if (cost) {
    const input = money(cost.input)
    const output = money(cost.output)
    if (input !== null || output !== null) model.cost = { input, output }
  }
  return model
}

/** One provider: identity plus its compacted models, ordered newest first. */
export function compactProvider(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, MAX_TEXT) || text(fallbackId, MAX_TEXT)
  if (!id) return null
  const source = raw.models && typeof raw.models === 'object' ? raw.models : {}
  const models = []
  for (const [modelId, modelRaw] of Object.entries(source)) {
    const model = compactModel(modelRaw, modelId)
    if (model) models.push(model)
    if (models.length >= MAX_MODELS_PER_PROVIDER) break
  }
  // A provider with nothing to configure is not a provider.
  if (!models.length) return null
  // Newest first, then by id: a refresh must not reshuffle a list the reader is
  // looking at, and undated entries must not jump ahead of dated ones.
  models.sort((left, right) => {
    const byDate = String(right.released || '').localeCompare(String(left.released || ''))
    return byDate !== 0 ? byDate : left.id.localeCompare(right.id)
  })
  const env = Array.isArray(raw.env) ? raw.env.filter((name) => typeof name === 'string').slice(0, 8) : []
  const doc = text(raw.doc, MAX_TEXT)
  return {
    id,
    name: text(raw.name, 120) || id,
    ...(env.length ? { env } : {}),
    ...(doc ? { doc } : {}),
    models,
  }
}

/** Build a snapshot document from a parsed upstream catalogue. */
export function buildSnapshot(catalogue, { now = new Date(), sourceUrl = CATALOG_SOURCE_URL } = {}) {
  if (!catalogue || typeof catalogue !== 'object' || Array.isArray(catalogue)) {
    throw new Error('model catalogue must be an object keyed by provider id')
  }
  const providers = []
  for (const [providerId, providerRaw] of Object.entries(catalogue)) {
    const provider = compactProvider(providerRaw, providerId)
    if (provider) providers.push(provider)
    if (providers.length >= MAX_PROVIDERS) break
  }
  if (!providers.length) throw new Error('model catalogue contained no usable providers')
  providers.sort((left, right) => left.id.localeCompare(right.id))
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    source: sourceUrl,
    generatedAt: now.toISOString().slice(0, 10),
    providerCount: providers.length,
    modelCount: providers.reduce((total, provider) => total + provider.models.length, 0),
    providers,
  }
}

/**
 * Structural validation shared by the generator and the runtime refresh.
 *
 * A refreshed document is only allowed to replace the snapshot in use when it
 * passes this: a partial or reshaped upstream must leave the working catalogue
 * alone rather than emptying a reader's model list.
 */
export function isUsableSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return false
  if (!Array.isArray(value.providers) || !value.providers.length) return false
  return value.providers.every((provider) => (
    provider && typeof provider.id === 'string' && provider.id
    && Array.isArray(provider.models) && provider.models.length > 0
    && provider.models.every((model) => model && typeof model.id === 'string' && model.id)
  ))
}
