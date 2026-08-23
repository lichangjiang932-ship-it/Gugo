import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('Web and Headless lifecycle roots retain the selected Loop binding identity', () => {
  const webSource = fs.readFileSync(new URL('../server/appServer.js', import.meta.url), 'utf8')
  const headlessSource = fs.readFileSync(
    new URL('../server/adapters/headlessTurnHost.js', import.meta.url),
    'utf8',
  )

  assert.match(
    webSource,
    /const loopLifecycleInput = toolLoopAdapter\s*\? \{ toolLoopAdapter \}\s*:\s*\{ toolLoopBinding: selectedToolLoopBinding\(capabilitySnapshot\) \}/,
  )
  assert.match(
    headlessSource,
    /const explicitToolLoopAdapter = options\.toolLoopAdapter \|\| dependencies\.toolLoopAdapter/,
  )
  assert.match(
    headlessSource,
    /const loopLifecycleInput = explicitToolLoopAdapter\s*\? \{ toolLoopAdapter: explicitToolLoopAdapter \}\s*:\s*\{ toolLoopBinding: selectedToolLoopBinding\(snapshot\) \}/,
  )
  assert.doesNotMatch(webSource, /\bselectedToolLoopAdapter\b/)
  assert.doesNotMatch(headlessSource, /\bselectedToolLoopAdapter\b/)
})
