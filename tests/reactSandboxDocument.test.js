import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import {
  buildReactSandboxCsp,
  buildReactSandboxDoc,
} from '../src/pages/ChatSplit/preview/reactSandboxDocument.js'

const labels = {
  title: 'React preview',
  loading: 'Loading',
  runtimeError: 'Runtime: ',
  promiseError: 'Promise: ',
  missingDefault: 'Missing default',
  compileFailed: 'Compile: ',
  dependencyTimeout: 'Timeout',
}

test('React sandbox nonces every trusted script and avoids eval', () => {
  const nonce = 'reactPreviewNonce123+/='
  const html = buildReactSandboxDoc('export default function App(){ return <main>Hello</main> }', labels, { nonce })
  const trustedScripts = [...html.matchAll(/<script\b[^>]*data-yma-(?:react-sandbox|readability-guard)="[^"]+"[^>]*>/g)]

  assert.equal(trustedScripts.length, 6)
  for (const [script] of trustedScripts) assert.match(script, new RegExp(`\\bnonce="${nonce.replace(/[+/]/g, '\\$&')}"`))
  assert.doesNotMatch(html, /\beval\s*\(/)
  assert.doesNotMatch(html, /unsafe-eval/)
  assert.match(html, /createElement\('script'\)/)
  assert.match(html, /runner\.nonce=scriptNonce/)
})

test('React sandbox treats source as escaped data instead of trusted markup', () => {
  const nonce = 'trustedNonce123='
  const attack = `export default function App(){return null}</script><script nonce="${nonce}">window.pwned=true</script>`
  const html = buildReactSandboxDoc(attack, labels, { nonce })

  assert.doesNotMatch(html, /<script nonce="trustedNonce123=">window\.pwned=true<\/script>/)
  assert.match(html, /\\u003c\/script>\\u003cscript nonce=\\"trustedNonce123=\\">/)
  assert.equal((html.match(/data-yma-react-sandbox="boot"/g) || []).length, 1)
})

test('React sandbox CSP uses strict nonce authorization without unsafe-eval', () => {
  const csp = buildReactSandboxCsp('reactPreviewNonce123+/=')
  assert.match(csp, /script-src 'nonce-reactPreviewNonce123\+\/=' 'strict-dynamic'/)
  assert.doesNotMatch(csp, /unsafe-eval/)
  assert.match(csp, /object-src 'none'/)

  const rejected = buildReactSandboxDoc('export default function App(){}', labels, {
    nonce: '"><script>alert(1)</script>',
  })
  assert.doesNotMatch(rejected, /<script\b[^>]*\bnonce=/)
})

test('React sandbox boots compiled code through a nonceable script element', async () => {
  const html = buildReactSandboxDoc(
    'export default function App(){ return null }',
    labels,
    { nonce: 'runtimeNonce123=' },
  )
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.requestAnimationFrame = (callback) => callback()
      window.Babel = { transform: (source) => ({ code: source }) }
      window.React = {
        createElement: (type) => ({ type }),
      }
      window.ReactDOM = {
        createRoot: () => ({
          render: (element) => { window.__renderedReactElement = element },
        }),
      }
    },
  })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(dom.window.__renderedReactElement?.type?.name, 'App')
  const runner = dom.window.document.querySelector('[data-yma-react-sandbox="compiled-user-code"]')
  assert.equal(runner?.nonce, 'runtimeNonce123=')
  dom.window.close()
})
