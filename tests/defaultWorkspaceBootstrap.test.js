import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import {
  defaultWorkspacePathForDraft,
  hasSessionCatalogSourceChanged,
  importLegacySessionsAndRefresh,
} from '../src/store/useAuthBootstrap.js'

function catalogSource(backend = 'sqlite:one', workspace = 'workspace:one') {
  return {
    version: 1,
    backendInstanceId: backend,
    workspaceScope: { key: workspace, path: 'D:\\work\\project' },
  }
}

test('new drafts use the server-declared default workspace', () => {
  assert.equal(
    defaultWorkspacePathForDraft(
      { defaultWorkspacePath: 'D:\\work\\current-project' },
      { activeSessionId: null, draftWorkspacePath: '' },
    ),
    'D:\\work\\current-project',
  )
})

test('the default workspace does not replace an active session or an explicit draft choice', () => {
  const access = { defaultWorkspacePath: 'D:\\work\\current-project' }
  assert.equal(defaultWorkspacePathForDraft(access, {
    activeSessionId: 'session-1',
    draftWorkspacePath: '',
  }), '')
  assert.equal(defaultWorkspacePathForDraft(access, {
    activeSessionId: null,
    draftWorkspacePath: 'D:\\work\\chosen-project',
  }), '')
})

test('startup goes straight to chat without restoring the retired workspace configuration guide', () => {
  const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const retiredPrompt = new URL('../src/components/WorkspaceOnboardingPrompt.jsx', import.meta.url)
  const retiredPromptState = new URL('../src/lib/workspaceOnboardingPrompt.js', import.meta.url)

  assert.doesNotMatch(appSource, /WorkspaceOnboardingPrompt|workspaceOnboardingPrompt/)
  assert.ok(appSource.includes('<Route path="/" element={<Navigate to="/chat" replace />} />'))
  assert.match(appSource, /<Route path="\/permissions"/)
  assert.equal(existsSync(retiredPrompt), false)
  assert.equal(existsSync(retiredPromptState), false)
})

test('legacy imports are guarded only when a known catalog source changes', () => {
  const source = catalogSource
  assert.equal(hasSessionCatalogSourceChanged(null, source('sqlite:one')), false)
  assert.equal(hasSessionCatalogSourceChanged(source('sqlite:one'), null), false)
  assert.equal(
    hasSessionCatalogSourceChanged(source('sqlite:one'), source('sqlite:one')),
    false,
  )
  assert.equal(
    hasSessionCatalogSourceChanged(source('sqlite:one'), source('sqlite:two')),
    true,
  )
  assert.equal(
    hasSessionCatalogSourceChanged(
      source('sqlite:one', 'workspace:one'),
      source('sqlite:one', 'workspace:two'),
    ),
    true,
  )
})

test('legacy migration imports only its staged queue and clears it after a same-source refresh', async () => {
  const source = catalogSource()
  const pendingMessages = [
    {
      id: 'pending-message',
      role: 'user',
      content: 'preserve this pending user message',
      meta: { pendingServerSync: true, serverTurnId: 'unstable-turn' },
    },
    {
      id: 'partial-message',
      role: 'assistant',
      content: 'preserve this visible partial reply',
      modelContext: { turnId: 'unstable-turn' },
      meta: { streaming: true, serverTurnId: 'unstable-turn' },
    },
  ]
  let receivedCandidates
  const result = await importLegacySessionsAndRefresh({
    pendingLegacySessions: [{ id: 'duplicate', title: 'Pending copy', messages: pendingMessages }],
    sessions: [
      { id: 'duplicate', title: 'Catalog copy', messages: [] },
      { id: 'current-local', title: 'Current local', messages: [] },
    ],
  }, {
    source,
    sessions: [],
  }, {
    async importSessions(candidates) {
      receivedCandidates = candidates
      return {
        importedCount: 1,
        serverAuthoritativeCount: 0,
        results: [
          {
            id: 'duplicate',
            sessionId: 'recovered-duplicate',
            status: 'imported',
            session: { id: 'recovered-duplicate' },
          },
        ],
      }
    },
    async listCatalog() {
      return {
        source: structuredClone(source),
        sessions: [{ id: 'recovered-duplicate', revision: 1 }],
      }
    },
  })

  assert.deepEqual(receivedCandidates.map(({ id }) => id), ['duplicate'])
  assert.deepEqual(receivedCandidates[0].messages, [
    {
      id: 'pending-message',
      role: 'user',
      content: 'preserve this pending user message',
    },
    {
      id: 'partial-message',
      role: 'assistant',
      content: 'preserve this visible partial reply',
    },
  ])
  assert.equal(result.clearPendingLegacySessions, true)
  assert.deepEqual(result.importedSessionIds, ['recovered-duplicate'])
  assert.deepEqual(result.serverAuthoritativeIds, [])
  assert.deepEqual(result.legacySessionIdMappings, [{
    sourceSessionId: 'duplicate',
    sessionId: 'recovered-duplicate',
  }])
  assert.deepEqual(result.catalog.sessions, [{ id: 'recovered-duplicate', revision: 1 }])
})

test('catalog refresh never imports a live Session whose Turn is still unstable', async () => {
  const source = catalogSource()
  const catalog = {
    source,
    sessions: [{ id: 'live-session', revision: 1 }],
  }
  let importCalls = 0
  let refreshCalls = 0

  const result = await importLegacySessionsAndRefresh({
    pendingLegacySessions: [],
    activeSessionId: 'live-session',
    sessions: [{
      id: 'live-session',
      title: 'Running Turn',
      messages: [
        {
          id: 'live-user',
          role: 'user',
          content: 'do not duplicate this Turn',
          meta: { pendingServerSync: true },
        },
        {
          id: 'live-assistant',
          role: 'assistant',
          content: 'partial result',
          meta: { streaming: true },
        },
      ],
    }],
  }, catalog, {
    async importSessions() {
      importCalls += 1
      throw new Error('live Sessions must not enter legacy import')
    },
    async listCatalog() {
      refreshCalls += 1
      throw new Error('no migration refresh is needed without a staged queue')
    },
  })

  assert.equal(importCalls, 0)
  assert.equal(refreshCalls, 0)
  assert.strictEqual(result.catalog, catalog)
  assert.equal(result.clearPendingLegacySessions, false)
  assert.deepEqual(result.importedSessionIds, [])
  assert.deepEqual(result.serverAuthoritativeIds, [])
  assert.deepEqual(result.legacySessionIdMappings, [])
})

test('legacy migration failures and catalog source changes never yield a queue-clear result', async () => {
  const source = catalogSource()
  const state = {
    pendingLegacySessions: [{ id: 'legacy', messages: [{ id: 'message', role: 'user', content: 'keep' }] }],
    sessions: [],
  }
  const original = structuredClone(state)

  await assert.rejects(
    importLegacySessionsAndRefresh(state, { source, sessions: [] }, {
      async importSessions() { throw new Error('write failed') },
      async listCatalog() { throw new Error('must not refresh after a failed batch') },
    }),
    /write failed/,
  )
  assert.deepEqual(state, original)

  await assert.rejects(
    importLegacySessionsAndRefresh(state, { source, sessions: [] }, {
      async importSessions() {
        return {
          importedCount: 1,
          serverAuthoritativeCount: 0,
          results: [{
            id: 'legacy',
            sessionId: 'legacy',
            status: 'imported',
            session: { id: 'legacy' },
          }],
        }
      },
      async listCatalog() {
        return { source: catalogSource('sqlite:two'), sessions: [] }
      },
    }),
    (error) => error?.code === 'SESSION_CATALOG_SOURCE_CHANGED',
  )
  assert.deepEqual(state, original)
})
