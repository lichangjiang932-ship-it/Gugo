import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DirectFileToolbar } from '../../src/pages/ChatSplit/preview/PreviewChrome.jsx'
import DirectFilePreview from '../../src/pages/ChatSplit/preview/DirectFilePreview.jsx'
import RightWorkbench from '../../src/pages/ChatSplit/RightWorkbench.jsx'

function setup() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const element = document.getElementById('root')
  return { dom, element, root: createRoot(element) }
}

const t = (key, args = {}) => args.path ? `${key}: ${args.path}` : key

function PreviewFixture({ file }) {
  const [view, setView] = useState('preview')
  return <>
    <DirectFileToolbar file={file} filename={file.filename} type={file.type} url={file.url} view={view} setView={setView} t={t} />
    <DirectFilePreview file={file} url={file.url} view={view} t={t} />
  </>
}

function findButton(element, key) {
  return [...element.querySelectorAll('button')].find((button) => button.textContent.includes(key))
}

test('direct files open in reading view with a path, source toggle and secondary Save as', async () => {
  const { dom, element, root } = setup()
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('# Readable report\n\nContent')
  const file = { filename: 'report.md', path: 'C:\\Workspace\\reports\\report.md', type: 'md', url: '/api/artifacts/report.md' }
  try {
    await act(async () => root.render(<PreviewFixture file={file} />))
    assert.equal(element.querySelector('h1').textContent, 'Readable report')
    assert.equal(element.querySelector('[data-testid="preview-file-path"]').getAttribute('title'), file.path)
    const open = element.querySelector('[data-testid="preview-open-menu"]')
    assert.equal(open.tagName, 'SUMMARY')
    assert.match(open.textContent, /chatPreview.openFile/)
    assert.doesNotMatch(open.textContent, /download|saveAs/)
    assert.equal(element.querySelector('a[download="report.md"]').textContent, 'chatPreview.saveAs')
    assert.equal(findButton(element, 'chatPreview.openDefaultApp'), undefined)
    await act(async () => findButton(element, 'chatPreview.source').click())
    assert.equal(element.querySelector('h1'), null)
    assert.match(element.querySelector('pre').textContent, /^# Readable report/)
    assert.equal(findButton(element, 'chatPreview.source').getAttribute('aria-pressed'), 'true')
    await act(async () => findButton(element, 'chatPreview.preview').click())
    assert.equal(element.querySelector('h1').textContent, 'Readable report')
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = oldFetch
    dom.window.close()
  }
})

test('HTML source is escaped text and source failures show actionable permission state', async () => {
  const { dom, element, root } = setup()
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('<script>window.BAD=true</script><img src="remote">')
  try {
    await act(async () => root.render(<DirectFilePreview view="source" file={{ filename: 'index.html' }} url="/api/artifacts/index.html" t={t} />))
    assert.equal(element.querySelector('iframe, script, img'), null)
    assert.match(element.querySelector('pre').textContent, /<script>/)
    assert.equal(dom.window.BAD, undefined)
    globalThis.fetch = async () => new Response('', { status: 403 })
    await act(async () => root.render(<DirectFilePreview view="source" file={{ filename: 'denied.md' }} url="/api/artifacts/denied.md" t={t} />))
    assert.equal(element.querySelector('[role="status"]').dataset.errorCode, 'SOURCE_PREVIEW_DENIED')
    assert.match(element.textContent, /chatPreview.sourceDenied/)
    assert.ok(findButton(element, 'chatPreview.retryPreview'))
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = oldFetch
    dom.window.close()
  }
})

test('switching source files aborts the previous request and never shows a late old response', async () => {
  const { dom, element, root } = setup()
  const oldFetch = globalThis.fetch
  let resolveOld
  let oldSignal
  globalThis.fetch = async (url, options) => {
    if (url.includes('old.md')) {
      oldSignal = options.signal
      return new Promise((resolve) => { resolveOld = resolve })
    }
    return new Response('new source')
  }
  try {
    await act(async () => root.render(<DirectFilePreview view="source" file={{ filename: 'old.md' }} url="/old.md" t={t} />))
    await act(async () => root.render(<DirectFilePreview view="source" file={{ filename: 'new.md' }} url="/new.md" t={t} />))
    assert.equal(oldSignal.aborted, true)
    await act(async () => resolveOld(new Response('stale source')))
    assert.equal(element.querySelector('pre').textContent, 'new source')
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = oldFetch
    dom.window.close()
  }
})

test('desktop menu sends only a server reference, preserves denied state and hides unavailable editor actions', async () => {
  const { dom, element, root } = setup()
  const calls = []
  dom.window.localStorage.setItem('your-model-atelier:auth-token', 'synthetic-token')
  dom.window.gugoDesktop = { isDesktop: true, fileAction: async (payload) => {
    calls.push(payload)
    return { ok: false, error: { code: 'PATH_NOT_AUTHORIZED' } }
  } }
  const file = { filename: 'report.pdf', type: 'pdf', path: 'C:\\untrusted-ui-path\\report.pdf', url: '/api/local-files/verified/receipt?turnId=turn' }
  try {
    await act(async () => root.render(<DirectFileToolbar file={file} filename={file.filename} type="pdf" url={file.url} t={t} />))
    await act(async () => findButton(element, 'chatPreview.openDefaultApp').click())
    assert.deepEqual(calls, [{ action: 'open', reference: { kind: 'verified', fileId: 'receipt', turnId: 'turn' }, authToken: 'synthetic-token' }])
    assert.match(element.querySelector('[role="alert"]').textContent, /chatPreview.fileActionDenied/)
    assert.doesNotMatch(element.textContent, /VS Code|Cursor|Terminal/)
    const other = { ...file, url: 'https://outside.invalid/report.pdf' }
    await act(async () => root.render(<DirectFileToolbar file={other} filename={other.filename} type="pdf" url={other.url} t={t} />))
    assert.equal(findButton(element, 'chatPreview.openDefaultApp'), undefined)
    assert.equal(element.querySelector('[role="alert"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('desktop file menu distinguishes canceled Open from an actual Reveal request and closes with Escape', async () => {
  const { dom, element, root } = setup()
  const actions = []
  dom.window.gugoDesktop = { isDesktop: true, fileAction: async ({ action }) => {
    actions.push(action)
    return { ok: true, canceled: action === 'open', action }
  } }
  const file = { filename: 'report.pdf', type: 'pdf', url: '/api/artifacts/report.pdf' }
  let outerEscape = 0
  const onKey = (event) => { if (event.key === 'Escape') outerEscape += 1 }
  document.addEventListener('keydown', onKey)
  try {
    await act(async () => root.render(<DirectFileToolbar file={file} filename={file.filename} type="pdf" url={file.url} t={t} />))
    await act(async () => findButton(element, 'chatPreview.openDefaultApp').click())
    assert.equal(element.querySelector('[role="status"]'), null, 'cancel must not claim the file was opened')
    await act(async () => findButton(element, 'chatPreview.revealFile').click())
    assert.match(element.querySelector('[role="status"]').textContent, /chatPreview.fileRevealRequested/)
    assert.deepEqual(actions, ['open', 'reveal'])
    const details = element.querySelector('details')
    details.open = true
    await act(async () => details.querySelector('summary').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(details.open, false)
    assert.equal(outerEscape, 0)
  } finally {
    document.removeEventListener('keydown', onKey)
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('workbench separates source attachments and preserves legacy verified read snapshots', async () => {
  const { dom, element, root } = setup()
  const opened = []
  const localPath = 'C:\\Workspace\\legacy.md'
  const source = '# Legacy snapshot'
  try {
    await act(async () => root.render(<RightWorkbench activeTab="files" onClose={() => {}} onTabChange={() => {}}
      onOpenArtifact={(artifact) => opened.push(artifact)}
      attachments={[{ id: 'source-pdf', name: 'input.pdf', mimeType: 'application/pdf', downloadUrl: '/api/attachments/source-pdf/content' }]}
      messages={[{ id: 'legacy', role: 'assistant', meta: { toolCalls: [
        { id: 'write-legacy', name: 'write_file', args: { path: localPath, content: source }, result: { ok: true, path: localPath } },
        { id: 'read-legacy', name: 'read_file', result: { ok: true, path: localPath, content: source, returnedLines: 1, totalLines: 1 } },
      ] } }]} />))
    const outputs = element.querySelector('[data-testid="workbench-outputs"]')
    const sources = element.querySelector('[data-testid="workbench-sources"]')
    assert.match(outputs.textContent, /legacy\.md/)
    assert.match(outputs.textContent, /历史读取快照/)
    assert.match(sources.textContent, /input\.pdf/)
    assert.equal(outputs.querySelector('a[download]'), null, 'snapshot markers are not actual download routes')
    await act(async () => outputs.querySelector('[data-testid="workbench-file-open"]').click())
    assert.equal(opened[0].content, source)
    assert.equal(opened[0].preview.path, localPath)
    assert.equal(opened[0].directFile, undefined)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('workbench browser rejects local files and explains cross-origin embedding limits without claiming success', async () => {
  const { dom, element, root } = setup()
  try {
    await act(async () => root.render(<RightWorkbench activeTab="browser" onClose={() => {}} onTabChange={() => {}} />))
    const input = element.querySelector('input')
    const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'))
    const enter = async (value) => {
      await act(async () => input[propsKey].onChange({ target: { value } }))
      await act(async () => element.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
    }
    await enter('file:///C:/report.html')
    assert.equal(element.querySelector('iframe'), null)
    assert.match(element.querySelector('[role="alert"]').textContent, /本地文件路径/)
    await enter('https://example.invalid/report')
    const frame = element.querySelector('iframe')
    assert.equal(frame.getAttribute('src'), 'https://example.invalid/report')
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-forms allow-popups')
    assert.match(element.textContent, /禁止嵌入/)
    assert.match(element.querySelector('a[target="_blank"]').rel, /noopener/)
    await act(async () => frame.dispatchEvent(new dom.window.Event('load')))
    assert.match(element.textContent, /并不表示加载成功/)
    await act(async () => frame.dispatchEvent(new dom.window.Event('error')))
    assert.match(element.querySelector('[role="alert"]').textContent, /未能在面板中打开/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
