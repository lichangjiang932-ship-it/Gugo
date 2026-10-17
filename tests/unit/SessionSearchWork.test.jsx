import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { setAuthToken } from '../../src/lib/accountClient.js'
import useSessionSearchResults from '../../src/components/leftRail/useSessionSearchResults.js'
const t = key => key, EMPTY = []
function Probe(props) { return <output>{JSON.stringify(useSessionSearchResults({ ...props, localResults: EMPTY, t }))}</output> }
test('local scanning shares the query debounce, skips closed/stale queries and still supplements authenticated server results', async context => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const timers = new Map(); let id = 0, scans = [], requests = 0
  dom.window.setTimeout = fn => { timers.set(++id, fn); return id }
  dom.window.clearTimeout = key => timers.delete(key)
  const previous = globalThis.fetch
  globalThis.fetch = async () => { requests += 1; return Response.json({ results: [{ sessionId: 'remote', messageId: 'r' }] }) }
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); setAuthToken(''); globalThis.fetch = previous; dom.window.close() })
  const getLocalResults = query => { scans.push(query); return [{ sessionId: 'unsynced', messageId: 'local' }] }
  const render = async (query, open = true) => act(async () => root.render(<Probe query={query} open={open} getLocalResults={getLocalResults} />))
  const flush = async () => { const pending = [...timers.values()]; timers.clear(); await act(async () => { for (const task of pending) await task() }) }
  setAuthToken('search-fixture')
  await render('a'); await render('ab'); await render('abc')
  assert.deepEqual(scans, [])
  assert.equal(timers.size, 1)
  await render('abc', false); await flush()
  assert.deepEqual(scans, [])
  await render('current'); await flush()
  assert.deepEqual(scans, ['current'])
  assert.equal(requests, 1)
  assert.deepEqual(JSON.parse(document.querySelector('output').textContent).results.map(r => r.sessionId), ['remote', 'unsynced'])
  setAuthToken('')
  await render('local'); await flush()
  assert.deepEqual(scans, ['current', 'local'])
  assert.equal(requests, 1)
})
test('streamed session churn does not restart the debounce and loading is immediate', async context => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const timers = new Map(); let id = 0
  dom.window.setTimeout = fn => { timers.set(++id, fn); return id }
  dom.window.clearTimeout = key => timers.delete(key)
  const root = createRoot(document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); setAuthToken(''); dom.window.close() })
  setAuthToken('')
  const scans = []
  const first = query => { scans.push('first:'+query); return [{ sessionId: 'first', messageId: 'm1' }] }
  const latest = query => { scans.push('latest:'+query); return [{ sessionId: 'latest', messageId: 'm2' }] }
  const render = async (query, getter) => act(async () => root.render(<Probe query={query} open getLocalResults={getter} />))
  const flush = async () => { const pending = [...timers.values()]; timers.clear(); await act(async () => { for (const task of pending) await task() }) }

  await render('stream', first)
  assert.equal(JSON.parse(document.querySelector('output').textContent).loading, true)
  assert.equal(timers.size, 1)
  await render('stream', latest)
  assert.equal(JSON.parse(document.querySelector('output').textContent).loading, true, 'streamed sessions must not clear loading')
  assert.equal(timers.size, 1, 'a new getter identity must not restart the debounce')
  await flush()
  assert.deepEqual(scans, ['latest:stream'], 'the latest getter supplies the settled fallback once')
  assert.equal(JSON.parse(document.querySelector('output').textContent).loading, false)
  assert.deepEqual(JSON.parse(document.querySelector('output').textContent).results.map(result => result.sessionId), ['latest'])

  await render('   ', first)
  assert.equal(JSON.parse(document.querySelector('output').textContent).loading, false)
  assert.equal(timers.size, 0, 'an empty query never schedules a scan')
  assert.deepEqual(scans, ['latest:stream'])
})

function luminance(rgb) { return rgb.map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 }).reduce((v,c,i) => v+c*[.2126,.7152,.0722][i], 0) }
test('the neutral search focus indicator reaches 3:1 against paper in all three declared themes', () => {
  const css = fs.readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')
  const block = css.slice(css.indexOf('.session-search-field:focus-within'), css.indexOf('input.session-search-input:focus'))
  const match = block.match(/var\((--color-[a-z-]+)\)(?: \/ ([.\d]+))?/)
  assert.ok(match)
  const values = name => [...css.matchAll(new RegExp(name+': ([0-9 ]+);','g'))].map(m => m[1].trim().split(/\s+/).map(Number))
  const inks = values(match[1]), papers = values('--color-paper-rgb'), alpha = Number(match[2] || 1)
  assert.equal(inks.length, 3)
  for (let index = 0; index < 3; index += 1) {
    const ink = luminance(inks[index].map((v,i) => alpha*v+(1-alpha)*papers[index][i])), paper = luminance(papers[index])
    const ratio = (Math.max(ink,paper)+.05)/(Math.min(ink,paper)+.05)
    assert.ok(ratio >= 3, 'theme '+index+' indicator ratio '+ratio)
  }
})
