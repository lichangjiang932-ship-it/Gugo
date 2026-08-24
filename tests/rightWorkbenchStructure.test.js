import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const componentPaths = [
  '../src/pages/ChatSplit/RightWorkbench.jsx',
  '../src/pages/ChatSplit/rightWorkbench/RightWorkbenchFrame.jsx',
  '../src/pages/ChatSplit/rightWorkbench/RightWorkbenchContent.jsx',
]

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('right workbench components keep their natural boundaries below 300 lines', () => {
  for (const path of componentPaths) {
    const lineCount = source(path).split(/\r?\n/).length
    assert.ok(lineCount <= 300, `${path} has ${lineCount} lines`)
  }

  assert.match(source(componentPaths[0]), /import RightWorkbenchFrame from/)
  assert.match(source(componentPaths[0]), /import RightWorkbenchContent from/)
  assert.match(source(componentPaths[0]), /import \{ collectArtifacts \} from/)
})
