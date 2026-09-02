import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'

import { BUILTIN_ARTIFACT_TOOL_SPECS } from '../server/services/builtinArtifactToolSpecs.js'
import { buildXlsxArtifactBuffer } from '../server/services/xlsxArtifactFormat.js'
import { XLSX_LIMITS, snapshotXlsxSheets } from '../server/services/xlsxArtifactContract.js'
import { normalizeToolCalls, validateToolCall } from '../server/utils/toolCallHarness.js'
import { collectStaticModuleGraph } from './helpers/staticModuleGraph.js'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWOQz38NQQxwFgBTqAjXImzcIAAAAABJRU5ErkJggg==',
  'base64',
)
const JPEG_BYTES = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCbAVYGf//Z',
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

function jpegImage(overrides = {}) {
  return preparedImage({
    buffer: JPEG_BYTES,
    extension: 'jpg',
    pixelWidth: 4,
    pixelHeight: 3,
    ...overrides,
  })
}

function drawingAnchors(xml) {
  return [...xml.matchAll(/<xdr:oneCellAnchor>[\s\S]*?<\/xdr:oneCellAnchor>/g)]
    .map((match) => match[0])
}

async function loadPackage(options) {
  return JSZip.loadAsync(await buildXlsxArtifactBuffer(options))
}

async function packageContents(options) {
  const zip = await loadPackage(options)
  const files = Object.values(zip.files).filter((entry) => !entry.dir)
  return Promise.all(files
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => [entry.name, (await entry.async('nodebuffer')).toString('hex')]))
}

test('XLSX format leaf preserves scalar types, text identity, and formula-like strings', async () => {
  const zip = await loadPackage({
    sheets: [
      {
        name: 'A&B <2026>',
        rows: [
          ['code', 'amount', 'yes', 'no', 'formula', 'plus', 'at', 'note'],
          ['001234567890123456789', 12, true, false, '=1+1', '+SUM(A1:A2)', '@SUM(A1:A2)', 'x&<\u0001'],
          ['', null, 'tail'],
        ],
      },
      { name: 'Second', rows: [['value'], [-2.5]] },
    ],
  })

  for (const entry of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/_rels/workbook.xml.rels',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
  ]) assert.ok(zip.file(entry), entry)

  const workbook = await zip.file('xl/workbook.xml').async('string')
  assert.match(workbook, /name="A&amp;B &lt;2026&gt;"/)
  const firstSheet = await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.match(firstSheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">001234567890123456789<\/t>/)
  assert.match(firstSheet, /<c r="B2"><v>12<\/v><\/c>/)
  assert.match(firstSheet, /<c r="C2" t="b"><v>1<\/v><\/c>/)
  assert.match(firstSheet, /<c r="D2" t="b"><v>0<\/v><\/c>/)
  assert.match(firstSheet, /<c r="E2" t="inlineStr"><is><t xml:space="preserve">=1\+1<\/t>/)
  assert.match(firstSheet, /<c r="F2" t="inlineStr"><is><t xml:space="preserve">\+SUM\(A1:A2\)<\/t>/)
  assert.match(firstSheet, /<c r="G2" t="inlineStr"><is><t xml:space="preserve">@SUM\(A1:A2\)<\/t>/)
  assert.match(firstSheet, /<c r="H2" t="inlineStr"><is><t xml:space="preserve">x&amp;&lt;�<\/t>/)
  assert.match(firstSheet, /<row r="3"><c r="C3"/)
})

test('XLSX contract rejects non-finite and non-scalar cells with an exact path', async () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    await assert.rejects(
      () => buildXlsxArtifactBuffer({ sheets: [{ name: 'Data', rows: [[value]] }] }),
      /sheets\[0\]\.rows\[0\]\[0\] must be a finite number/,
    )
  }
  for (const value of [undefined, {}, []]) {
    await assert.rejects(
      () => buildXlsxArtifactBuffer({ sheets: [{ name: 'Data', rows: [[value]] }] }),
      /sheets\[0\]\.rows\[0\]\[0\] must be a string, finite number, boolean, or null/,
    )
  }
})

test('XLSX contract rejects ambiguous worksheet names and empty sheets without reindexing', async () => {
  await assert.rejects(
    () => buildXlsxArtifactBuffer({
      sheets: [{ name: 'Data', rows: [['one']] }, { name: 'data', rows: [['two']] }],
    }),
    /duplicates another worksheet name/,
  )
  await assert.rejects(
    () => buildXlsxArtifactBuffer({ sheets: [{ name: 'bad:name', rows: [['one']] }] }),
    /characters Excel does not allow/,
  )
  await assert.rejects(
    () => buildXlsxArtifactBuffer({
      sheets: [{ name: 'One', rows: [['one']] }, { name: 'Two', rows: [] }],
      preparedImages: [preparedImage({ targetIndex: 2 })],
    }),
    /sheets\[1\]\.rows must contain at least one row/,
  )
})

test('XLSX contract snapshots caller input and enforces generation budgets before ZIP work', () => {
  const source = [{ name: 'Data', rows: [['001']] }]
  const snapshot = snapshotXlsxSheets(source)
  source[0].name = 'Changed'
  source[0].rows[0][0] = '999'
  assert.deepEqual(snapshot, [{ name: 'Data', rows: [['001']] }])
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot[0].rows[0]), true)

  assert.throws(
    () => snapshotXlsxSheets([{ name: 'Data', rows: [['x'.repeat(XLSX_LIMITS.maxCellTextCharacters + 1)]] }]),
    /cannot exceed 32767 characters/,
  )
  assert.throws(
    () => snapshotXlsxSheets([{ name: 'Data', rows: [Array(XLSX_LIMITS.maxColumnsPerRow + 1).fill(null)] }]),
    /cannot exceed 16384 columns/,
  )
  assert.throws(
    () => snapshotXlsxSheets(Array.from(
      { length: XLSX_LIMITS.maxSheets + 1 },
      (_, index) => ({ name: `S${index + 1}`, rows: [[]] }),
    )),
    /cannot exceed 256 worksheets/,
  )
  assert.throws(
    () => snapshotXlsxSheets([{
      name: 'Data',
      rows: Array.from({ length: 17 }, () => Array(XLSX_LIMITS.maxColumnsPerRow).fill(null)),
    }]),
    /exceeds the 33554432-byte XML budget/,
  )
})

test('XLSX format leaf keeps workbook-global media ids and sheet-local relationship ids', async () => {
  const zip = await loadPackage({
    sheets: [
      { name: 'One', rows: [['one']] },
      { name: 'Two', rows: [['two']] },
      { name: 'Three', rows: [['three']] },
    ],
    preparedImages: [
      preparedImage({ targetIndex: 2, anchor: 'D2', alt: 'first' }),
      jpegImage({ targetIndex: 1, width: 3.5, height: 1.75, alt: 'second' }),
      preparedImage({ anchor: 'AA1', alt: 'third' }),
      preparedImage({ targetIndex: 1, alt: 'fourth' }),
    ],
  })

  assert.deepEqual(await zip.file('xl/media/image1.png').async('nodebuffer'), PNG_BYTES)
  assert.deepEqual(await zip.file('xl/media/image2.jpg').async('nodebuffer'), JPEG_BYTES)
  assert.deepEqual(await zip.file('xl/media/image3.png').async('nodebuffer'), PNG_BYTES)
  assert.deepEqual(await zip.file('xl/media/image4.png').async('nodebuffer'), PNG_BYTES)

  const firstRelationships = await zip.file('xl/drawings/_rels/drawing1.xml.rels').async('string')
  assert.match(firstRelationships, /Id="rId1"[^>]+Target="\.\.\/media\/image2\.jpg"/)
  assert.match(firstRelationships, /Id="rId2"[^>]+Target="\.\.\/media\/image4\.png"/)
  const secondRelationships = await zip.file('xl/drawings/_rels/drawing2.xml.rels').async('string')
  assert.match(secondRelationships, /Id="rId1"[^>]+Target="\.\.\/media\/image1\.png"/)
  const thirdRelationships = await zip.file('xl/drawings/_rels/drawing3.xml.rels').async('string')
  assert.match(thirdRelationships, /Id="rId1"[^>]+Target="\.\.\/media\/image3\.png"/)

  const firstDrawing = await zip.file('xl/drawings/drawing1.xml').async('string')
  const firstDrawingAnchors = drawingAnchors(firstDrawing)
  assert.equal(firstDrawingAnchors.length, 2)
  assert.match(firstDrawingAnchors[0], /<xdr:col>0<\/xdr:col>[\s\S]*<xdr:row>0<\/xdr:row>/)
  assert.match(firstDrawingAnchors[0], /<xdr:ext cx="3200400" cy="1600200"\/>/)
  assert.match(firstDrawingAnchors[0], /descr="second"[\s\S]*r:embed="rId1"/)
  assert.match(firstDrawingAnchors[1], /<xdr:col>0<\/xdr:col>[\s\S]*<xdr:row>18<\/xdr:row>/)
  assert.match(firstDrawingAnchors[1], /<xdr:ext cx="3200400" cy="2133600"\/>/)
  assert.match(firstDrawingAnchors[1], /descr="fourth"[\s\S]*r:embed="rId2"/)
  const secondDrawing = await zip.file('xl/drawings/drawing2.xml').async('string')
  const [secondDrawingAnchor] = drawingAnchors(secondDrawing)
  assert.match(secondDrawingAnchor, /<xdr:col>3<\/xdr:col>[\s\S]*<xdr:row>1<\/xdr:row>/)
  assert.match(secondDrawingAnchor, /descr="first"[\s\S]*r:embed="rId1"/)
  const thirdDrawing = await zip.file('xl/drawings/drawing3.xml').async('string')
  const [thirdDrawingAnchor] = drawingAnchors(thirdDrawing)
  assert.match(thirdDrawingAnchor, /<xdr:col>26<\/xdr:col>[\s\S]*<xdr:row>0<\/xdr:row>/)
  assert.match(thirdDrawingAnchor, /descr="third"[\s\S]*r:embed="rId1"/)
})

test('XLSX image anchors accept the Excel edge and reject syntax or worksheet overflow', async () => {
  const sheets = [{ name: 'Data', rows: [['value']] }]
  const zip = await loadPackage({ sheets, preparedImages: [preparedImage({ anchor: 'XFD1048576' })] })
  const drawing = await zip.file('xl/drawings/drawing1.xml').async('string')
  assert.match(drawing, /<xdr:col>16383<\/xdr:col>[\s\S]*<xdr:row>1048575<\/xdr:row>/)

  for (const anchor of ['invalid', 'XFE1', 'A1048577']) {
    await assert.rejects(
      () => buildXlsxArtifactBuffer({ sheets, preparedImages: [preparedImage({ anchor })] }),
      /anchor (?:must be a valid Excel cell reference|exceeds Excel worksheet bounds)/,
    )
  }
})

test('XLSX format leaf rejects invalid explicit drawing sizes instead of silently using defaults', async () => {
  const sheets = [{ name: 'Data', rows: [['value']] }]
  for (const [property, value] of [
    ['width', 0],
    ['width', -1],
    ['width', Infinity],
    ['height', '2'],
  ]) {
    await assert.rejects(
      () => buildXlsxArtifactBuffer({
        sheets,
        preparedImages: [preparedImage({ [property]: value })],
      }),
      new RegExp(`preparedImages\\[0\\]\\.${property} must be a positive finite number`),
    )
  }
})

test('create_xlsx schema rejects empty rows, objects, oversized cells, and non-positive image sizes', () => {
  const spec = BUILTIN_ARTIFACT_TOOL_SPECS.create_xlsx
  for (const args of [
    { title: 'Book', sheets: [{ name: 'Data', rows: [] }] },
    { title: 'Book', sheets: [{ name: 'Data', rows: [[{ nested: true }]] }] },
    { title: 'Book', sheets: [{ name: 'Data', rows: [['x'.repeat(XLSX_LIMITS.maxCellTextCharacters + 1)]] }] },
    {
      title: 'Book',
      sheets: [{ name: 'Data', rows: [['x']] }],
      images: [{ path: 'image.png', width: 0 }],
    },
  ]) {
    const [call] = normalizeToolCalls([{ name: 'create_xlsx', arguments: JSON.stringify(args) }])
    assert.equal(validateToolCall(call, [spec]).code, 'tool_arguments_validation_failed')
  }
  const [valid] = normalizeToolCalls([{
    name: 'create_xlsx',
    arguments: JSON.stringify({
      title: 'Book',
      sheets: [{ name: 'Data', rows: [['001', 1, true, null]] }],
    }),
  }])
  assert.equal(validateToolCall(valid, [spec]), null)
})

test('XLSX format leaf preserves sparse drawing numbering by worksheet index', async () => {
  const zip = await loadPackage({
    sheets: [
      { name: 'One', rows: [['one']] },
      { name: 'Two', rows: [['two']] },
      { name: 'Three', rows: [['three']] },
    ],
    preparedImages: [preparedImage({ targetIndex: 2 })],
  })

  assert.equal(zip.file('xl/drawings/drawing1.xml'), null)
  assert.ok(zip.file('xl/drawings/drawing2.xml'))
  assert.equal(zip.file('xl/drawings/drawing3.xml'), null)
  const contentTypes = await zip.file('[Content_Types].xml').async('string')
  assert.match(contentTypes, /PartName="\/xl\/drawings\/drawing2\.xml"/)
  assert.doesNotMatch(contentTypes, /PartName="\/xl\/drawings\/drawing1\.xml"/)
  const sheetRelationship = await zip.file('xl/worksheets/_rels/sheet2.xml.rels').async('string')
  assert.match(sheetRelationship, /Target="\.\.\/drawings\/drawing2\.xml"/)
})

test('XLSX format leaf validates prepared image metadata and snapshots image bytes', async () => {
  const mutable = Buffer.from(PNG_BYTES)
  const pending = buildXlsxArtifactBuffer({
    sheets: [{ name: 'Data', rows: [['value']] }],
    preparedImages: [preparedImage({ buffer: mutable })],
  })
  mutable.fill(0)
  const zip = await JSZip.loadAsync(await pending)
  assert.deepEqual(await zip.file('xl/media/image1.png').async('nodebuffer'), PNG_BYTES)

  const sheets = [{ name: 'Data', rows: [['value']] }]
  await assert.rejects(
    () => buildXlsxArtifactBuffer({ sheets, preparedImages: [preparedImage({ extension: 'png/../xml' })] }),
    /extension must be png or jpg/,
  )
  await assert.rejects(
    () => buildXlsxArtifactBuffer({ sheets, preparedImages: [preparedImage({ buffer: 'not-bytes' })] }),
    /buffer must be a non-empty Buffer/,
  )
  await assert.rejects(
    () => buildXlsxArtifactBuffer({ sheets, preparedImages: [preparedImage({ pixelWidth: 0 })] }),
    /invalid pixel dimensions/,
  )
  await assert.rejects(
    () => buildXlsxArtifactBuffer({ sheets, preparedImages: [preparedImage({ targetIndex: 2 })] }),
    /target_index exceeds the 1-sheet workbook/,
  )
})

test('XLSX format leaf rejects disguised, truncated, mismatched, and falsely-sized image buffers', async () => {
  const sheets = [{ name: 'Data', rows: [['value']] }]
  await assert.rejects(
    () => buildXlsxArtifactBuffer({ sheets, preparedImages: [preparedImage({ buffer: Buffer.from('not an image') })] }),
    /valid PNG signature/,
  )
  await assert.rejects(
    () => buildXlsxArtifactBuffer({ sheets, preparedImages: [preparedImage({ buffer: PNG_BYTES.subarray(0, -5) })] }),
    /(?:truncated PNG chunk|complete PNG image structure)/,
  )
  const corruptPng = Buffer.from(PNG_BYTES)
  corruptPng[corruptPng.length - 1] ^= 0xff
  await assert.rejects(
    () => buildXlsxArtifactBuffer({ sheets, preparedImages: [preparedImage({ buffer: corruptPng })] }),
    /invalid CRC/,
  )
  await assert.rejects(
    () => buildXlsxArtifactBuffer({ sheets, preparedImages: [preparedImage({ extension: 'jpg' })] }),
    /valid JPEG signature/,
  )
  await assert.rejects(
    () => buildXlsxArtifactBuffer({ sheets, preparedImages: [preparedImage({ pixelWidth: 4 })] }),
    /declared pixel dimensions 4x2 do not match the 3x2 PNG image/,
  )
  await assert.rejects(
    () => buildXlsxArtifactBuffer({
      sheets,
      preparedImages: [jpegImage({ buffer: JPEG_BYTES.subarray(0, -2) })],
    }),
    /JPEG end marker/,
  )
})

test('XLSX format leaf has stable decompressed package content for identical inputs', async () => {
  const options = {
    sheets: [{ name: 'Data', rows: [['name', 'value'], ['alpha', 1]] }],
    preparedImages: [preparedImage({ anchor: 'B2' })],
  }
  assert.deepEqual(await packageContents(options), await packageContents(options))
})

test('XLSX format leaf depends only on approved pure leaves and JSZip', () => {
  const entry = fileURLToPath(new URL('../server/services/xlsxArtifactFormat.js', import.meta.url))
  const graph = collectStaticModuleGraph(entry)
  const allowedInternalFiles = new Set([
    entry,
    fileURLToPath(new URL('../server/services/officeImageLayout.js', import.meta.url)),
    fileURLToPath(new URL('../server/services/officePreparedImageValidation.js', import.meta.url)),
    fileURLToPath(new URL('../server/services/xlsxArtifactContract.js', import.meta.url)),
    fileURLToPath(new URL('../src/lib/pptCore.js', import.meta.url)),
  ].map((file) => path.resolve(file)))

  assert.deepEqual(graph.unresolvedLoads, [], 'computed module loads must be statically reviewable')
  assert.deepEqual(graph.unresolvedLocalModules, [], 'all relative dependencies must resolve')
  assert.deepEqual(
    [...graph.files].filter((file) => !allowedInternalFiles.has(path.resolve(file))),
    [],
    'new internal dependencies require an explicit leaf-boundary review',
  )
  assert.deepEqual(
    graph.externalLoads
      .filter(({ specifier }) => specifier !== 'jszip')
      .map(({ file, kind, line, specifier }) => ({
        file: path.relative(path.dirname(entry), file).replaceAll('\\', '/'),
        kind,
        line,
        specifier,
      })),
    [],
    'the format leaf may use JSZip but no host, storage, delivery, or native IO package',
  )
})

test('artifact host delegates XLSX package construction to the format leaf', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../server/services/artifactGen.js', import.meta.url)),
    'utf8',
  )
  assert.match(source, /import \{ buildXlsxArtifactBuffer \} from '\.\/xlsxArtifactFormat\.js'/)
  assert.match(
    source,
    /await buildXlsxArtifactBuffer\(\{\s*sheets:\s*validSheets,\s*preparedImages:\s*officeImages,?\s*\}\)/,
  )
  assert.doesNotMatch(source, /function (?:buildSheetXml|buildXlsxDrawingXml|xlsxAnchorCell)\b/)
  assert.doesNotMatch(source, /spreadsheetDrawing|xl\/worksheets/)
})
