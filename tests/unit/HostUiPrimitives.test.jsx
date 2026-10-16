import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, useContext, act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import ToolCallCard from '../../src/components/ToolCallCard.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import Segmented from '../../src/components/ui/Segmented.jsx'
import PopoverPortal from '../../src/components/ui/PopoverPortal.jsx'
import { HostMotionProvider, motion, useMotionPreference } from '../../src/lib/hostMotion.js'

function dom() {
  const d = new JSDOM('<div id="root"></div><button id="anchor"></button>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: d.window, document: d.window.document, HTMLElement: d.window.HTMLElement, SVGElement: d.window.SVGElement, IS_REACT_ACT_ENVIRONMENT: true })
  return d
}
test('segmented choices are controlled, keyboard reachable, disabled-safe and isolated across instances', async () => {
  const d = dom(), root = createRoot(document.getElementById('root')), changes = []
  const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }]
  try {
    await act(async () => root.render(<><Segmented value="a" options={options} label="One" onChange={v => changes.push(v)} /><Segmented role="tablist" value="c" options={options} label="Two" /></>))
    const groups = document.querySelectorAll('.gugo-segmented'), first = groups[0].querySelector('button')
    first.focus()
    await act(async () => first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.equal(document.activeElement.textContent, 'C')
    assert.deepEqual(changes, ['c'])
    assert.equal(groups[0].querySelector('[aria-pressed=true]').textContent, 'A')
    assert.equal(groups[1].querySelector('[aria-selected=true]').textContent, 'C')
    assert.notEqual(groups[0].querySelector('button').id, groups[1].querySelector('button').id)
  } finally { await act(async () => root.unmount()); d.window.close() }
})
test('popover escapes CSS containment while retaining React context and scoped style overrides', async () => {
  const d = dom(), root = createRoot(document.getElementById('root')), Context = createContext('missing')
  const anchor = document.getElementById('anchor'); anchor.style.setProperty('--local-preview-test', '17px')
  function Content() { return <span data-testid="portal-content">{useContext(Context)}</span> }
  try {
    await act(async () => root.render(<Context.Provider value="owner-a"><PopoverPortal anchorRef={{ current: anchor }}><Content /></PopoverPortal></Context.Provider>))
    const portal = document.querySelector('[data-host-popover]')
    assert.equal(portal.parentElement, document.body)
    assert.equal(document.getElementById('root').contains(portal), false)
    assert.equal(portal.textContent, 'owner-a')
    assert.equal(portal.style.getPropertyValue('--local-preview-test'), '17px')
    assert.equal(portal.style.position, 'fixed')
  } finally { await act(async () => root.unmount()); d.window.close() }
})
test('missing tool payload is explicitly unavailable instead of crashing or claiming running', () => {
  const html = renderToStaticMarkup(<I18nProvider><ToolCallCard call={null} /></I18nProvider>)
  assert.match(html, /data-status="unavailable"/)
  assert.doesNotMatch(html, /data-status="running"/)
})

test('system motion preference changes are subscribed live, not captured only at mount', async () => {
  const d = dom(), root = createRoot(document.getElementById('root')), listeners = new Set()
  const media = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) }
  window.matchMedia = () => media
  function Probe() { return <output>{String(useMotionPreference(true))}</output> }
  try {
    await act(async () => root.render(<Probe />))
    assert.equal(document.querySelector('output').textContent, 'true')
    await act(async () => { media.matches = true; for (const listener of listeners) listener() })
    assert.equal(document.querySelector('output').textContent, 'false')
  } finally { await act(async () => root.unmount()); d.window.close() }
})

test('disabled host motion has no hidden or displaced initial frame in server-rendered content', () => {
  const markup = renderToStaticMarkup(<HostMotionProvider enabled={false}><motion.div initial={{ opacity: 0, x: 32 }} animate={{ opacity: 1, x: 0 }}>Visible</motion.div></HostMotionProvider>)
  assert.match(markup, /Visible/)
  assert.doesNotMatch(markup, /opacity:0|translateX\(32px\)/)
})
