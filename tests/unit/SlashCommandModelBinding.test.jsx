import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'

import { createSlashCommandRegistry } from '../../src/lib/slashCommandRegistry.js'
import { registerCoreSlashCommands } from '../../src/lib/slashCoreCommands.js'
import useSlashCommandExecution from '../../src/pages/ChatSplit/useSlashCommandExecution.js'

const registry = createSlashCommandRegistry({ storage: null })
registerCoreSlashCommands(registry, { lang: 'en' })

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function Harness({ command, args, onExecute }) {
  const stateRef = useRef({
    activeSessionId: 'session-1',
    sessions: [{
      id: 'session-1',
      messages: Array.from({ length: 9 }, (_, index) => ({
        id: `message-${index}`,
        role: 'user',
        content: `message ${index}`,
      })),
    }],
  })
  const execute = useSlashCommandExecution({
    changeApprovalMode: () => {},
    dispatch: () => {},
    modelConfigRevision: 11,
    modelName: 'shared-model',
    modelProviderId: 'provider-uuid',
    navigate: () => {},
    setDesktopPetVisible: () => {},
    setInput: () => {},
    setSlashInlinePanel: () => {},
    setWorkbenchMessage: () => {},
    setWorkbenchOpen: () => {},
    setWorkbenchTab: () => {},
    slashRegistry: registry,
    stateRef,
    triggerSendFlow: () => {},
  })
  return <button type="button" onClick={async () => {
    await execute(registry.getCommand(command), args)
    onExecute()
  }}>run</button>
}

for (const scenario of [
  {
    command: 'goals',
    args: 'ship the runtime',
    response: { job: { id: 'job-1' } },
    expected: {
      prompt: 'ship the runtime',
      requirePlanApproval: true,
      modelName: 'shared-model',
      providerId: 'provider-uuid',
    },
  },
  {
    command: 'compact',
    args: '',
    response: { ok: true, compacted: true, messages: [] },
    expected: {
      sessionId: 'session-1',
      messages: Array.from({ length: 9 }, (_, index) => ({
        id: `message-${index}`,
        role: 'user',
        content: `message ${index}`,
      })),
      keepMessages: 6,
      semantic: true,
      modelName: 'shared-model',
      modelProviderId: 'provider-uuid',
      modelConfigRevision: 11,
    },
  },
]) {
  test(`/${scenario.command} carries the selected model Provider binding`, async () => {
    const dom = setupDom()
    const root = createRoot(document.getElementById('root'))
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => scenario.response }
    }
    try {
      await act(async () => root.render(
        <Harness command={scenario.command} args={scenario.args} onExecute={() => {}} />,
      ))
      await act(async () => document.querySelector('button').click())
      assert.equal(calls.length, 1)
      assert.deepEqual(JSON.parse(calls[0].init.body), scenario.expected)
    } finally {
      globalThis.fetch = originalFetch
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
}
