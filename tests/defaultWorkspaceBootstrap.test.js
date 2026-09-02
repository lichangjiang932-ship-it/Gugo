import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import {
  defaultWorkspacePathForDraft,
  hasSessionCatalogSourceChanged,
} from '../src/store/useAuthBootstrap.js'

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
  const source = (backend, workspace = 'workspace:one') => ({
    version: 1,
    backendInstanceId: backend,
    workspaceScope: { key: workspace, path: 'D:\\work\\project' },
  })
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
