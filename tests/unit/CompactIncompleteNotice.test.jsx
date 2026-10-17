import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
const summary = '任务尚未完全通过验证。已完成的本地修改会保留；请检查后继续。'
test('completion failure shows one red summary, keeps each file once, and retains structured diagnostics', async context => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(document.getElementById('root')), opened = []
  context.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  const msg = { id: 'turn:assistant', role: 'assistant', content: '任务尚未完全通过验证。已完成的本地修改会保留；请重试以继续验证。', meta: {
    failed: true, serverTurnId: 'turn', serverFailure: { code: 'TURN_INCOMPLETE', incompleteReason: 'post_mutation_verification_missing', missingRequirements: ['mutation_readback','diff_or_project_check'] },
    verifiedLocalFiles: [{ id: 'ppt', path: 'D:/fixture/讲解.pptx', filename: '讲解.pptx', size: 300 }, { id: 'script', path: 'D:/fixture/make.py', filename: 'make.py', size: 100 }],
  } }
  const original = JSON.stringify(msg)
  const t = key => key === 'chatMessages.replyPartiallyCompleted' ? summary : key
  await act(async () => root.render(<MessageRow msg={msg} rowKey={msg.id} generatingMessageId="" lang="zh" t={t} onOpenArtifact={file => opened.push(file)} />))
  const notice = document.querySelector('[data-testid=incomplete-task-notice]')
  assert.ok(notice?.classList.contains('text-danger'))
  assert.equal(notice.textContent, summary)
  assert.equal(document.body.textContent.includes('POST_MUTATION_VERIFICATION_MISSING'), false)
  assert.equal(document.querySelector('[data-testid=incomplete-task-missing]') !== null, false)
  assert.equal(document.querySelectorAll('[data-testid=artifact-open-card]').length, 2)
  assert.equal(document.querySelectorAll('[data-testid=incomplete-verified-files]').length, 0)
  await act(async () => document.querySelector('[data-testid=artifact-open-card]').click())
  assert.equal(opened.length, 1)
  assert.equal(JSON.stringify(msg), original)
})
