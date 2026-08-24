import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMessageReplayRequest } from '../src/pages/ChatSplit/messageReplay.js'

test('message replay resolves the preceding user prompt and restores ready attachments', () => {
  const user = {
    id: 'user-2',
    role: 'user',
    content: 'Revise the report',
    attachments: [{ id: 'file-1', name: '../report.md', mimeType: 'text/markdown', size: 2048 }],
  }
  const assistant = { id: 'assistant-2', role: 'assistant', content: 'Done', meta: { type: 'model_reply' } }
  const request = buildMessageReplayRequest([
    { id: 'user-1', role: 'user', content: 'Earlier' },
    { id: 'assistant-1', role: 'assistant', content: 'Earlier answer' },
    user,
    assistant,
  ], assistant)

  assert.equal(request.content, 'Revise the report')
  assert.equal(request.historyLimit, 2)
  assert.equal(request.sourceMessageId, 'user-2')
  assert.deepEqual(request.attachments, [{
    id: 'file-1',
    name: 'report.md',
    mimeType: 'text/markdown',
    type: 'text/markdown',
    size: 2048,
    sizeKB: '2.0',
    sha256: '',
    downloadUrl: '',
    uploadStatus: 'ready',
  }])
})

test('message replay refuses missing anchors and empty prompts without usable attachments', () => {
  const user = { id: 'user', role: 'user', content: '', attachments: [{ name: 'missing.txt' }] }
  assert.equal(buildMessageReplayRequest([user], user), null)
  assert.equal(buildMessageReplayRequest([user], { id: 'other', role: 'user' }), null)
})
