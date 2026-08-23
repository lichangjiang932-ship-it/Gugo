import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  modelCatalogStateFromStatus,
  modelReadinessMessageKey,
  resolveChatModelReadiness,
  resolveModelOptionReadiness,
} from '../src/pages/ChatSplit/chatModelReadiness.js'

test('model catalog distinguishes unconfigured, empty, and ready states', () => {
  assert.deepEqual(modelCatalogStateFromStatus({ configured: false, missing: ['MODEL_NAME'] }, []), {
    kind: 'unconfigured',
    missing: ['MODEL_NAME'],
  })
  assert.deepEqual(modelCatalogStateFromStatus({ configured: true }, []), { kind: 'empty' })
  assert.deepEqual(modelCatalogStateFromStatus({ configured: true }, [{ name: 'local' }]), { kind: 'ready' })
})

test('only a selected model from the current server catalog can start a turn', () => {
  const modelOptions = [{ name: 'local' }]
  assert.deepEqual(resolveChatModelReadiness({
    catalogState: { kind: 'ready' },
    modelOptions,
    modelName: 'local',
  }), { kind: 'ready', canSend: true, modelName: 'local' })
  assert.equal(resolveChatModelReadiness({
    catalogState: { kind: 'ready' },
    modelOptions,
    modelName: 'stale-model',
  }).kind, 'selection-required')
  assert.equal(resolveChatModelReadiness({
    catalogState: { kind: 'error' },
    modelOptions,
    modelName: 'local',
  }).canSend, false)
  assert.equal(modelReadinessMessageKey({ kind: 'unconfigured' }), 'chat.modelPicker.unconfiguredSendBlocked')
})

test('database Provider readiness blocks unavailable selections while chat-only remains sendable', () => {
  const base = {
    name: 'shared-model',
    provider: 'provider-uuid',
    providerKey: 'runtime-key',
    configRevision: 4,
  }
  for (const [model, kind, messageKey] of [
    [base, 'provider-unverified', 'errors.modelProviderUnverified'],
    [{ ...base, readiness: { configRevision: 3, chat: true, tools: true, agent: true, mode: 'agent' } }, 'provider-unverified', 'errors.modelProviderUnverified'],
    [{ ...base, readiness: { configRevision: 4, chat: false, tools: false, agent: false, mode: 'unavailable' } }, 'provider-unavailable', 'errors.modelEndpointUnavailable'],
  ]) {
    const result = resolveChatModelReadiness({
      catalogState: { kind: 'ready' },
      modelOptions: [model],
      modelName: model.name,
      modelProviderId: model.provider,
    })
    assert.equal(result.kind, kind)
    assert.equal(result.canSend, false)
    assert.equal(modelReadinessMessageKey(result), messageKey)
  }
  const chatOnly = resolveChatModelReadiness({
    catalogState: { kind: 'ready' },
    modelOptions: [{
      ...base,
      readiness: { configRevision: 4, chat: true, tools: false, agent: false, mode: 'chat_only' },
    }],
    modelName: base.name,
    modelProviderId: base.provider,
  })
  assert.deepEqual(chatOnly, {
    kind: 'provider-chat-only',
    canSend: true,
    modelName: base.name,
    modelProviderId: base.provider,
    configRevision: 4,
  })
  assert.equal(modelReadinessMessageKey(chatOnly), '')
  assert.deepEqual(resolveChatModelReadiness({
    catalogState: { kind: 'ready' },
    modelOptions: [{
      ...base,
      readiness: { configRevision: 4, chat: true, tools: true, agent: true, mode: 'agent' },
    }],
    modelName: base.name,
    modelProviderId: base.provider,
  }), {
    kind: 'ready',
    canSend: true,
    modelName: base.name,
    modelProviderId: base.provider,
    configRevision: 4,
  })
})

test('chat readiness never reuses one catalog model probe for a sibling model', () => {
  const provider = 'provider-per-model'
  const tested = {
    name: 'tested-model',
    provider,
    providerKey: 'per-model',
    configRevision: 9,
    readiness: { configRevision: 9, chat: true, tools: true, agent: true, mode: 'agent' },
  }
  const untested = {
    name: 'untested-model',
    provider,
    providerKey: 'per-model',
    configRevision: 9,
    readiness: null,
  }
  const modelOptions = [tested, untested]

  assert.equal(resolveChatModelReadiness({
    catalogState: { kind: 'ready' },
    modelOptions,
    modelName: tested.name,
    modelProviderId: provider,
  }).kind, 'ready')
  assert.equal(resolveChatModelReadiness({
    catalogState: { kind: 'ready' },
    modelOptions,
    modelName: untested.name,
    modelProviderId: provider,
  }).kind, 'provider-unverified')
})

test('model option readiness exposes only stable per-model capability states', () => {
  const base = {
    name: 'catalog-model',
    provider: 'provider-id',
    providerKey: 'provider-key',
    configRevision: 7,
  }
  assert.deepEqual(resolveModelOptionReadiness({ name: 'deployment-model' }), {
    kind: 'untested', canSelect: true, managedProvider: false,
  })
  assert.deepEqual(resolveModelOptionReadiness(base), {
    kind: 'untested', canSelect: true, managedProvider: true,
  })
  assert.equal(resolveModelOptionReadiness({
    ...base,
    readiness: { configRevision: 6, chat: true, tools: true, agent: true, mode: 'agent' },
  }).kind, 'untested')
  assert.deepEqual(resolveModelOptionReadiness({
    ...base,
    readiness: { configRevision: 7, chat: true, tools: true, agent: true, mode: 'agent' },
  }), { kind: 'agent-ready', canSelect: true, managedProvider: true })
  assert.deepEqual(resolveModelOptionReadiness({
    ...base,
    readiness: { configRevision: 7, chat: true, tools: false, agent: false, mode: 'chat_only' },
  }), { kind: 'chat-only', canSelect: true, managedProvider: true })
  assert.deepEqual(resolveModelOptionReadiness({
    ...base,
    readiness: { configRevision: 7, chat: false, tools: false, agent: false, mode: 'unavailable' },
  }), { kind: 'unavailable', canSelect: false, managedProvider: true })
})

test('chat send guards model readiness before clearing drafts or creating session state', () => {
  const page = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const flow = fs.readFileSync(new URL('../src/pages/ChatSplit/useChatSendFlow.js', import.meta.url), 'utf8')
  const workbench = fs.readFileSync(new URL('../src/pages/ChatSplit/RightWorkbench.jsx', import.meta.url), 'utf8')
  const outerGuard = page.indexOf('if (!modelReadiness.canSend)')
  const clearDraft = page.indexOf("setInput('')", outerGuard)
  const executorGuard = flow.indexOf('if (!modelIsExecutable)')
  const createSession = flow.indexOf("dispatch({ type: 'NEW_SESSION'", executorGuard)
  const sendMessage = flow.indexOf("dispatch({ type: 'SEND_MESSAGE'", executorGuard)

  assert.ok(outerGuard >= 0 && clearDraft > outerGuard)
  assert.ok(executorGuard >= 0 && createSession > executorGuard)
  assert.ok(sendMessage > executorGuard)
  assert.match(page, /const handleWorkbenchSend = \(content\) => \{[\s\S]*if \(!modelReadiness\.canSend\)[\s\S]*return false/)
  assert.match(page, /onWorkbenchSend=\{handleWorkbenchSend\}/)
  assert.match(workbench, /const accepted = onSendMessage\?\.\(content\)\s+if \(accepted !== false\) setSideInput\(''\)/)
  assert.match(flow, /modelReadiness\?\.kind === 'provider-chat-only' \? 'chat_only' : 'agent'/)
  assert.match(flow, /modelMode,/)
})
