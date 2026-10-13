import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHAT_AREA_SELECTOR,
  DEFAULT_REGION_WIDTH,
  MAX_REGION_WIDTH,
  MIN_CHAT_WIDTH,
  MIN_REGION_WIDTH,
  clampRegionWidth,
  measureChatAreaWidth,
  regionMaxWidth,
} from '../../src/lib/chatLayoutBudget.js'
import {
  MAX_RAIL_WIDTH,
  MIN_RAIL_WIDTH,
  clampRailWidth,
  railMaxWidth,
} from '../../src/components/leftRail/useLeftRailWidth.js'

test('the region spends only the room the conversation is not using', () => {
  // The reported case: a 1024px window with a 280px rail leaves 744px to the
  // right of the rail. The region may take 344 of that and no more, which leaves
  // the conversation its full 400 — where reserving from the window instead
  // allowed 480 and left the conversation 264.
  const chatArea = 1024 - 280
  assert.equal(chatArea, 744)
  assert.equal(regionMaxWidth(chatArea), 344)
  assert.equal(clampRegionWidth(DEFAULT_REGION_WIDTH, chatArea), 344)
  assert.equal(chatArea - clampRegionWidth(DEFAULT_REGION_WIDTH, chatArea), MIN_CHAT_WIDTH)
})

test('measuring the container is what fixes it — the arithmetic is the same either way', () => {
  // What the region hook now does: measure what is left, then clamp by that.
  const drawn = clampRegionWidth(DEFAULT_REGION_WIDTH, 1024 - 280)
  assert.equal(1024 - 280 - drawn, MIN_CHAT_WIDTH)
  // Reserving the same 400 from the window instead — the reported bug — leaves
  // the conversation short by exactly the rail's width. Same function, same
  // preference; the only difference is what got passed in, which is why the
  // guard for this lives on the call site rather than in here.
  const buggy = clampRegionWidth(DEFAULT_REGION_WIDTH, 1024)
  assert.equal(buggy, 480)
  assert.equal(1024 - 280 - buggy, 264)
})

test('the region never shrinks below a readable pane', () => {
  assert.equal(regionMaxWidth(400), MIN_REGION_WIDTH)
  assert.equal(regionMaxWidth(0), MIN_REGION_WIDTH)
  assert.equal(clampRegionWidth(2000, 5000), MAX_REGION_WIDTH)
  assert.equal(clampRegionWidth(10, 2000), MIN_REGION_WIDTH)
  assert.equal(clampRegionWidth(Number.NaN, 2000), DEFAULT_REGION_WIDTH)
})

test('the rail reserves the region too, but only while the region is drawn', () => {
  // Closed, the rail may spend everything above the conversation's floor.
  assert.equal(railMaxWidth(1024), MAX_RAIL_WIDTH)
  assert.equal(clampRailWidth(480, 1024), MAX_RAIL_WIDTH)
  // Open, it gives the region's floor back as well: 1024 − 400 − 320.
  assert.equal(railMaxWidth(1024, { regionOpen: true }), 304)
  assert.equal(clampRailWidth(480, 1024, { regionOpen: true }), 304)
  // Nothing pushes either side below its own floor, however small the window —
  // the chat column absorbs the deficit rather than a panel collapsing.
  assert.equal(railMaxWidth(200, { regionOpen: true }), MIN_RAIL_WIDTH)
})

test('the chat area is measured from the column\'s container, falling back to the window', () => {
  assert.equal(CHAT_AREA_SELECTOR, '[data-chat-main-area]')
  const savedWindow = globalThis.window
  const savedDocument = globalThis.document
  try {
    globalThis.window = { innerWidth: 1600 }
    // No container to measure (server render, or before mount): the window
    // stands in, because jsdom has no layout and the value is needed on the
    // first render.
    delete globalThis.document
    assert.equal(measureChatAreaWidth(), 1600)
    // A container that is laid out wins over the window.
    globalThis.document = {
      querySelector: (selector) => (selector === CHAT_AREA_SELECTOR
        ? { getBoundingClientRect: () => ({ width: 744 }), clientWidth: 0 }
        : null),
    }
    assert.equal(measureChatAreaWidth(), 744)
    // And one that has not been laid out yet falls back rather than reporting
    // zero, which would collapse the region on the first frame.
    globalThis.document = {
      querySelector: () => ({ getBoundingClientRect: () => ({ width: 0 }), clientWidth: 0 }),
    }
    assert.equal(measureChatAreaWidth(), 1600)
  } finally {
    if (savedWindow === undefined) delete globalThis.window
    else globalThis.window = savedWindow
    if (savedDocument === undefined) delete globalThis.document
    else globalThis.document = savedDocument
  }
})
