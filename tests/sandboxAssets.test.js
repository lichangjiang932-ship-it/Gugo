import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { create as createFont } from 'fontkit'
import { WEB_RELEASE_ENTRIES } from '../scripts/release/package-web.mjs'

const require = createRequire(import.meta.url)

const ASSETS = {
  'react.umd.js': null,
  'react-dom.umd.js': null,
  'babel.standalone.js': null,
  'tailwind.js': null,
  'mermaid.min.js': '616a109f19cd186842e11d45b35ac07456b3a75513310f6ea075351aa430b1e2',
  'chart.umd.min.js': 'd2af8974e95271638772e9e9524db5b9a6f58d6ec2d5d781400447b4a31c681e',
}

const sandboxDir = path.resolve(process.cwd(), 'public/sandbox')

test('vendored minified sandbox assets disable Git text normalization', () => {
  const attributes = fs.readFileSync(path.resolve(process.cwd(), '.gitattributes'), 'utf8')
  const sandboxAttributes = attributes
    .split(/\r?\n/u)
    .find((line) => line.trim().startsWith('public/sandbox/*.min.js '))
  assert.equal(typeof sandboxAttributes, 'string')
  assert.match(sandboxAttributes, /(?:^|\s)-text(?:\s|$)/u)
})

test('the pinned UI font exports local variable WOFF2 subsets covering 400–700 including 650', () => {
  const manifest = JSON.parse(fs.readFileSync(require.resolve('@fontsource-variable/noto-sans-sc/package.json'), 'utf8'))
  const project = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const dependency = '@fontsource-variable/noto-sans-sc'
  assert.equal(project.dependencies[dependency], '5.3.1')
  assert.equal(lock.packages[''].dependencies[dependency], '5.3.1')
  assert.equal(lock.packages[`node_modules/${dependency}`].version, '5.3.1')
  assert.equal(manifest.version, '5.3.1')
  assert.equal(manifest.license, 'OFL-1.1')
  const cssPath = require.resolve(dependency)
  const css = fs.readFileSync(cssPath, 'utf8')
  const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/gu)].map(([, body]) => body)
  assert.ok(faces.length > 1, 'CJK is shipped as unicode-range subsets, not one PDF font')
  assert.doesNotMatch(css, /https?:|\.ttf\b/u)
  for (const face of faces) {
    assert.match(face, /font-family:\s*'Noto Sans SC Variable'/u)
    assert.match(face, /font-display:\s*swap/u)
    assert.match(face, /unicode-range:\s*U\+/u)
    const range = face.match(/font-weight:\s*(\d+)\s+(\d+)/u)?.slice(1).map(Number)
    assert.ok(range?.[0] <= 400 && range[1] >= 700, '400, 500, 600, 650 and 700 use the variable weight axis')
    const relative = face.match(/url\(\.\/(files\/[^)]+\.woff2)\)/u)?.[1]
    assert.ok(relative, 'every face references a package-local WOFF2')
    const exported = require.resolve(`${dependency}/${relative}`)
    assert.equal(exported, path.join(path.dirname(cssPath), relative))
    const bytes = fs.readFileSync(exported)
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'wOF2')
    const font = createFont(bytes)
    assert.ok(font.variationAxes.wght.min <= 400 && font.variationAxes.wght.max >= 700)
    assert.ok(font.getVariation({ wght: 650 }))
  }
})

test('the complete upstream UI font license is a public asset covered by existing Web and desktop release entries', async () => {
  const upstream = fs.readFileSync(require.resolve('@fontsource-variable/noto-sans-sc/LICENSE'))
  const shipped = fs.readFileSync(new URL('../public/licenses/NotoSansSC-OFL-1.1.txt', import.meta.url))
  assert.deepEqual(shipped, upstream, 'redistribute the complete, unmodified package license')
  assert.match(shipped.toString('utf8'), /Google Inc\.[\s\S]*SIL OPEN FONT LICENSE Version 1\.1[\s\S]*PERMISSION & CONDITIONS[\s\S]*TERMINATION[\s\S]*DISCLAIMER[\s\S]*OTHER DEALINGS IN THE FONT SOFTWARE\./u)
  const { resolveConfig } = await import('vite')
  const previousDotenv = process.env.GUGO_LOAD_DOTENV
  let config
  try {
    process.env.GUGO_LOAD_DOTENV = '0'
    config = await resolveConfig({ configLoader: 'native', envDir: false }, 'build')
  } finally {
    if (previousDotenv === undefined) delete process.env.GUGO_LOAD_DOTENV
    else process.env.GUGO_LOAD_DOTENV = previousDotenv
  }
  assert.equal(config.envDir, false, 'Vite must not auto-load real dotenv files during this static config check')
  assert.equal(path.resolve(config.publicDir), path.resolve('public'))
  assert.equal(config.build.copyPublicDir, true, 'Vite copies public/licenses into dist/licenses')
  assert.ok(WEB_RELEASE_ENTRIES.includes('dist'))
  const desktop = fs.readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(desktop, /^\s+- dist\/\*\*\/\*\s*$/mu)
  const notices = fs.readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
  assert.match(notices, /@fontsource-variable\/noto-sans-sc@5\.3\.1/u)
  assert.match(notices, /public\/licenses\/NotoSansSC-OFL-1\.1\.txt/u)
})

for (const [file, expectedSha256] of Object.entries(ASSETS)) {
  test(`public/sandbox/${file} exists and is non-trivial`, () => {
    const full = path.join(sandboxDir, file)
    const stat = fs.statSync(full)
    assert.ok(stat.isFile(), `${file} should be a regular file`)
    assert.ok(stat.size > 10 * 1024, `${file} should be >10KB, got ${stat.size}`)
    if (expectedSha256) {
      const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      assert.equal(actualSha256, expectedSha256, `${file} should match its reviewed upstream asset`)
    }
  })
}
