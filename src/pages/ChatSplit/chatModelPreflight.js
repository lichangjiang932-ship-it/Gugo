import { getModelStatus } from '../../lib/modelClient.js'
import {
  modelCatalogStateFromStatus,
  modelOptionsFromStatus,
  resolveChatModelReadiness,
} from './chatModelReadiness.js'

function positiveRevision(value) {
  const revision = Number(value)
  return Number.isInteger(revision) && revision > 0 ? revision : null
}

export async function preflightChatModelSelection({
  modelName = '',
  modelProviderId = '',
  modelConfigRevision = null,
  getStatus = getModelStatus,
} = {}) {
  let status
  try {
    status = await getStatus()
  } catch (error) {
    // A 401 here is emitted by Gugo's own authenticated status endpoint.
    // Provider authentication failures are represented inside the returned
    // model readiness payload and must not clear the user's Gugo session.
    if (Number(error?.status) === 401) {
      return { ok: false, authenticationRequired: true }
    }
    return { ok: false, readiness: { kind: 'error', canSend: false, modelName: '', authoritative: true } }
  }

  const modelOptions = modelOptionsFromStatus(status)
  const readiness = resolveChatModelReadiness({
    catalogState: modelCatalogStateFromStatus(status, modelOptions),
    modelOptions,
    modelName,
    modelProviderId,
  })
  if (!readiness.canSend) return { ok: false, readiness: { ...readiness, authoritative: true } }

  const expectedRevision = positiveRevision(modelConfigRevision)
  const currentRevision = positiveRevision(readiness.configRevision)
  if (expectedRevision && currentRevision !== expectedRevision) {
    return {
      ok: false,
      readiness: {
        kind: 'provider-changed',
        canSend: false,
        authoritative: true,
        modelName: String(modelName || '').trim(),
        modelProviderId: String(modelProviderId || '').trim(),
        configRevision: currentRevision,
      },
    }
  }

  return {
    ok: true,
    readiness,
    selection: {
      modelName: readiness.modelName,
      modelProviderId: String(readiness.modelProviderId || modelProviderId || '').trim(),
      modelConfigRevision: currentRevision,
      modelMode: readiness.kind === 'provider-chat-only' ? 'chat_only' : 'agent',
    },
  }
}
