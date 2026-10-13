import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')
const read = (relative) => fs.readFileSync(path.join(src, relative), 'utf8')

test('the router shell adds no landmark of its own', () => {
  // It used to wrap every route in a `<main>`. That put a second landmark
  // outside each page's — two nested `<main>`s, of which a reader is only ever
  // offered one — and it put the navigation rail inside it besides, because
  // `AppLayout` renders the rail and the page content as siblings. The page owns
  // the landmark; the rail sits outside it.
  const withoutComments = read('App.jsx').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(withoutComments, /<main[\s>]/)
  assert.doesNotMatch(withoutComments, /mainAs=/)
})

test('every page on the app shell provides exactly one main landmark', () => {
  const pages = fs.readdirSync(path.join(src, 'pages'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsx'))
  const missing = []
  const doubled = []
  let checked = 0
  for (const entry of pages) {
    const source = read(path.join('pages', entry.name))
    if (!source.includes('<AppLayout')) continue
    checked += 1
    const written = (source.match(/<main[\s>]/g) || []).length
    const throughShell = (source.match(/mainAs="main"/g) || []).length
    if (written + throughShell === 0) missing.push(entry.name)
    else if (written + throughShell > 1) doubled.push(entry.name)
  }
  // A guard against the scan quietly matching nothing and passing.
  assert.ok(checked > 10, `expected to inspect the app's pages, saw ${checked}`)
  assert.deepEqual(missing, [], 'a page on the app shell must provide a main landmark')
  assert.deepEqual(doubled, [], 'a page must not provide two')
})
