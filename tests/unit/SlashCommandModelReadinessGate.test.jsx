import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'

import { createSlashCommandRegistry } from '../../src/lib/slashCommandRegistry.js'
import { registerCoreSlashCommands } from '../../src/lib/slashCoreCommands.js'
import useSlashCommandExecution from '../../src/pages/ChatSplit/useSlashCommandExecution.js'

function Harness({ calls }) {
  const stateRef = useRef({ activeSessionId: 'session-1', sessions: [] })
  const registry = createSlashCommandRegistry({ storage: null })
  registerCoreSlashCommands(registry, { lang: 'en' })
  const execute = useSlashCommandExecution({
    changeApprovalMode: () => {},
    dispatch: () => {},
    modelName: '',
    modelProviderId: '',
    modelReadiness: { kind: 'empty', canSend: false },
    navigate: () => {},
    onModelUnavailable: (readiness) => calls.push(['unavailable', readiness.kind]),
    setDesktopPetVisible: () => {},
    setInput: (value) => calls.push(['input', value]),
    setSlashInlinePanel: (value) => calls.push(['panel', value]),
    setWorkbenchMessage: (value) => calls.push(['message', value]),
    setWorkbenchOpen: () => {},
    setWorkbenchTab: () => {},
    slashRegistry: registry,
    stateRef,
    triggerSendFlow: (prompt) => calls.push(['send', prompt]),
  })
  return <button type="button" onClick={() => execute(registry.getCommand('init'))}>run</button>
}

test('/init preserves the draft and model error when no executable model is configured', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  const calls = []
  try {
    await act(async () => root.render(<Harness calls={calls} />))
    await act(async () => document.querySelector('button').click())
    assert.deepEqual(calls, [['unavailable', 'empty']])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
