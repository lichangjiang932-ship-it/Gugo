import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'

const templates = [
  { id: 'research', name: 'Research helper', description: 'Find and compare evidence.', version: '1.0.0' },
  { id: 'writer', name: 'Writing helper', description: 'Draft and revise documents.', version: '2.0.0' },
]
const sources = {
  research: '# Research helper\nCompare evidence and cite sources.',
  writer: '# Writing helper\nDraft, then revise for clarity.',
}

function setupDom(language) {
  const dom = new JSDOM('<!doctype html><html><body><button id="launcher" type="button">Templates</button><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    SVGElement: dom.window.SVGElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  dom.window.localStorage.setItem('lang', language)
  return dom
}

async function mount(context, { language = 'en', items = templates, loading = false } = {}) {
  const dom = setupDom(language)
  // DOM feature detection must run after setupDom, not during static imports.
  const [{ createRoot }, { default: AgentTemplateModal }, { I18nProvider, useT }] = await Promise.all([
    import('react-dom/client'),
    import('../../src/pages/agents/AgentTemplateModal.jsx'),
    import('../../src/i18n/I18nProvider.jsx'),
  ])
  const previews = []
  const uses = []
  let closes = 0
  function Harness() {
    const { t } = useT()
    const [open, setOpen] = useState(true)
    const [preview, setPreview] = useState(null)
    return open && <AgentTemplateModal
      loading={loading}
      templates={items}
      preview={preview}
      source={preview ? sources[preview.id] : ''}
      t={t}
      onClose={() => { closes += 1; setOpen(false) }}
      onPreview={template => { previews.push(template); setPreview(template) }}
      onUse={template => uses.push(template)}
    />
  }
  const launcher = document.getElementById('launcher')
  const root = createRoot(document.getElementById('root'))
  launcher.focus()
  context.after(async () => {
    await act(async () => root.unmount())
    dom.window.close()
  })
  await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
  return {
    dom,
    launcher,
    previews,
    uses,
    get closes() { return closes },
    get dialog() { return document.querySelector('[role="dialog"]') },
  }
}

async function closeAndExpectFocus(fixture, action) {
  let timer
  let onFocus
  const restored = new Promise((resolve, reject) => {
    onFocus = () => resolve()
    fixture.launcher.addEventListener('focus', onFocus, { once: true })
    timer = fixture.dom.window.setTimeout(() => reject(new Error('Modal did not restore launcher focus')), 2000)
  })
  try {
    await act(async () => action())
    await restored
    assert.equal(fixture.dialog, null)
    assert.equal(fixture.closes, 1)
    assert.equal(document.activeElement, fixture.launcher)
    assert.equal(fixture.launcher.hasAttribute('inert'), false)
    assert.equal(document.body.style.overflow, '')
  } finally {
    fixture.dom.window.clearTimeout(timer)
    fixture.launcher.removeEventListener('focus', onFocus)
  }
}

function keydown(fixture, target, properties) {
  const event = new fixture.dom.window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...properties,
  })
  target.dispatchEvent(event)
  return event
}

for (const [language, closeName, dialogName] of [
  ['zh', '关闭', 'Agent 模板（来自 Plugin）'],
  ['en', 'Close', 'Agent templates (from plugins)'],
]) {
  test(`template modal exposes its translated close name and restores focus (${language})`, async context => {
    const fixture = await mount(context, { language })
    const close = fixture.dialog.querySelector('header button')
    const heading = document.getElementById(fixture.dialog.getAttribute('aria-labelledby'))
    assert.equal(heading.textContent, dialogName)
    assert.equal(fixture.dialog.getAttribute('aria-modal'), 'true')
    assert.equal(close.getAttribute('aria-label'), closeName)
    assert.equal(close.type, 'button')
    assert.equal(document.activeElement, close)
    await closeAndExpectFocus(fixture, () => close.click())
  })
}

test('template choices are focusable native buttons and remain inside the Modal Tab boundary', async context => {
  const fixture = await mount(context)
  const choices = [...fixture.dialog.querySelectorAll('li > button')]
  const close = fixture.dialog.querySelector('header button')
  assert.equal(choices.length, templates.length)
  for (const [index, button] of choices.entries()) {
    assert.ok(button instanceof fixture.dom.window.HTMLButtonElement)
    assert.equal(button.type, 'button')
    assert.equal(button.tabIndex, 0)
    assert.equal(button.getAttribute('aria-pressed'), 'false')
    assert.ok(button.textContent.includes(templates[index].name))
    assert.ok(button.textContent.includes(templates[index].description))
    assert.ok(button.textContent.includes(`${templates[index].id} v${templates[index].version}`))
    button.focus()
    assert.equal(document.activeElement, button)
  }
  // JSDOM does not implement default Tab movement; only the real trap's edge wrapping is asserted.
  const forward = keydown(fixture, choices.at(-1), { key: 'Tab' })
  assert.equal(forward.defaultPrevented, true)
  assert.equal(document.activeElement, close)
  const backward = keydown(fixture, close, { key: 'Tab', shiftKey: true })
  assert.equal(backward.defaultPrevented, true)
  assert.equal(document.activeElement, choices.at(-1))
  assert.deepEqual(fixture.previews, [])
})

test('selecting a native template button updates preview and Use receives the current exact item', async context => {
  const fixture = await mount(context)
  const choices = [...fixture.dialog.querySelectorAll('li > button')]
  assert.equal(choices.length, templates.length)
  assert.equal(fixture.dialog.querySelector('pre'), null)
  assert.equal(fixture.dialog.querySelector('footer'), null)
  assert.ok(fixture.dialog.textContent.includes('Pick a template to see what is in it.'))

  // click tests React selection wiring, not native Enter/Space activation (browser coverage owns that).
  await act(async () => choices[1].click())
  assert.equal(fixture.previews.length, 1)
  assert.equal(fixture.previews[0], templates[1])
  assert.equal(fixture.dialog.querySelector('pre').textContent, sources.writer)
  assert.equal(choices[0].getAttribute('aria-pressed'), 'false')
  assert.equal(choices[1].getAttribute('aria-pressed'), 'true')
  assert.equal(choices[1].classList.contains('bg-ink/5'), true)
  assert.equal(choices[0].classList.contains('bg-ink/5'), false)
  let use = fixture.dialog.querySelector('footer button:last-child')
  assert.equal(use.textContent, 'Use')
  await act(async () => use.click())
  assert.equal(fixture.uses.length, 1)
  assert.equal(fixture.uses[0], templates[1])

  await act(async () => choices[0].click())
  assert.equal(fixture.previews[1], templates[0])
  assert.equal(fixture.dialog.querySelector('pre').textContent, sources.research)
  assert.equal(choices[0].getAttribute('aria-pressed'), 'true')
  assert.equal(choices[1].getAttribute('aria-pressed'), 'false')
  use = fixture.dialog.querySelector('footer button:last-child')
  await act(async () => use.click())
  assert.equal(fixture.uses.length, 2)
  assert.equal(fixture.uses[1], templates[0])
  assert.equal(fixture.closes, 0)
})

test('the list item wrapper is not an additional clickable template control', async context => {
  const fixture = await mount(context)
  await act(async () => fixture.dialog.querySelector('li').click())
  assert.deepEqual(fixture.previews, [])
  assert.equal(fixture.dialog.querySelector('pre'), null)
})

test('Cancel closes the selected template modal and restores its launcher', async context => {
  const fixture = await mount(context)
  const choice = fixture.dialog.querySelector('li > button')
  assert.ok(choice)
  await act(async () => choice.click())
  const cancel = fixture.dialog.querySelector('footer button:first-child')
  assert.equal(cancel.textContent, 'Cancel')
  await closeAndExpectFocus(fixture, () => cancel.click())
  assert.deepEqual(fixture.uses, [])
})

test('ordinary Escape closes the real template modal and restores its launcher', async context => {
  const fixture = await mount(context)
  const close = fixture.dialog.querySelector('header button')
  await closeAndExpectFocus(fixture, () => {
    const escape = keydown(fixture, close, { key: 'Escape' })
    assert.equal(escape.defaultPrevented, true)
  })
  assert.deepEqual(fixture.previews, [])
  assert.deepEqual(fixture.uses, [])
})

test('IME and consumed Escape leave the template modal open before ordinary Escape still closes it', async context => {
  const fixture = await mount(context)
  const close = fixture.dialog.querySelector('header button')
  const dialog = fixture.dialog
  for (const properties of [
    { key: 'Escape', isComposing: true },
    { key: 'Escape', keyCode: 229 },
  ]) {
    let escape
    await act(async () => { escape = keydown(fixture, close, properties) })
    assert.equal(escape.defaultPrevented, false)
    assert.equal(fixture.closes, 0)
    assert.equal(fixture.dialog, dialog)
    assert.equal(document.activeElement, close)
  }
  close.addEventListener('keydown', event => event.preventDefault(), { once: true })
  await act(async () => keydown(fixture, close, { key: 'Escape' }))
  assert.equal(fixture.closes, 0)
  assert.equal(fixture.dialog, dialog)
  await closeAndExpectFocus(fixture, () => keydown(fixture, close, { key: 'Escape' }))
})

test('an empty template list keeps its explanatory copy and has no Use action', async context => {
  const fixture = await mount(context, { items: [] })
  assert.ok(fixture.dialog.textContent.includes('No agent-template plugins yet. Add a manifest under plugins/.'))
  assert.equal(fixture.dialog.querySelector('ul'), null)
  assert.equal(fixture.dialog.querySelector('footer'), null)
  assert.deepEqual(fixture.previews, [])
  assert.deepEqual(fixture.uses, [])
})

test('selecting a template while its source loads shows loading rather than stale preview source', async context => {
  const fixture = await mount(context, { loading: true })
  const choice = fixture.dialog.querySelector('li > button')
  assert.ok(choice)
  await act(async () => choice.click())
  assert.equal(fixture.previews[0], templates[0])
  assert.ok(fixture.dialog.textContent.includes('Loading…'))
  assert.equal(fixture.dialog.querySelector('pre'), null)
  assert.equal(choice.getAttribute('aria-pressed'), 'true')
})
