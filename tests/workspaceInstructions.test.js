import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { clearWorkspaceInstructionsCache, readWorkspaceInstructions } from '../server/services/workspaceInstructions.js'

test('workspace instructions are opt-in with file access and prefer AGENTS.md', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-instructions-'))
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'claude rule')
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'agent rule')
    assert.equal(readWorkspaceInstructions({ env: { WORKSPACE_ROOT: root } }), null)
    const result = readWorkspaceInstructions({ env: { WORKSPACE_ROOT: root, WORKSPACE_FS_ENABLED: '1' } })
    assert.match(result.text, /Source: AGENTS\.md/)
    assert.match(result.text, /agent rule/)
    assert.doesNotMatch(result.text, /claude rule/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    clearWorkspaceInstructionsCache()
  }
})

test('workspace instruction cache invalidates when the file changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-instructions-'))
  const filepath = path.join(root, 'AGENTS.md')
  try {
    fs.writeFileSync(filepath, 'first instructions')
    const env = { WORKSPACE_ROOT: root, WORKSPACE_FS_ENABLED: '1' }
    assert.match(readWorkspaceInstructions({ env }).text, /first instructions/)
    fs.writeFileSync(filepath, 'second instructions with different size')
    assert.match(readWorkspaceInstructions({ env }).text, /second instructions/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    clearWorkspaceInstructionsCache()
  }
})
