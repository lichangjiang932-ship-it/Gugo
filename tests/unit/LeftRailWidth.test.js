import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  adaptiveRailWidth,
  clampRailWidth,
  MAX_RAIL_WIDTH,
  MIN_RAIL_WIDTH,
  railMaxWidth,
} from '../../src/components/leftRail/useLeftRailWidth.js'

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')

test('the rail keeps a width it chooses itself until the reader chooses one', () => {
  // The width it picks for itself stays inside the band it always had, at any
  // viewport — a wide window does not turn it into a second conversation column.
  assert.equal(adaptiveRailWidth(1400), 280)
  assert.equal(adaptiveRailWidth(2000), 320)
  assert.equal(adaptiveRailWidth(600), 280)

  // A reader's width is honoured, and clamped to what the conversation can spare.
  assert.equal(clampRailWidth(360, 1400), 360)
  assert.equal(clampRailWidth(10, 1400), MIN_RAIL_WIDTH)
  assert.equal(clampRailWidth(9999, 1400), MAX_RAIL_WIDTH)
  assert.equal(railMaxWidth(1400), MAX_RAIL_WIDTH)
  assert.equal(railMaxWidth(1000), MAX_RAIL_WIDTH, 'a roomy window still caps at MAX')
  // A narrow window takes room back from the rail first, and never past its
  // floor: the rail has to stay usable even when there is nothing left to give.
  assert.equal(railMaxWidth(700), 300)
  assert.equal(clampRailWidth(480, 700), 300)
  assert.equal(clampRailWidth(480, 400), MIN_RAIL_WIDTH)
})

test('the rail drags from inside its own box, not from an edge it does not own', () => {
  const rail = read('../../src/components/LeftRail.jsx')
  // The region next door lost its drag to exactly this: a handle hung outside a
  // box that clips its overflow is cut in half, and the sliver that survives is
  // not something anyone can grab. The rail's handle sits inside its right edge.
  assert.match(rail, /data-testid="left-rail-resize-handle"/)
  assert.match(rail, /absolute inset-y-0 right-0 z-30 w-2 cursor-col-resize/)
  assert.doesNotMatch(rail, /-right-1/, 'no resize handle hangs outside the rail')
  // Collapsed and the narrow-viewport overlay keep their own widths: one is a
  // strip, the other is a dialog over the conversation.
  assert.match(rail, /const resizableRail = !collapsed && !narrowViewport/)
  // The transition would make the edge chase the pointer instead of tracking it.
  assert.match(rail, /rail\.resizing \? 'transition-none' : 'transition-\[width\] duration-200'/)
})
