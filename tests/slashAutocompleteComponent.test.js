import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { createSlashCommandRegistry } from '../src/lib/slashCommandRegistry.js'
import {
  getSlashAutocompleteItems,
  handleSlashAutocompleteKeyDown,
} from '../src/components/slashAutocompleteLogic.js'

let viteServer
let SlashAutocomplete

function command(name, description = name) {
  return { name, description, handler: async () => '' }
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

before(async () => {
  viteServer = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
  })
  SlashAutocomplete = (await viteServer.ssrLoadModule('/src/components/SlashAutocomplete.jsx')).default
})

after(async () => {
  await viteServer?.close()
})

test('getSlashAutocompleteItems opens for / and fuzzy matches /sea', () => {
  const registry = createSlashCommandRegistry({ storage: null })
  registry.register(command('clear'), 'core')
  registry.register(command('search'), 'core')

  assert.deepEqual(getSlashAutocompleteItems({ value: '/', registry }).map((item) => item.name), ['clear', 'search'])
  assert.deepEqual(getSlashAutocompleteItems({ value: '/sea', registry }).map((item) => item.name), ['search'])
  assert.deepEqual(getSlashAutocompleteItems({ value: 'hello /sea', registry }), [])
})

test('handleSlashAutocompleteKeyDown moves selection, picks, dismisses, and completes', () => {
  const items = [command('clear'), command('search')]
  let selected = 0
  let picked = null
  let dismissed = false
  let completed = null
  const event = (key) => ({
    key,
    preventDefault: () => {},
  })

  assert.equal(handleSlashAutocompleteKeyDown(event('ArrowDown'), {
    items,
    selectedIndex: selected,
    setSelectedIndex: (next) => { selected = next },
  }), true)
  assert.equal(selected, 1)

  handleSlashAutocompleteKeyDown(event('ArrowUp'), {
    items,
    selectedIndex: selected,
    setSelectedIndex: (next) => { selected = next },
  })
  assert.equal(selected, 0)

  handleSlashAutocompleteKeyDown(event('Enter'), {
    items,
    selectedIndex: 1,
    onPick: (item) => { picked = item },
  })
  assert.equal(picked.name, 'search')

  handleSlashAutocompleteKeyDown(event('Escape'), {
    items,
    onDismiss: () => { dismissed = true },
  })
  assert.equal(dismissed, true)

  handleSlashAutocompleteKeyDown(event('Tab'), {
    items,
    selectedIndex: 1,
    onComplete: (item) => { completed = item },
  })
  assert.equal(completed.name, 'search')
})

test('SlashAutocomplete renders popup and supports keyboard Enter/Escape', async () => {
  const dom = setupDom()
  const registry = createSlashCommandRegistry({ storage: null })
  registry.register(command('clear', 'Clear session'), 'core')
  registry.register(command('search', 'Search sessions'), 'core')
  let picked = null
  let dismissed = false
  const rootEl = dom.window.document.getElementById('root')
  const root = createRoot(rootEl)

  function Harness() {
    const [selectedIndex, setSelectedIndex] = React.useState(0)
    return React.createElement(SlashAutocomplete, {
      value: '/',
      registry,
      visible: true,
      selectedIndex,
      setSelectedIndex,
      onPick: (entry) => { picked = entry },
      onDismiss: () => { dismissed = true },
    })
  }

  await act(async () => {
    root.render(React.createElement(Harness))
  })

  const overlay = rootEl.querySelector('[data-testid="slash-autocomplete-overlay"]')
  assert.ok(overlay)
  assert.equal(rootEl.querySelectorAll('[data-testid="slash-autocomplete-item"]').length, 2)
  assert.equal(rootEl.querySelector('[aria-selected="true"]').dataset.name, 'clear')

  await act(async () => {
    overlay.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    }))
  })
  assert.equal(rootEl.querySelector('[aria-selected="true"]').dataset.name, 'search')

  await act(async () => {
    overlay.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }))
  })
  assert.equal(picked.name, 'search')

  await act(async () => {
    overlay.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }))
  })
  assert.equal(dismissed, true)

  await act(async () => {
    root.unmount()
  })
})

