import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeVerifiedLocalFilePath,
  verifiedLocalFileIdentity,
} from '../src/lib/verifiedLocalFileIdentity.js'

test('verified local file identity normalizes POSIX absolute paths without folding case', () => {
  assert.equal(
    normalizeVerifiedLocalFilePath('/Users/Alice/output/cache/.././Gallery.html'),
    '/Users/Alice/output/Gallery.html',
  )
  assert.notEqual(
    verifiedLocalFileIdentity({ path: '/Users/Alice/output/Gallery.html' }),
    verifiedLocalFileIdentity({ path: '/users/alice/output/gallery.html' }),
  )
})

test('verified local file identity recognizes POSIX file URLs and later absolute path fields', () => {
  assert.equal(
    normalizeVerifiedLocalFilePath('file:///Users/Alice/My%20Report.html'),
    '/Users/Alice/My Report.html',
  )
  assert.equal(
    verifiedLocalFileIdentity({
      path: 'relative/report.html',
      fullPath: '/Users/Alice/report.html',
      id: 'receipt-after-relative-path',
    }),
    'path:/Users/Alice/report.html',
  )
})

test('verified local file identity keeps Windows drive and UNC paths case-insensitive', () => {
  assert.equal(
    normalizeVerifiedLocalFilePath('D:\\Output\\Gallery.HTML'),
    normalizeVerifiedLocalFilePath('d:/output/cache/../gallery.html'),
  )
  assert.equal(
    normalizeVerifiedLocalFilePath('\\\\Server\\Share\\Gallery.HTML'),
    normalizeVerifiedLocalFilePath('//server/share/cache/../gallery.html'),
  )
})

test('verified local file identity never merges same-named files from different directories', () => {
  assert.notEqual(
    verifiedLocalFileIdentity({ path: '/tmp/one/report.html' }),
    verifiedLocalFileIdentity({ path: '/tmp/two/report.html' }),
  )
})

test('verified local file identity falls back to receipt then URL when no absolute path exists', () => {
  assert.equal(
    verifiedLocalFileIdentity({ id: 'receipt-1', path: 'relative/report.html', url: '/first' }),
    'receipt:receipt-1',
  )
  assert.equal(
    verifiedLocalFileIdentity({ path: 'relative/report.html', url: '/api/local-files/verified/url-only' }),
    'url:/api/local-files/verified/url-only',
  )
  assert.equal(verifiedLocalFileIdentity({ path: 'relative/report.html' }), '')
})
