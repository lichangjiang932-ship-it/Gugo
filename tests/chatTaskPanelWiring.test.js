import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('chat split keeps task details out of the main chat surface', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /const tasks = state\.tasks/)
  assert.doesNotMatch(source, /hasTasks=\{tasks\.length > 0\}/)
  assert.doesNotMatch(source, /import ChatTaskStrip from '\.\/ChatTaskStrip'/)
  assert.doesNotMatch(source, /<ChatTaskStrip/)
  assert.doesNotMatch(source, /<ChatTaskPanel/)
})

test('chat keeps a real abort action without exposing the task strip', () => {
  const chatSource = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const viewSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatSplitView.jsx', import.meta.url), 'utf8')
  const detailSource = fs.readFileSync(new URL('../src/pages/TaskRunPanel.jsx', import.meta.url), 'utf8')

  assert.match(chatSource, /const handleAbortTask = \(\) => abortCtrlRef\.current\?\.abort\(\)/)
  assert.match(chatSource, /onAbort=\{handleAbortTask\}/)
  assert.match(viewSource, /onAbort=\{onAbort\}/)
  assert.doesNotMatch(chatSource, /onAbortTask=\{handleAbortTask\}/)
  assert.doesNotMatch(chatSource, /status:\s*'paused'/)
  assert.doesNotMatch(chatSource, /status:\s*'stopped'/)

  assert.doesNotMatch(detailSource, /status === 'paused'/)
  assert.doesNotMatch(detailSource, /handlePause/)
  assert.doesNotMatch(detailSource, /handleInterrupt/)
})

test('chat task views avoid speculative numeric progress while a model request is running', () => {
  const chatSource = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const serverTurnSource = fs.readFileSync(new URL('../src/pages/ChatSplit/serverTurnFlow.js', import.meta.url), 'utf8')
  const detailSource = fs.readFileSync(new URL('../src/pages/TaskRunPanel.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(chatSource, /progress:\s*10/)
  assert.doesNotMatch(chatSource, /chunkCount/)
  assert.doesNotMatch(chatSource, /nextProgress/)
  assert.match(serverTurnSource, /sawAssistantText/)
  assert.match(serverTurnSource, /stepLabel:\s*t\('chat\.serverTurn\.submit'\)/)

  assert.doesNotMatch(detailSource, /task\.progress/)
  assert.doesNotMatch(detailSource, /strokeDashoffset/)
})

test('chat forwards the persisted tool switches to the server turn flow', () => {
  const chatSource = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const serverTurnSource = fs.readFileSync(new URL('../src/pages/ChatSplit/serverTurnFlow.js', import.meta.url), 'utf8')

  assert.match(chatSource, /toolsConfig:\s*state\.toolsConfig/)
  assert.match(serverTurnSource, /toolsConfig:\s*buildServerToolsConfig\(toolsConfig\)/)
})
