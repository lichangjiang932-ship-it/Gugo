import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getDesktopTerminalHost,
  isDesktopTerminalAvailable,
} from '../../src/lib/desktopTerminalClient.js'

function fullBridge() {
  return {
    start: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  }
}

function withWindow(value, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value })
  try {
    return run()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete globalThis.window
  }
}

test('a bridge is only accepted when it can do everything the panel needs', () => {
  withWindow(undefined, () => {
    assert.equal(getDesktopTerminalHost(), null)
    assert.equal(isDesktopTerminalAvailable(), false)
  })

  withWindow({}, () => assert.equal(isDesktopTerminalAvailable(), false))
  withWindow({ gugoDesktop: {} }, () => assert.equal(isDesktopTerminalAvailable(), false))

  const bridge = fullBridge()
  withWindow({ gugoDesktop: { terminal: bridge } }, () => {
    assert.equal(getDesktopTerminalHost(), bridge)
    assert.equal(isDesktopTerminalAvailable(), true)
  })

  // A half-built bridge (an older app version) must fall back to the console
  // rather than throw somewhere inside the panel.
  const partial = fullBridge()
  delete partial.onExit
  withWindow({ gugoDesktop: { terminal: partial } }, () => {
    assert.equal(getDesktopTerminalHost(), null)
    assert.equal(isDesktopTerminalAvailable(), false)
  })
})
