import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { ArtifactReferenceLinks } from '../src/pages/ChatSplit/chatMessages/ArtifactCards.jsx'
import MessageRow from '../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
import { mergeServerSessionMessages } from '../src/store/sessionServerSync.js'
import { resolveDeliveryArtifacts } from '../src/lib/artifactReferences.js'
import { normalizeServerSessionSnapshot } from '../src/lib/turnClient/sessionSnapshot.js'

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

test('delivery artifact filtering fails closed without a selection and preserves explicit final ids', () => {
  const artifacts = [
    { id: 'draft', filename: 'draft.py' },
    { id: 'preview', filename: 'preview.png' },
    { id: 'final', filename: 'report.pdf' },
  ]
  assert.deepEqual(resolveDeliveryArtifacts({ serverArtifacts: artifacts }), [])
  assert.deepEqual(resolveDeliveryArtifacts({
    serverArtifacts: artifacts,
    serverDeliveryArtifactIds: ['final', 'draft', 'missing', 'final'],
  }), [artifacts[2], artifacts[0]])
  assert.deepEqual(resolveDeliveryArtifacts({
    serverArtifacts: artifacts,
    serverDeliveryArtifactIds: [],
  }), [])

  const [merged] = mergeServerSessionMessages(
    [{
      id: 'delivery-message',
      role: 'assistant',
      content: 'done',
      meta: { serverDeliveryArtifactIds: ['draft'] },
    }],
    [{
      id: 'delivery-message',
      role: 'assistant',
      content: 'done',
      meta: { serverAuthoritative: true, serverDeliveryArtifactIds: [] },
    }],
  )
  assert.ok(Object.hasOwn(merged.meta, 'serverDeliveryArtifactIds'))
  assert.deepEqual(merged.meta.serverDeliveryArtifactIds, [])
})

test('failed and restored legacy turns never expose unselected intermediate artifacts', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const artifact = {
    id: 'legacy-helper',
    filename: 'render-preview.py',
    type: 'file',
    url: '/api/artifacts/legacy-helper',
  }
  const failed = {
    id: 'failed-with-helper',
    role: 'assistant',
    content: 'Task failed after creating [render-preview.py](/api/artifacts/legacy-helper).',
    timestamp: Date.now(),
    meta: { failed: true, serverArtifacts: [artifact] },
  }
  const restored = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'legacy-restored:assistant',
      role: 'assistant',
      content: 'Legacy task created render-preview.py before it stopped.',
      createdAt: Date.now(),
      artifacts: [artifact],
      modelContext: { turnId: 'legacy-restored' },
    }],
  }).messages[0]

  try {
    for (const msg of [failed, restored]) {
      await act(async () => root.render(
        <MessageRow
          msg={msg}
          rowKey={msg.id}
          generatingMessageId=""
          lang="en"
          t={(key) => key}
        />,
      ))
      assert.equal(rootElement.querySelectorAll('[data-testid="artifact-open-card"]').length, 0)
      assert.equal(rootElement.querySelectorAll('[data-testid="inline-artifact-link"]').length, 0)
      assert.equal(rootElement.querySelector('[data-testid="artifact-reference-links"]'), null)
    }
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('generated file names render as highlighted links and open the right-pane payload', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const msg = {
    id: 'message-1',
    content: 'The calculator is ready.',
    meta: {
      serverArtifacts: [{ id: 'file-1', filename: 'calculator.html', type: 'html', url: '/api/artifacts/file-1' }],
      serverDeliveryArtifactIds: ['file-1'],
    },
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

test('explicit empty delivery suppresses an artifactSource preview card below the message', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'empty-delivery-source',
    role: 'assistant',
    content: 'No file is intentionally delivered.',
    timestamp: Date.now(),
    meta: {
      artifactType: 'html',
      artifactTitle: 'Draft page',
      artifactSource: '<!doctype html><html><body>Draft</body></html>',
      serverArtifacts: [{ id: 'draft', filename: 'draft.html', type: 'html', url: '/api/artifacts/draft' }],
      serverDeliveryArtifactIds: [],
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
    assert.equal(rootElement.querySelectorAll('[data-testid="artifact-open-card"]').length, 0)
    assert.equal(rootElement.querySelector('[data-testid="artifact-reference-links"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an unselected managed artifact URL is rendered as text instead of a live draft link', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'unselected-managed-link',
    role: 'assistant',
    content: 'Draft: [draft.html](/api/artifacts/draft.html)',
    timestamp: Date.now(),
    meta: {
      serverArtifacts: [{ id: 'draft', filename: 'draft.html', type: 'html', url: '/api/artifacts/draft.html' }],
      serverDeliveryArtifactIds: [],
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
    assert.equal(rootElement.querySelector('a[href="/api/artifacts/draft.html"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="blocked-artifact-link"]')?.textContent, 'draft.html')
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
      serverDeliveryArtifactIds: ['docx-1'],
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
      serverDeliveryArtifactIds: ['file-1'],
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
    assert.match(rootElement.textContent, /Server turn completed/)
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
      serverDeliveryArtifactIds: ['html-1', 'docx-1', 'xlsx-1', 'pptx-1', 'pdf-1'],
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
      serverDeliveryArtifactIds: ['html-1'],
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

test('a generated filename inside a Windows path with spaces and Chinese opens inline', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const msg = {
    id: 'windows-local-output-message',
    role: 'assistant',
    content: '已创建：D:\\本地 输出\\填写后 答题卡.pdf，并完成逐页检查。',
    timestamp: Date.now(),
    meta: {
      serverArtifacts: [{
        id: 'local-pdf-1',
        filename: '填写后 答题卡.pdf',
        type: 'pdf',
        url: '/api/artifacts/%E5%A1%AB%E5%86%99%E5%90%8E%20%E7%AD%94%E9%A2%98%E5%8D%A1.pdf',
      }],
      serverDeliveryArtifactIds: ['local-pdf-1'],
    },
  }

  try {
    await act(async () => root.render(
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        lang="zh"
        onOpenArtifact={(artifact) => opened.push(artifact)}
        t={(key) => key}
      />,
    ))
    const link = rootElement.querySelector('[data-testid="inline-artifact-link"]')
    assert.ok(link)
    assert.equal(link.textContent, '填写后 答题卡.pdf')
    assert.equal(rootElement.querySelectorAll('[data-testid="artifact-open-card"]').length, 0)
    await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })))
    assert.equal(opened[0].directFile.filename, '填写后 答题卡.pdf')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an inline-code Windows path opens only its selected deliverable artifact', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const finalPath = 'D:\\workspace\\output\\final report.pdf'
  const draftPath = 'D:\\workspace\\drafts\\draft.pdf'
  const unknownPath = 'D:\\workspace\\private\\unknown.pdf'
  const msg = {
    id: 'windows-inline-code-output',
    role: 'assistant',
    content: `Final: \`${finalPath}\`. Draft: \`${draftPath}\`. Unknown: \`${unknownPath}\`.`,
    timestamp: Date.now(),
    meta: {
      serverArtifacts: [
        { id: 'final-pdf', filename: 'final report-2.pdf', title: 'final report.pdf', type: 'pdf', url: '/api/artifacts/final-pdf' },
        { id: 'draft-pdf', filename: 'draft.pdf', type: 'pdf', url: '/api/artifacts/draft-pdf' },
      ],
      serverDeliveryArtifactIds: ['final-pdf'],
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
    const links = [...rootElement.querySelectorAll('[data-testid="inline-artifact-link"]')]
    assert.equal(links.length, 1)
    assert.equal(links[0].textContent, finalPath)
    assert.equal(rootElement.querySelectorAll('[data-testid="artifact-open-card"]').length, 0)
    assert.equal([...rootElement.querySelectorAll('code')].some((code) => code.textContent === draftPath), true)
    assert.equal([...rootElement.querySelectorAll('code')].some((code) => code.textContent === unknownPath), true)

    await act(async () => links[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })))
    assert.equal(opened.length, 1)
    assert.equal(opened[0].directFile.id, 'final-pdf')
    assert.equal(opened[0].directFile.filename, 'final report-2.pdf')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an explicit Markdown link to a local Windows output is rewritten to the persisted artifact', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const msg = {
    id: 'windows-local-markdown-link',
    role: 'assistant',
    content: '下载：[填写后 答题卡.pdf](<D:\\本地 输出\\填写后 答题卡.pdf>)',
    timestamp: Date.now(),
    meta: {
      serverArtifacts: [{
        id: 'local-pdf-markdown',
        filename: '填写后 答题卡.pdf',
        type: 'pdf',
        url: '/api/artifacts/%E5%A1%AB%E5%86%99%E5%90%8E%20%E7%AD%94%E9%A2%98%E5%8D%A1.pdf',
      }],
      serverDeliveryArtifactIds: ['local-pdf-markdown'],
    },
  }

  try {
    await act(async () => root.render(
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        lang="zh"
        onOpenArtifact={(artifact) => opened.push(artifact)}
        t={(key) => key}
      />,
    ))
    const link = rootElement.querySelector('[data-testid="inline-artifact-link"]')
    assert.ok(link)
    assert.match(link.getAttribute('href'), /^\/api\/artifacts\//)
    assert.equal(rootElement.querySelectorAll('[data-testid="artifact-open-card"]').length, 0)
    await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })))
    assert.equal(opened[0].directFile.filename, '填写后 答题卡.pdf')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a paused assistant message renders a camelCase directory request inline', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const authorizations = []
  const msg = {
    id: 'paused-directory-message',
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    meta: {
      paused: true,
      serverTurnId: 'turn-paused',
      serverClarification: {
        requestType: 'directory',
        accessMode: 'read_write',
        suggestedPath: 'D:\\destok',
        purpose: '需要写入结果文件',
      },
    },
  }

  try {
    await act(async () => root.render(
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        lang="zh"
        onAuthorizeDirectoryRequest={(decision) => authorizations.push(decision)}
        t={(key) => key}
      />,
    ))

    const card = rootElement.querySelector('[data-testid="directory-request-card"]')
    assert.ok(card)
    assert.equal(card.querySelector('input').value, 'D:\\destok')
    assert.equal(card.querySelector('select').value, 'read_write')
    const grantButton = [...card.querySelectorAll('button')]
      .find((button) => button.textContent.includes('taskSteering.authorizeDirectory'))
    await act(async () => {
      grantButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    assert.equal(authorizations.length, 1)
    assert.equal(authorizations[0].message, msg)
    assert.deepEqual({
      path: authorizations[0].path,
      accessMode: authorizations[0].accessMode,
      usePicker: authorizations[0].usePicker,
    }, {
      path: 'D:\\destok',
      accessMode: 'read_write',
      usePicker: false,
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a paused server snapshot survives stale local metadata and renders its inline directory card', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const [msg] = mergeServerSessionMessages(
    [{
      id: 'turn-paused:assistant',
      role: 'assistant',
      content: 'Please choose and authorize a directory so this task can continue.',
      timestamp: 1,
      meta: {
        streaming: true,
        serverTurnId: 'turn-paused',
        serverLastSequence: 6,
        serverConnectionState: 'connected',
        serverClarification: null,
      },
    }],
    [{
      id: 'turn-paused:assistant',
      role: 'assistant',
      content: 'Please choose and authorize a directory so this task can continue.',
      timestamp: 1,
      meta: {
        streaming: false,
        paused: true,
        serverTurnId: 'turn-paused',
        serverLastSequence: 7,
        serverConnectionState: 'paused',
        serverClarification: {
          request_type: 'directory',
          access_mode: 'read_write',
          suggested_path: 'D:\\destok',
          purpose: 'Write the completed PDF and PNG preview.',
        },
      },
    }],
  )

  try {
    await act(async () => root.render(
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId=""
        lang="en"
        onAuthorizeDirectoryRequest={() => {}}
        t={(key) => key}
      />,
    ))

    const card = rootElement.querySelector('[data-testid="directory-request-card"]')
    assert.ok(card)
    assert.equal(card.querySelector('input').value, 'D:\\destok')
    assert.equal(card.querySelector('select').value, 'read_write')
    assert.match(card.textContent, /Write the completed PDF and PNG preview\./)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
