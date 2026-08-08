import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { ArtifactReferenceLinks } from '../src/pages/ChatSplit/chatMessages/ArtifactCards.jsx'
import MessageRow from '../src/pages/ChatSplit/chatMessages/MessageRow.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

test('generated file names render as highlighted links and open the right-pane payload', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const msg = {
    id: 'message-1',
    content: 'The calculator is ready.',
    meta: { serverArtifacts: [{ id: 'file-1', filename: 'calculator.html', type: 'html', url: '/api/artifacts/file-1' }] },
  }
  const preview = { type: 'html', filename: 'generated.html', html: '<main>Calculator</main>' }

  try {
    await act(async () => root.render(<ArtifactReferenceLinks msg={msg} preview={preview} onOpen={(artifact) => opened.push(artifact)} />))
    const link = rootElement.querySelector('button')
    assert.ok(link)
    assert.match(link.textContent, /calculator\.html/)
    assert.match(link.className, /bg-ember-soft/)
    await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(opened[0].directFile.filename, 'calculator.html')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an inline generated-file link keeps narration, opens the real file, and suppresses the duplicate card', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const msg = {
    id: 'inline-docx-message',
    role: 'assistant',
    content: '文档已经生成，可直接查看：[项目总结.docx](/api/artifacts/%E9%A1%B9%E7%9B%AE%E6%80%BB%E7%BB%93.docx)',
    timestamp: Date.now(),
    meta: {
      artifactType: 'docx',
      artifactTitle: '项目总结',
      serverArtifacts: [{ id: 'docx-1', filename: '项目总结.docx', type: 'docx', url: '/api/artifacts/%E9%A1%B9%E7%9B%AE%E6%80%BB%E7%BB%93.docx' }],
    },
  }

  try {
    await act(async () => root.render(
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        isGenerating={false}
        lang="zh"
        onOpenArtifact={(artifact) => opened.push(artifact)}
        t={(key) => key}
      />,
    ))
    assert.match(rootElement.textContent, /文档已经生成，可直接查看/)
    assert.equal(rootElement.querySelectorAll('[data-testid="artifact-open-card"]').length, 0)
    const inlineLink = rootElement.querySelector('a[href*="api/artifacts"]')
    assert.ok(inlineLink)
    await act(async () => inlineLink.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })))
    assert.equal(opened.length, 1)
    assert.equal(opened[0].directFile.filename, '项目总结.docx')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a completed artifact keeps its narration and file link while a later reply is generating', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'completed-artifact-message',
    role: 'assistant',
    content: '<!doctype html><html><body><h1>Calculator source</h1></body></html>',
    timestamp: Date.now(),
    meta: {
      streaming: false,
      serverArtifacts: [{ id: 'file-1', filename: 'calculator.html', type: 'html', url: '/api/artifacts/file-1' }],
    },
  }
  const t = (key) => key === 'chat.serverTurn.completed' ? '已完成' : key

  try {
    await act(async () => root.render(
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId="newer-assistant-message"
        isGenerating
        lang="zh"
        t={t}
      />,
    ))
    assert.match(rootElement.textContent, /已完成/)
    assert.match(rootElement.textContent, /calculator\.html/)
    assert.doesNotMatch(rootElement.textContent, /Calculator source/)
    assert.ok(rootElement.querySelector('[data-testid="artifact-open-card"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('plain, bold, and inline-code filenames open persisted artifacts without duplicate cards', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const msg = {
    id: 'mixed-artifact-message',
    role: 'assistant',
    content: 'Ready: site.html, **report.docx**, `budget.xlsx`, and deck.pptx. missing.pdf was not created.',
    timestamp: Date.now(),
    meta: {
      serverArtifacts: [
        { id: 'html-1', filename: 'site.html', type: 'html', url: '/api/artifacts/html-1' },
        { id: 'docx-1', filename: 'report.docx', type: 'docx', url: '/api/artifacts/docx-1' },
        { id: 'xlsx-1', filename: 'budget.xlsx', type: 'xlsx', url: '/api/artifacts/xlsx-1' },
        { id: 'pptx-1', filename: 'deck.pptx', type: 'pptx', url: '/api/artifacts/pptx-1' },
        { id: 'pdf-1', filename: 'manual.pdf', type: 'pdf', url: '/api/artifacts/pdf-1' },
      ],
    },
  }

  try {
    await act(async () => root.render(
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        lang="en"
        onOpenArtifact={(artifact) => opened.push(artifact)}
        t={(key) => key}
      />,
    ))
    const inlineLinks = [...rootElement.querySelectorAll('[data-testid="inline-artifact-link"]')]
    assert.deepEqual(inlineLinks.map((link) => link.textContent), ['site.html', 'report.docx', 'budget.xlsx', 'deck.pptx'])
    assert.equal(rootElement.querySelectorAll('[data-testid="artifact-open-card"]').length, 1)
    assert.match(rootElement.querySelector('[data-testid="artifact-open-card"]').textContent, /manual\.pdf/)
    assert.match(rootElement.textContent, /missing\.pdf was not created/)
    assert.equal([...rootElement.querySelectorAll('a')].some((link) => link.textContent === 'missing.pdf'), false)

    const docxLink = inlineLinks.find((link) => link.textContent === 'report.docx')
    await act(async () => docxLink.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })))
    assert.equal(opened.length, 1)
    assert.equal(opened[0].directFile.filename, 'report.docx')
    assert.equal(opened[0].directFile.url, '/api/artifacts/docx-1')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('similar names and fenced-code filenames do not become inline artifact links', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'non-linkable-artifact-message',
    role: 'assistant',
    content: 'The old filename was website.html.\n\n```text\nsite.html\n```',
    timestamp: Date.now(),
    meta: {
      serverArtifacts: [{ id: 'html-1', filename: 'site.html', type: 'html', url: '/api/artifacts/html-1' }],
    },
  }

  try {
    await act(async () => root.render(
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        lang="en"
        t={(key) => key}
      />,
    ))
    assert.equal(rootElement.querySelectorAll('[data-testid="inline-artifact-link"]').length, 0)
    assert.equal(rootElement.querySelectorAll('[data-testid="artifact-open-card"]').length, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
