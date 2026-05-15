import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('chat split uses an inline task strip instead of the right live task panel', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')

  assert.match(source, /import ChatTaskStrip from '\.\/ChatTaskStrip'/)
  assert.match(source, /const tasks = state\.tasks/)
  assert.match(source, /hasTasks=\{tasks\.length > 0\}/)
  assert.match(source, /<ChatTaskStrip/)
  assert.doesNotMatch(source, /<ChatTaskPanel/)
})

test('chat task strip exposes a real abort action instead of fake pause states', () => {
  const chatSource = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const stripSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatTaskStrip.jsx', import.meta.url), 'utf8')
  const detailSource = fs.readFileSync(new URL('../src/pages/TaskRunPanel.jsx', import.meta.url), 'utf8')

  assert.match(chatSource, /const handleAbortTask = \(\) => abortCtrlRef\.current\?\.abort\(\)/)
  assert.match(chatSource, /onAbortTask=\{handleAbortTask\}/)
  assert.doesNotMatch(chatSource, /status:\s*'paused'/)
  assert.doesNotMatch(chatSource, /status:\s*'stopped'/)

  assert.match(stripSource, /onAbortTask/)
  assert.doesNotMatch(stripSource, /onPauseTask/)
  assert.doesNotMatch(stripSource, /Pause/)

  assert.doesNotMatch(detailSource, /status === 'paused'/)
  assert.doesNotMatch(detailSource, /handlePause/)
  assert.doesNotMatch(detailSource, /handleInterrupt/)
})

test('chat task views avoid speculative numeric progress while a model request is running', () => {
  const chatSource = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const stripSource = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatTaskStrip.jsx', import.meta.url), 'utf8')
  const detailSource = fs.readFileSync(new URL('../src/pages/TaskRunPanel.jsx', import.meta.url), 'utf8')

  assert.doesNotMatch(chatSource, /progress:\s*10/)
  assert.doesNotMatch(chatSource, /chunkCount/)
  assert.doesNotMatch(chatSource, /nextProgress/)
  assert.match(chatSource, /sawTextThisRound/)
  assert.match(chatSource, /stepLabel:\s*'生成中'/)

  assert.doesNotMatch(stripSource, /Loader2/)
  assert.doesNotMatch(stripSource, /activeTask\.progress/)
  assert.doesNotMatch(stripSource, /role="progressbar"/)

  assert.doesNotMatch(detailSource, /task\.progress/)
  assert.doesNotMatch(detailSource, /strokeDashoffset/)
})
