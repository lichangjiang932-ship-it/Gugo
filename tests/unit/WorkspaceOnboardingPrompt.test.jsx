import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { WorkspaceOnboardingPromptController } from '../../src/components/WorkspaceOnboardingPrompt.jsx'
import {
  readWorkspaceOnboardingDismissal,
  shouldAutoOpenWorkspaceOnboarding,
  workspaceOnboardingDismissalKey,
} from '../../src/lib/workspaceOnboardingPrompt.js'

function setupDom(hash = '#/task?job=deep-link') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `http://localhost/${hash}`,
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const t = (key) => key
const incompleteStatus = { onboarding: { complete: false, completedAt: null } }

async function renderPrompt(root, overrides = {}) {
  await act(async () => {
    root.render(
      <WorkspaceOnboardingPromptController
        authenticated
        authMode="multi_user"
        fetchStatus={async () => incompleteStatus}
        navigate={() => {}}
        pathname="/task"
        storage={window.localStorage}
        t={t}
        user={{ email: 'first@example.com' }}
        {...overrides}
      />,
    )
    await Promise.resolve()
  })
}

test('authenticated incomplete onboarding opens without replacing a deep link and dismissal keeps a reminder', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  let root = createRoot(rootElement)
  const navigations = []

  try {
    await renderPrompt(root, { navigate: (path) => navigations.push(path) })
    assert.ok(rootElement.querySelector('[role="dialog"]'))
    assert.equal(window.location.hash, '#/task?job=deep-link')
    assert.deepEqual(navigations, [])

    const later = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent === 'permissionsDashboard.onboardingPromptLater')
    await act(async () => later.click())
    assert.equal(rootElement.querySelector('[role="dialog"]'), null)
    const reminder = rootElement.querySelector('[data-testid="workspace-onboarding-reminder"]')
    assert.ok(reminder)
    assert.equal(reminder.dataset.placement, 'top-safe')
    assert.equal(reminder.classList.contains('fixed'), true)
    assert.equal([...reminder.classList].some((name) => name.startsWith('top-')), true)
    assert.equal([...reminder.classList].some((name) => name.startsWith('bottom-')), false)
    assert.equal(reminder.classList.contains('right-[4.25rem]'), true)
    assert.equal(reminder.classList.contains('right-4'), false)
    assert.equal(reminder.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(reminder.getAttribute('aria-controls'), 'workspace-onboarding-prompt-dialog')
    assert.equal(reminder.getAttribute('aria-expanded'), 'false')
    assert.equal(readWorkspaceOnboardingDismissal(window.localStorage, 'first@example.com'), true)

    await act(async () => root.unmount())
    root = createRoot(rootElement)
    await renderPrompt(root, { navigate: (path) => navigations.push(path) })
    assert.equal(rootElement.querySelector('[role="dialog"]'), null)

    await act(async () => rootElement.querySelector('[data-testid="workspace-onboarding-reminder"]').click())
    assert.ok(rootElement.querySelector('[role="dialog"]'))
    const openGuide = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('permissionsDashboard.onboardingPromptOpen'))
    await act(async () => openGuide.click())
    assert.deepEqual(navigations, ['/permissions?focus=onboarding'])
    assert.equal(window.location.hash, '#/task?job=deep-link')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('completed, unauthenticated, and permissions deep-link states do not show a competing prompt', async () => {
  const dom = setupDom('#/permissions?focus=onboarding')
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let fetches = 0

  try {
    await renderPrompt(root, {
      authenticated: false,
      fetchStatus: async () => { fetches += 1; return incompleteStatus },
    })
    assert.equal(fetches, 0)
    assert.equal(rootElement.textContent, '')

    await renderPrompt(root, {
      fetchStatus: async () => { fetches += 1; return { onboarding: { complete: true, completedAt: Date.now() } } },
    })
    assert.equal(fetches, 1)
    assert.equal(rootElement.textContent, '')

    await renderPrompt(root, {
      fetchStatus: async () => { fetches += 1; return incompleteStatus },
      pathname: '/permissions',
    })
    assert.equal(fetches, 2)
    assert.equal(rootElement.textContent, '')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('dismissal keys are user-scoped without exposing the email and auto-open respects configuration deep links', () => {
  const aliceKey = workspaceOnboardingDismissalKey('alice@example.com')
  const bobKey = workspaceOnboardingDismissalKey('bob@example.com')
  assert.notEqual(aliceKey, bobKey)
  assert.equal(aliceKey.includes('alice@example.com'), false)
  assert.equal(shouldAutoOpenWorkspaceOnboarding({ authenticated: true, complete: false, dismissed: false, pathname: '/chat' }), true)
  assert.equal(shouldAutoOpenWorkspaceOnboarding({ authenticated: true, complete: false, dismissed: false, pathname: '/permissions' }), false)
  assert.equal(shouldAutoOpenWorkspaceOnboarding({ authenticated: true, complete: false, dismissed: false, pathname: '/settings' }), false)
  assert.equal(shouldAutoOpenWorkspaceOnboarding({ authenticated: false, complete: false, dismissed: false, pathname: '/chat' }), false)
})

test('settings deep links keep the workspace guide as a non-competing reminder', async () => {
  const dom = setupDom('#/settings?tab=models')
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await renderPrompt(root, { pathname: '/settings' })
    assert.equal(rootElement.querySelector('[role="dialog"]'), null)
    assert.ok(rootElement.querySelector('[data-testid="workspace-onboarding-reminder"]'))
    assert.equal(window.location.hash, '#/settings?tab=models')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('navigating to settings closes an already-open workspace guide', async () => {
  const dom = setupDom('#/chat')
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await renderPrompt(root, { pathname: '/chat' })
    assert.ok(rootElement.querySelector('[role="dialog"]'))

    await renderPrompt(root, { pathname: '/settings' })
    assert.equal(rootElement.querySelector('[role="dialog"]'), null)
    assert.ok(rootElement.querySelector('[data-testid="workspace-onboarding-reminder"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
