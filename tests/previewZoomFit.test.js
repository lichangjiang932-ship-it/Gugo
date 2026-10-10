import assert from 'node:assert/strict'
import test from 'node:test'
import { containScale, imageFitScale } from '../src/pages/ChatSplit/preview/previewZoomState.js'

const gutter = 32

test('containScale draws a fixed-size page whole in any frame — never cropped', () => {
  // A wide slide in a narrow, tall sidebar: width binds, yet the whole slide
  // stays inside the frame's height instead of running off the bottom.
  const wideSlide = { width: 960, height: 540 }
  const narrowTall = { width: 400, height: 700 }
  const shrink = containScale(wideSlide, narrowTall, gutter)
  assert.ok(wideSlide.width * shrink <= narrowTall.width - gutter, 'fits the width')
  assert.ok(wideSlide.height * shrink <= narrowTall.height - gutter, 'fits the height too')
  assert.ok(Math.abs(shrink - (narrowTall.width - gutter) / wideSlide.width) < 1e-9, 'the narrower side binds')

  // A tall slide in a wide, short sidebar: height binds, so a slide that used to
  // be cropped vertically is now seen whole.
  const tallSlide = { width: 540, height: 960 }
  const wideShort = { width: 800, height: 300 }
  const fitHeight = containScale(tallSlide, wideShort, gutter)
  assert.ok(tallSlide.width * fitHeight <= wideShort.width - gutter, 'fits the width')
  assert.ok(tallSlide.height * fitHeight <= wideShort.height - gutter, 'fits the height')
  assert.ok(Math.abs(fitHeight - (wideShort.height - gutter) / tallSlide.height) < 1e-9, 'the shorter side binds')
})

test('containScale enlarges a page smaller than its frame and survives an unmeasured frame', () => {
  // A slide in a big sidebar grows to fill it rather than sitting small in a
  // lake of whitespace — the vector drawing stays crisp when scaled up.
  const small = { width: 480, height: 270 }
  const big = { width: 900, height: 800 }
  assert.ok(containScale(small, big, gutter) > 1, 'a page smaller than its frame is enlarged')

  // Before the frame is measured (0×0) the scale must stay sane, not divide by
  // zero or collapse the page.
  assert.equal(containScale(small, { width: 0, height: 0 }), 1)
  assert.equal(containScale({ width: 0, height: 0 }, big), 1)
})

test('imageFitScale still never upscales a bitmap past its natural size', () => {
  // Photos blur when enlarged, so an image keeps the contain bound but is never
  // scaled above 1× the way a vector slide may be.
  const smallImage = { width: 100, height: 80 }
  const bigFrame = { width: 900, height: 800 }
  assert.equal(imageFitScale('fit', smallImage, bigFrame, 40), 1, 'a small image is drawn at its own size')

  // A tall image is bounded by height as well, so it is never drawn larger than
  // the frame can show.
  const tallImage = { width: 400, height: 1200 }
  const shortFrame = { width: 800, height: 300 }
  const scale = imageFitScale('fit', tallImage, shortFrame, 40)
  assert.ok(tallImage.height * scale <= shortFrame.height - 40, 'the whole image fits vertically')
})
