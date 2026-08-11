import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { WorkspaceOnboardingSection } from '../../src/pages/permissions/PermissionSections.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/permissions',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const t = (key, vars = {}) => `${key}${vars.source ? `:${vars.source}` : ''}`

function onboarding(overrides = {}) {
  return {
    complete: false,
    completedAt: null,
    approvalMode: 'normal',
    writableDirectories: [],
    features: {
      fileSystem: { enabled: false, locked: true, source: '.env' },
      shell: { enabled: false, locked: false, source: 'default' },
      git: { enabled: false, locked: false, source: 'default' },
    },
    ...overrides,
  }
}

test('workspace onboarding requires risk confirmation and preserves deployment-locked switches', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const submitted = []
  const controller = {
    localFiles: { onboarding: onboarding() },
    localFileError: null,
    onboardingBusy: false,
    pickerBusy: false,
    chooseOnboardingDirectory: async () => 'C:\\Work',
    configureOnboarding: async (payload) => { submitted.push(payload); return true },
  }

  try {
    await act(async () => root.render(<WorkspaceOnboardingSection controller={controller} t={t} />))
    const form = rootElement.querySelector('[data-testid="workspace-onboarding"]')
    const submit = form.querySelector('button[type="submit"]')
    const featureCheckboxes = form.querySelectorAll('fieldset input[type="checkbox"]')
    assert.equal(featureCheckboxes[0].disabled, true)
    assert.equal(featureCheckboxes[0].checked, false)
    assert.equal(submit.disabled, true)

    const picker = [...form.querySelectorAll('button')].find((button) => button.type === 'button')
    await act(async () => picker.click())
    assert.equal(form.querySelector('#workspace-onboarding-path').value, 'C:\\Work')

    const confirmations = form.querySelectorAll('label > input[type="checkbox"]')
    await act(async () => confirmations[confirmations.length - 1].click())
    assert.equal(submit.disabled, false)
    await act(async () => submit.click())
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].path, 'C:\\Work')
    assert.deepEqual(submitted[0].features, { fileSystem: false, shell: true, git: true })
    assert.equal(submitted[0].confirmed, true)

    const approval = form.querySelector('#workspace-onboarding-approval')
    await act(async () => {
      approval.value = 'bypass'
      approval.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    assert.equal(submit.disabled, true)
    const updatedConfirmations = form.querySelectorAll('label > input[type="checkbox"]')
    const bypass = updatedConfirmations[updatedConfirmations.length - 2]
    await act(async () => bypass.click())
    assert.equal(submit.disabled, false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
