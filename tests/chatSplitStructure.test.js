import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const modulePaths = [
  '../src/pages/ChatSplit/index.jsx',
  '../src/pages/ChatSplit/useChatCatalogState.js',
  '../src/pages/ChatSplit/useChatTurnRecovery.js',
]

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('chat split container keeps catalog and recovery boundaries below 300 lines', () => {
  for (const path of modulePaths) {
    const lineCount = source(path).split(/\r?\n/).length
    assert.ok(lineCount <= 300, `${path} has ${lineCount} lines`)
  }

  const entrySource = source(modulePaths[0])
  assert.match(entrySource, /import useChatCatalogState from/)
  assert.match(entrySource, /import useChatTurnRecovery from/)
  assert.match(source(modulePaths[1]), /useChatRuntimeCatalog/)
  assert.match(source(modulePaths[2]), /useServerTurnResume/)
})
