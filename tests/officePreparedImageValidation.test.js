import assert from 'node:assert/strict'
import test from 'node:test'

import { validatePreparedOfficeImages } from '../server/services/officePreparedImageValidation.js'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWOQz38NQQxwFgBTqAjXImzcIAAAAABJRU5ErkJggg==',
  'base64',
)

function preparedImage(overrides = {}) {
  return {
    buffer: PNG_BYTES,
    extension: 'png',
    pixelWidth: 3,
    pixelHeight: 2,
    ...overrides,
  }
}

test('Office image validation caps aggregate pixels before cloning or decoding the batch', () => {
  assert.throws(
    () => validatePreparedOfficeImages([
      preparedImage({ pixelWidth: 10_000, pixelHeight: 6_000 }),
      preparedImage({ pixelWidth: 10_000, pixelHeight: 6_000 }),
      preparedImage({ pixelWidth: 10_000, pixelHeight: 6_000 }),
    ]),
    /160 million-pixel total limit/,
  )
})
