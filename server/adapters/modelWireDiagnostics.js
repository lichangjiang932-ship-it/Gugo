import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

export const MODEL_WIRE_DIAGNOSTIC_MAX_BYTES = 1024 * 1024
const observations = new WeakMap()
const CREDENTIAL_KEY = /authorization|api[-_]?key|token|secret|password|credential|signature/iu

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function scopedDigest(kind, owner, value) {
  return digest(`gugo:wire:v1:${kind}:${owner || 'unscoped'}\0${value}`)
}

function safeEndpoint(requestUrl, config) {
  const url = new URL(requestUrl)
  const secrets = [config?.apiKey, url.username, url.password,
    ...Object.entries(config?.headers || {}).filter(([key]) => CREDENTIAL_KEY.test(key)).map(([, value]) => value)]
    .filter((value) => typeof value === 'string' && value.length > 0)
  let pathname = url.pathname
  for (const secret of secrets) {
    for (const value of [secret, encodeURIComponent(secret)]) pathname = pathname.split(value).join('[redacted]')
  }
  let comparable = true
  const query = []
  for (const [key, value] of url.searchParams) {
    if (CREDENTIAL_KEY.test(key)) continue
    if (key === 'alt' && ['sse', 'json'].includes(value)) query.push([key, value])
    else if (key === 'api-version' && /^\d{4}-\d{2}-\d{2}(?:-preview)?$/u.test(value)) query.push([key, value])
    else comparable = false
  }
  // Arbitrary headers can route to different tenants/deployments. Without a
  // safe identity for those values, do not claim comparability.
  if (Object.keys(config?.headers || {}).some((key) => !CREDENTIAL_KEY.test(key)
    && !['content-type', 'anthropic-version'].includes(key.toLowerCase()))) comparable = false
  return { identity: JSON.stringify({ origin: url.origin, pathname, query: query.sort() }), comparable }
}

function wireParts(body, kind) {
  if (kind === 'anthropic') return {
    prefix: body.system ?? null, prefixBlocks: Array.isArray(body.system) ? body.system.length : Number(Boolean(body.system)),
    tools: Array.isArray(body.tools) ? body.tools : [], messages: Array.isArray(body.messages) ? body.messages : [],
  }
  if (kind === 'gemini') return {
    prefix: body.systemInstruction ?? null, prefixBlocks: body.systemInstruction?.parts?.length || 0,
    tools: Array.isArray(body.tools) ? body.tools : [], messages: Array.isArray(body.contents) ? body.contents : [],
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  let count = 0
  while (['system', 'developer'].includes(messages[count]?.role)) count += 1
  return { prefix: count ? messages.slice(0, count) : null, prefixBlocks: count,
    tools: Array.isArray(body.tools) ? body.tools : [], messages }
}

/** Exact post-adaptation wire facts, not tokenization, provider cache keys or KV-hit evidence. */
export function describeModelWireRequest({ providerRequest, config = {}, profile = {}, ownerId = null } = {}) {
  const owner = typeof ownerId === 'string' && ownerId.trim() ? digest(`gugo:wire:owner:${ownerId.trim()}`) : null
  const raw = providerRequest?.init?.body
  const bodyBytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : 0
  const base = { version: 1, stage: 'wire', comparisonScope: 'same_owner_endpoint_model_config',
    prefixKind: 'leading_instructions', ownerScopeFingerprint: owner,
    available: false, truncated: bodyBytes > MODEL_WIRE_DIAGNOSTIC_MAX_BYTES,
    bodyBytes, bodyFingerprint: null, prefixFingerprint: null, toolsFingerprint: null,
    endpointFingerprint: null, modelFingerprint: null, configFingerprint: null,
    identityComparable: false, prefixBlocks: 0, messageCount: 0, toolCount: 0,
  }
  try {
    const endpoint = safeEndpoint(providerRequest?.url, config)
    base.endpointFingerprint = scopedDigest('endpoint', owner, endpoint.identity)
    base.modelFingerprint = scopedDigest('model', owner, JSON.stringify([profile.kind || '', config.modelName || '']))
    base.configFingerprint = scopedDigest('config', owner, JSON.stringify({
      providerId: config.providerId || null, revision: config.configRevision ?? null,
      temperature: config.temperature ?? null, maxTokens: config.maxTokens ?? null,
      kind: profile.kind || null, supportsTools: profile.supportsTools === true,
      supportsStreaming: profile.supportsStreaming === true,
      supportsNamedToolChoice: profile.supportsNamedToolChoice !== false,
      supportsMidConversationSystem: profile.supportsMidConversationSystem !== false,
      requiresUserMessage: profile.requiresUserMessage === true,
    }))
    base.identityComparable = owner !== null && endpoint.comparable
    if (base.truncated || typeof raw !== 'string') return Object.freeze(base)
    const body = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Object.freeze(base)
    const parts = wireParts(body, profile.kind)
    return Object.freeze({ ...base, available: true,
      bodyFingerprint: scopedDigest('body', owner, raw),
      prefixFingerprint: parts.prefix ? scopedDigest('prefix', owner, JSON.stringify(parts.prefix)) : null,
      toolsFingerprint: scopedDigest('tools', owner, JSON.stringify(parts.tools)),
      prefixBlocks: parts.prefixBlocks, messageCount: parts.messages.length,
      toolCount: profile.kind === 'gemini'
        ? parts.tools.reduce((sum, item) => sum + (item.functionDeclarations?.length || 0), 0) : parts.tools.length,
    })
  } catch { return Object.freeze(base) }
}

export function attachModelWireDiagnostics(providerRequest, options) {
  try { observations.set(providerRequest, describeModelWireRequest({ providerRequest, ...options })) } catch { /* optional observation */ }
  return providerRequest
}

export function getModelWireDiagnostics(providerRequest) {
  return providerRequest && typeof providerRequest === 'object' ? observations.get(providerRequest) || null : null
}
