import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'

import {
  BATCH_FILE_TOOL_SPECS,
  dispatchBatchFileTool,
} from '../server/adapters/batchFileTools.js'

let workspace
const savedEnv = {
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
  BATCH_FILE_MAX_ENTRIES: process.env.BATCH_FILE_MAX_ENTRIES,
  BATCH_FILE_MAX_ZIP_METADATA_BYTES: process.env.BATCH_FILE_MAX_ZIP_METADATA_BYTES,
  BATCH_FILE_MAX_EXTRACTED_BYTES: process.env.BATCH_FILE_MAX_EXTRACTED_BYTES,
  BATCH_FILE_MAX_COMPRESSION_RATIO: process.env.BATCH_FILE_MAX_COMPRESSION_RATIO,
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-file-tools-'))
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_FS_ENABLED = '1'
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
})

beforeEach(() => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
  delete process.env.BATCH_FILE_MAX_ENTRIES
  delete process.env.BATCH_FILE_MAX_ZIP_METADATA_BYTES
  delete process.env.BATCH_FILE_MAX_EXTRACTED_BYTES
  delete process.env.BATCH_FILE_MAX_COMPRESSION_RATIO
})

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* best effort */ }
})

function write(relativePath, value) {
  const target = path.join(workspace, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, value)
  return target
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function workspaceEntries() {
  const entries = []
  const visit = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, item.name)
      entries.push(path.relative(workspace, fullPath).replace(/\\/gu, '/'))
      if (item.isDirectory()) visit(fullPath)
    }
  }
  visit(workspace)
  return entries.sort()
}

function centralDirectoryOnlyZip(names) {
  const entries = names.map((name) => {
    const encoded = Buffer.from(name, 'utf8')
    const header = Buffer.alloc(46 + encoded.length)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE((3 << 8) | 20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(encoded.length, 28)
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    encoded.copy(header, 46)
    return header
  })
  const centralSize = entries.reduce((sum, entry) => sum + entry.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(0, 16)
  return Buffer.concat([...entries, end])
}

function patchDeclaredUncompressedSize(archive, declaredBytes) {
  const patched = Buffer.from(archive)
  let centralEntries = 0
  for (let offset = 0; offset <= patched.length - 46; offset += 1) {
    if (patched.readUInt32LE(offset) !== 0x02014b50) continue
    patched.writeUInt32LE(declaredBytes, offset + 24)
    centralEntries += 1
  }
  assert.equal(centralEntries, 1)
  return patched
}

const TEST_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    table[index] = value >>> 0
  }
  return table
})()

function testCrc32(value) {
  let crc = 0xffffffff
  for (const byte of value) crc = (crc >>> 8) ^ TEST_CRC_TABLE[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function rar4Header(body) {
  const header = Buffer.alloc(body.length + 2)
  header.writeUInt16LE(testCrc32(body) & 0xffff, 0)
  body.copy(header, 2)
  return header
}

// Minimal, standards-based RAR4 "store" writer used only by tests. Keeping the
// fixture as source makes every security-relevant header field reviewable.
function storedRar4(entries) {
  const main = Buffer.alloc(11)
  main.writeUInt8(0x73, 0)
  main.writeUInt16LE(13, 3)
  const blocks = [Buffer.from('526172211a0700', 'hex'), rar4Header(main)]
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '')
    const name = Buffer.from(entry.name, 'utf8')
    const body = Buffer.alloc(30 + name.length)
    body.writeUInt8(0x74, 0)
    body.writeUInt16LE(0x8000 | (entry.flags || 0), 1)
    body.writeUInt16LE(body.length + 2, 3)
    body.writeUInt32LE(data.length, 5)
    body.writeUInt32LE(entry.uncompressedSize ?? data.length, 9)
    body.writeUInt8(entry.hostOS ?? 2, 13)
    body.writeUInt32LE(testCrc32(data), 14)
    body.writeUInt8(20, 22)
    body.writeUInt8(0x30, 23)
    body.writeUInt16LE(name.length, 24)
    body.writeUInt32LE(entry.attributes ?? 0x20, 26)
    name.copy(body, 30)
    blocks.push(rar4Header(body), data)
  }
  const end = Buffer.alloc(5)
  end.writeUInt8(0x7b, 0)
  end.writeUInt16LE(0x4000, 1)
  end.writeUInt16LE(7, 3)
  blocks.push(rar4Header(end))
  return Buffer.concat(blocks)
}

test('exports structured batch file specs and rejects unknown tools', async () => {
  assert.deepEqual(BATCH_FILE_TOOL_SPECS.map((spec) => spec.function.name), [
    'archive_create',
    'archive_list',
    'archive_extract',
    'batch_rename',
    'file_hash_manifest',
  ])
  await assert.rejects(
    () => dispatchBatchFileTool('unknown_batch_tool', {}),
    (error) => error?.code === 'BATCH_FILE_TOOL_NOT_FOUND' && error?.statusCode === 404,
  )
})

test('archive_list reports validated central-directory metadata without writing files', async () => {
  write('list/source/readme.txt', 'hello list')
  write('list/source/nested/data.bin', Buffer.from([1, 2, 3, 4]))
  const created = await dispatchBatchFileTool('archive_create', {
    inputs: [{ path: 'list/source', archivePath: 'project' }],
    output: 'list/archive.zip',
  })
  const before = workspaceEntries()

  const listed = await dispatchBatchFileTool('archive_list', { input: 'list/archive.zip' })

  assert.equal(listed.ok, true)
  assert.equal(listed.entryCount, created.entryCount)
  assert.equal(listed.totalBytes, created.entries.reduce((sum, entry) => sum + entry.size, 0))
  assert.deepEqual(listed.entries.map((entry) => ({
    path: entry.path,
    directory: entry.directory,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    crc32: entry.crc32,
  })), created.entries.map((entry) => ({
    path: entry.path,
    directory: entry.type === 'directory',
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.size,
    crc32: entry.crc32,
  })))
  assert.deepEqual(listed.limitations, {
    zip64Supported: false,
    encryptedEntriesSupported: false,
    rarSupported: true,
    rarVolumesSupported: false,
  })
  assert.deepEqual(workspaceEntries(), before)
})

test('archive_create and archive_extract stream nested files larger than the old 5 MB limit', async () => {
  write('archive-source/readme.txt', 'hello archive')
  write('archive-source/nested/data.json', '{"ok":true}')
  const large = crypto.randomBytes(6 * 1024 * 1024)
  write('large-input.bin', large)

  const created = await dispatchBatchFileTool('archive_create', {
    inputs: [
      { path: 'archive-source', archivePath: 'project' },
      { path: 'large-input.bin', archivePath: 'payload/large.bin' },
    ],
    output: 'archives/bundle.zip',
  })

  assert.equal(created.ok, true)
  assert.equal(created.format, 'zip')
  assert.equal(created.path, 'archives/bundle.zip')
  assert.equal(created.scope, 'workspace')
  assert.deepEqual(created.changedPaths, ['archives/bundle.zip'])
  assert.ok(created.size > 5 * 1024 * 1024)
  assert.deepEqual(created.entries.map((entry) => entry.path), [
    'project/',
    'project/nested/',
    'project/nested/data.json',
    'project/readme.txt',
    'payload/large.bin',
  ])

  const extracted = await dispatchBatchFileTool('archive_extract', {
    input: 'archives/bundle.zip',
    outputDir: 'extracted',
  })
  assert.equal(extracted.ok, true)
  assert.equal(extracted.path, 'extracted')
  assert.equal(extracted.scope, 'workspace')
  assert.deepEqual(extracted.changedPaths, extracted.entries.map((entry) => entry.outputPath))
  assert.equal(extracted.entryCount, 5)
  assert.equal(fs.readFileSync(path.join(workspace, 'extracted/project/readme.txt'), 'utf8'), 'hello archive')
  assert.equal(fs.readFileSync(path.join(workspace, 'extracted/project/nested/data.json'), 'utf8'), '{"ok":true}')
  const extractedLarge = fs.readFileSync(path.join(workspace, 'extracted/payload/large.bin'))
  assert.equal(extractedLarge.byteLength, large.byteLength)
  assert.equal(sha256(extractedLarge), sha256(large))
})

test('archive outputs and extracted files never overwrite by default', async () => {
  write('overwrite/source.txt', 'new')
  await dispatchBatchFileTool('archive_create', {
    inputs: ['overwrite/source.txt'],
    output: 'overwrite/archive.zip',
  })

  await assert.rejects(
    () => dispatchBatchFileTool('archive_create', {
      inputs: ['overwrite/source.txt'],
      output: 'overwrite/archive.zip',
    }),
    (error) => error?.code === 'BATCH_FILE_OUTPUT_EXISTS' && error?.statusCode === 409,
  )

  write('overwrite/out/source.txt', 'keep')
  await assert.rejects(
    () => dispatchBatchFileTool('archive_extract', {
      input: 'overwrite/archive.zip',
      outputDir: 'overwrite/out',
    }),
    (error) => error?.code === 'BATCH_FILE_OUTPUT_EXISTS' && error?.statusCode === 409,
  )
  assert.equal(fs.readFileSync(path.join(workspace, 'overwrite/out/source.txt'), 'utf8'), 'keep')

  const replaced = await dispatchBatchFileTool('archive_extract', {
    input: 'overwrite/archive.zip',
    outputDir: 'overwrite/out',
    overwrite: true,
  })
  assert.equal(replaced.ok, true)
  assert.equal(fs.readFileSync(path.join(workspace, 'overwrite/out/source.txt'), 'utf8'), 'new')
})

test('archive_extract blocks a patched zip-slip path before writing anything', async () => {
  write('zip-slip/evil.txt', 'must stay contained')
  await dispatchBatchFileTool('archive_create', {
    inputs: [{ path: 'zip-slip/evil.txt', archivePath: 'aa/evil.txt' }],
    output: 'zip-slip/safe.zip',
  })
  const archive = fs.readFileSync(path.join(workspace, 'zip-slip/safe.zip'))
  const safeName = Buffer.from('aa/evil.txt')
  const unsafeName = Buffer.from('../evil.txt')
  let replacements = 0
  for (let offset = archive.indexOf(safeName); offset >= 0; offset = archive.indexOf(safeName, offset + safeName.length)) {
    unsafeName.copy(archive, offset)
    replacements += 1
  }
  assert.equal(replacements, 2)
  write('zip-slip/malicious.zip', archive)

  const beforeList = workspaceEntries()
  await assert.rejects(
    () => dispatchBatchFileTool('archive_list', { input: 'zip-slip/malicious.zip' }),
    (error) => error?.code === 'ARCHIVE_UNSAFE_PATH',
  )
  assert.deepEqual(workspaceEntries(), beforeList)

  await assert.rejects(
    () => dispatchBatchFileTool('archive_extract', {
      input: 'zip-slip/malicious.zip',
      outputDir: 'zip-slip/output',
    }),
    (error) => error?.code === 'ARCHIVE_UNSAFE_PATH',
  )
  assert.equal(fs.existsSync(path.join(workspace, 'zip-slip/output')), false)
  assert.equal(fs.existsSync(path.join(workspace, 'evil.txt')), false)
})

test('archive entry paths are validated before output creation', async () => {
  write('unsafe-source.txt', 'x')
  await assert.rejects(
    () => dispatchBatchFileTool('archive_create', {
      inputs: [{ path: 'unsafe-source.txt', archivePath: '../escaped.txt' }],
      output: 'unsafe-output.zip',
    }),
    (error) => error?.code === 'ARCHIVE_UNSAFE_PATH',
  )
  assert.equal(fs.existsSync(path.join(workspace, 'unsafe-output.zip')), false)
})

test('archive_list and archive_extract safely process a generated RAR4 archive', async () => {
  write('sample.rar', storedRar4([
    { name: 'docs/readme.txt', data: 'hello rar' },
    { name: '资料/数据.bin', data: Buffer.from([1, 2, 3, 4]) },
  ]))
  const before = workspaceEntries()
  const listed = await dispatchBatchFileTool('archive_list', { input: 'sample.rar' })
  assert.equal(listed.format, 'rar')
  assert.equal(listed.entryCount, 2)
  assert.deepEqual(listed.entries.map((entry) => entry.path), ['docs/readme.txt', '资料/数据.bin'])
  assert.equal(listed.limitations.rarSupported, true)
  assert.deepEqual(workspaceEntries(), before)

  const extracted = await dispatchBatchFileTool('archive_extract', {
    input: 'sample.rar',
    outputDir: 'rar-output',
  })
  assert.equal(extracted.format, 'rar')
  assert.equal(fs.readFileSync(path.join(workspace, 'rar-output/docs/readme.txt'), 'utf8'), 'hello rar')
  assert.deepEqual(fs.readFileSync(path.join(workspace, 'rar-output/资料/数据.bin')), Buffer.from([1, 2, 3, 4]))

  await assert.rejects(
    () => dispatchBatchFileTool('archive_create', {
      format: 'rar',
      inputs: ['sample.rar'],
      output: 'new.rar',
    }),
    (error) => error?.code === 'ARCHIVE_RAR_CREATE_UNSUPPORTED',
  )
})

test('RAR extraction scans a multi-entry archive once after one header preflight', async () => {
  const entries = Array.from({ length: 24 }, (_, index) => ({
    name: `many/item-${String(index).padStart(2, '0')}.txt`,
    data: `value-${index}`,
  }))
  const archivePath = write('rar-single-pass.rar', storedRar4(entries))
  const originalOpenSync = fs.openSync
  let archiveOpens = 0
  fs.openSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(archivePath)) archiveOpens += 1
    return originalOpenSync(target, ...rest)
  }
  try {
    const extracted = await dispatchBatchFileTool('archive_extract', {
      input: 'rar-single-pass.rar',
      outputDir: 'rar-single-pass-output',
    })
    assert.equal(extracted.entryCount, entries.length)
  } finally {
    fs.openSync = originalOpenSync
  }
  // One short magic sniff, one complete header preflight, one complete extract.
  // This remains constant as entry count grows.
  assert.equal(archiveOpens, 3)
  assert.equal(fs.readFileSync(path.join(workspace, 'rar-single-pass-output/many/item-23.txt'), 'utf8'), 'value-23')
})

test('RAR preflight rejects traversal, links, encryption, and configured limits before writing', async () => {
  write('rar-unsafe-path.rar', storedRar4([{ name: '../escaped.txt', data: 'escape' }]))
  await assert.rejects(
    () => dispatchBatchFileTool('archive_extract', { input: 'rar-unsafe-path.rar', outputDir: 'rar-unsafe-output' }),
    (error) => error?.code === 'ARCHIVE_UNSAFE_PATH',
  )
  assert.equal(fs.existsSync(path.join(workspace, 'rar-unsafe-output')), false)
  assert.equal(fs.existsSync(path.join(workspace, 'escaped.txt')), false)

  write('rar-link.rar', storedRar4([{
    name: 'link',
    data: 'target',
    hostOS: 3,
    attributes: 0o120777,
  }]))
  await assert.rejects(
    () => dispatchBatchFileTool('archive_list', { input: 'rar-link.rar' }),
    (error) => error?.code === 'BATCH_FILE_SYMLINK_UNSUPPORTED',
  )

  write('rar-encrypted.rar', storedRar4([{ name: 'secret.txt', data: 'secret', flags: 0x04 }]))
  await assert.rejects(
    () => dispatchBatchFileTool('archive_list', { input: 'rar-encrypted.rar' }),
    (error) => error?.code === 'ARCHIVE_ENCRYPTED_UNSUPPORTED',
  )

  write('rar-limits.rar', storedRar4([
    { name: 'a.txt', data: 'a' },
    { name: 'b.txt', data: 'b' },
  ]))
  process.env.BATCH_FILE_MAX_ENTRIES = '1'
  await assert.rejects(
    () => dispatchBatchFileTool('archive_list', { input: 'rar-limits.rar' }),
    (error) => error?.code === 'ARCHIVE_TOO_MANY_ENTRIES',
  )
})

test('RAR extraction stops an under-declared entry before publishing output', async () => {
  write('rar-under-declared.rar', storedRar4([{
    name: 'payload.bin',
    data: Buffer.alloc(64 * 1024, 0x5a),
    uncompressedSize: 1024,
  }]))
  await assert.rejects(
    () => dispatchBatchFileTool('archive_extract', {
      input: 'rar-under-declared.rar',
      outputDir: 'rar-under-declared-output',
    }),
    (error) => ['ARCHIVE_ENTRY_SIZE_LIMIT', 'ARCHIVE_ENTRY_EXTRACT_FAILED'].includes(error?.code)
      && [413, 422].includes(error?.statusCode)
      && error?.rollbackFailures?.length === 0
      && error?.recoveryPaths?.length === 0,
  )
  assert.equal(fs.existsSync(path.join(workspace, 'rar-under-declared-output')), false)
})

test('RAR extraction verifies the actual staged length before publication and cleans the stage', async () => {
  write('rar-actual-size.rar', storedRar4([{ name: 'payload.txt', data: 'verified' }]))
  const originalLstatSync = fs.lstatSync
  let stageRoot = null
  fs.lstatSync = (target, ...rest) => {
    const stat = originalLstatSync(target, ...rest)
    if (String(target).includes('gugo-rar-extract-') && String(target).endsWith('payload.txt')) {
      stageRoot = path.dirname(String(target))
      return new Proxy(stat, {
        get(object, property) {
          if (property === 'size') return object.size + 1
          const value = Reflect.get(object, property)
          return typeof value === 'function' ? value.bind(object) : value
        },
      })
    }
    return stat
  }
  try {
    await assert.rejects(
      () => dispatchBatchFileTool('archive_extract', {
        input: 'rar-actual-size.rar',
        outputDir: 'rar-actual-size-output',
      }),
      (error) => error?.code === 'ARCHIVE_INTEGRITY_FAILED'
        && error?.rollbackFailures?.length === 0
        && error?.recoveryPaths?.length === 0,
    )
  } finally {
    fs.lstatSync = originalLstatSync
  }
  assert.ok(stageRoot)
  assert.equal(fs.existsSync(stageRoot), false)
  assert.equal(fs.existsSync(path.join(workspace, 'rar-actual-size-output')), false)
})

test('RAR overwrite rolls the whole batch back when cancelled after first publication', async () => {
  write('rar-rollback.rar', storedRar4([
    { name: 'a.txt', data: 'new A' },
    { name: 'b.txt', data: 'new B' },
  ]))
  write('rar-rollback-output/a.txt', 'old A')
  write('rar-rollback-output/b.txt', 'old B')
  const controller = new AbortController()
  const originalLinkSync = fs.linkSync
  let publications = 0
  fs.linkSync = (...linkArgs) => {
    const result = originalLinkSync(...linkArgs)
    publications += 1
    if (publications === 1) controller.abort()
    return result
  }
  try {
    await assert.rejects(
      () => dispatchBatchFileTool('archive_extract', {
        input: 'rar-rollback.rar',
        outputDir: 'rar-rollback-output',
        overwrite: true,
      }, { signal: controller.signal }),
      (error) => error?.code === 'BATCH_FILE_CANCELLED'
        && error?.rollbackFailures?.length === 0
        && error?.recoveryPaths?.length === 0,
    )
  } finally {
    fs.linkSync = originalLinkSync
  }
  assert.equal(publications, 1)
  assert.equal(fs.readFileSync(path.join(workspace, 'rar-rollback-output/a.txt'), 'utf8'), 'old A')
  assert.equal(fs.readFileSync(path.join(workspace, 'rar-rollback-output/b.txt'), 'utf8'), 'old B')
})

test('batch_rename handles a three-file cycle without overwriting data', async () => {
  write('rename/a.txt', 'A')
  write('rename/b.txt', 'B')
  write('rename/c.txt', 'C')

  const result = await dispatchBatchFileTool('batch_rename', {
    operations: [
      { from: 'rename/a.txt', to: 'rename/b.txt' },
      { from: 'rename/b.txt', to: 'rename/c.txt' },
      { from: 'rename/c.txt', to: 'rename/a.txt' },
    ],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.changedPaths, [
    'rename/b.txt',
    'rename/c.txt',
    'rename/a.txt',
  ])
  assert.equal(fs.readFileSync(path.join(workspace, 'rename/a.txt'), 'utf8'), 'C')
  assert.equal(fs.readFileSync(path.join(workspace, 'rename/b.txt'), 'utf8'), 'A')
  assert.equal(fs.readFileSync(path.join(workspace, 'rename/c.txt'), 'utf8'), 'B')
})

test('batch_rename moves directories recursively and supports directory swaps', async () => {
  write('rename-directories/left/nested/a.txt', 'left')
  write('rename-directories/right/b.txt', 'right')

  const result = await dispatchBatchFileTool('batch_rename', {
    operations: [
      { from: 'rename-directories/left', to: 'rename-directories/right' },
      { from: 'rename-directories/right', to: 'rename-directories/left' },
    ],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.renamed.map((item) => ({ type: item.type, recursive: item.recursive })), [
    { type: 'directory', recursive: true },
    { type: 'directory', recursive: true },
  ])
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-directories/right/nested/a.txt'), 'utf8'), 'left')
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-directories/left/b.txt'), 'utf8'), 'right')
})

test('batch_rename rejects explicitly selecting a directory and its descendant', async () => {
  write('rename-nested/tree/child.txt', 'child')

  await assert.rejects(
    () => dispatchBatchFileTool('batch_rename', {
      operations: [
        { from: 'rename-nested/tree', to: 'rename-nested/moved' },
        { from: 'rename-nested/tree/child.txt', to: 'rename-nested/child.txt' },
      ],
    }),
    (error) => error?.code === 'BATCH_RENAME_NESTED_SOURCE' && error?.statusCode === 409,
  )
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-nested/tree/child.txt'), 'utf8'), 'child')
  assert.equal(fs.existsSync(path.join(workspace, 'rename-nested/moved')), false)
})

test('batch_rename detects a cross-set ancestor among thousands of mappings without quadratic scans', {
  timeout: 15_000,
}, async () => {
  const count = 3_000
  const operations = []
  for (let index = 0; index < count; index += 1) {
    const name = `item-${String(index).padStart(4, '0')}.txt`
    write(`rename-scale/sources/${name}`, String(index))
    operations.push({
      from: `rename-scale/sources/${name}`,
      to: `rename-scale/targets/${name}`,
    })
  }
  // The final destination is an ancestor of every source. A cross-set adjacent
  // comparison can miss this when unrelated destination keys sort in between.
  operations.at(-1).to = 'rename-scale/sources'

  await assert.rejects(
    () => dispatchBatchFileTool('batch_rename', { operations }),
    (error) => error?.code === 'BATCH_RENAME_SOURCE_DESTINATION_OVERLAP',
  )
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-scale/sources/item-0000.txt'), 'utf8'), '0')
})

test('batch_rename rejects an unrelated existing destination without moving sources', async () => {
  write('rename-block/source.txt', 'source')
  write('rename-block/target.txt', 'target')

  await assert.rejects(
    () => dispatchBatchFileTool('batch_rename', {
      operations: [{ from: 'rename-block/source.txt', to: 'rename-block/target.txt' }],
    }),
    (error) => error?.code === 'BATCH_FILE_OUTPUT_EXISTS',
  )
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-block/source.txt'), 'utf8'), 'source')
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-block/target.txt'), 'utf8'), 'target')

  const overwritten = await dispatchBatchFileTool('batch_rename', {
    operations: [{ from: 'rename-block/source.txt', to: 'rename-block/target.txt' }],
    overwrite: true,
  })
  assert.equal(overwritten.ok, true)
  assert.equal(fs.existsSync(path.join(workspace, 'rename-block/source.txt')), false)
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-block/target.txt'), 'utf8'), 'source')
})

test('batch_rename handles directory destination conflicts and recursive overwrite', async () => {
  write('rename-dir-conflict/source/new.txt', 'new')
  write('rename-dir-conflict/target/old.txt', 'old')

  await assert.rejects(
    () => dispatchBatchFileTool('batch_rename', {
      operations: [{ from: 'rename-dir-conflict/source', to: 'rename-dir-conflict/target' }],
    }),
    (error) => error?.code === 'BATCH_FILE_OUTPUT_EXISTS',
  )
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-dir-conflict/source/new.txt'), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-dir-conflict/target/old.txt'), 'utf8'), 'old')

  await dispatchBatchFileTool('batch_rename', {
    operations: [{ from: 'rename-dir-conflict/source', to: 'rename-dir-conflict/target' }],
    overwrite: true,
  })
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-dir-conflict/target/new.txt'), 'utf8'), 'new')
  assert.equal(fs.existsSync(path.join(workspace, 'rename-dir-conflict/target/old.txt')), false)
})

test('batch_rename rolls staged paths back when cancellation interrupts publication', async () => {
  write('rename-rollback/a.txt', 'A')
  write('rename-rollback/b.txt', 'B')
  let checks = 0
  const signal = {
    get aborted() {
      checks += 1
      return checks >= 3
    },
  }

  await assert.rejects(
    () => dispatchBatchFileTool('batch_rename', {
      operations: [
        { from: 'rename-rollback/a.txt', to: 'rename-rollback/new-a/a-renamed.txt' },
        { from: 'rename-rollback/b.txt', to: 'rename-rollback/new-b/b-renamed.txt' },
      ],
    }, { signal }),
    (error) => error?.code === 'BATCH_FILE_CANCELLED'
      && error?.statusCode === 499
      && error?.rollbackFailures?.length === 0
      && error?.recoveryPaths?.length === 0,
  )
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-rollback/a.txt'), 'utf8'), 'A')
  assert.equal(fs.readFileSync(path.join(workspace, 'rename-rollback/b.txt'), 'utf8'), 'B')
  assert.equal(fs.existsSync(path.join(workspace, 'rename-rollback/new-a')), false)
  assert.equal(fs.existsSync(path.join(workspace, 'rename-rollback/new-b')), false)
})

test('file_hash_manifest streams SHA-256 and groups exact duplicates', async () => {
  const duplicate = crypto.randomBytes(6 * 1024 * 1024)
  write('hash/a.bin', duplicate)
  write('hash/nested/b.bin', duplicate)
  write('hash/unique.txt', 'unique')

  const result = await dispatchBatchFileTool('file_hash_manifest', {
    inputs: ['hash'],
  })

  assert.equal(result.ok, true)
  assert.equal(result.algorithm, 'sha256')
  assert.equal(result.fileCount, 3)
  assert.equal(result.files.find((file) => file.path.endsWith('a.bin')).sha256, sha256(duplicate))
  assert.equal(result.duplicates.length, 1)
  assert.deepEqual(result.duplicates[0].paths.map((value) => value.replace(/\\/gu, '/')), [
    'hash/a.bin',
    'hash/nested/b.bin',
  ])
})

test('configured extraction limits reject archives before publishing files', async () => {
  write('limit/source.bin', crypto.randomBytes(4096))
  await dispatchBatchFileTool('archive_create', {
    inputs: ['limit/source.bin'],
    output: 'limit/archive.zip',
  })
  process.env.BATCH_FILE_MAX_EXTRACTED_BYTES = '1024'
  await assert.rejects(
    () => dispatchBatchFileTool('archive_list', { input: 'limit/archive.zip' }),
    (error) => error?.code === 'ARCHIVE_EXPANSION_LIMIT' && error?.statusCode === 413,
  )
  await assert.rejects(
    () => dispatchBatchFileTool('archive_extract', {
      input: 'limit/archive.zip',
      outputDir: 'limit/output',
    }),
    (error) => error?.code === 'ARCHIVE_EXPANSION_LIMIT' && error?.statusCode === 413,
  )
  assert.equal(fs.existsSync(path.join(workspace, 'limit/output')), false)
})

test('archive_list enforces entry-count and compression-ratio limits', async () => {
  write('list-limits/a.txt', 'A'.repeat(64 * 1024))
  write('list-limits/b.txt', 'B')
  await dispatchBatchFileTool('archive_create', {
    inputs: ['list-limits/a.txt', 'list-limits/b.txt'],
    output: 'list-limits/archive.zip',
  })

  process.env.BATCH_FILE_MAX_ENTRIES = '1'
  await assert.rejects(
    () => dispatchBatchFileTool('archive_list', { input: 'list-limits/archive.zip' }),
    (error) => error?.code === 'ARCHIVE_TOO_MANY_ENTRIES',
  )
  delete process.env.BATCH_FILE_MAX_ENTRIES
  process.env.BATCH_FILE_MAX_COMPRESSION_RATIO = '2'
  await assert.rejects(
    () => dispatchBatchFileTool('archive_list', { input: 'list-limits/archive.zip' }),
    (error) => error?.code === 'ARCHIVE_COMPRESSION_RATIO_LIMIT',
  )
})

test('archive_extract stops an under-declared DEFLATE entry before publishing output', async () => {
  write('stream-limit/source.bin', crypto.randomBytes(64 * 1024))
  await dispatchBatchFileTool('archive_create', {
    inputs: ['stream-limit/source.bin'],
    output: 'stream-limit/original.zip',
  })
  const original = fs.readFileSync(path.join(workspace, 'stream-limit/original.zip'))
  write('stream-limit/under-declared.zip', patchDeclaredUncompressedSize(original, 1024))

  const listed = await dispatchBatchFileTool('archive_list', { input: 'stream-limit/under-declared.zip' })
  assert.equal(listed.totalBytes, 1024)
  await assert.rejects(
    () => dispatchBatchFileTool('archive_extract', {
      input: 'stream-limit/under-declared.zip',
      outputDir: 'stream-limit/output',
    }),
    (error) => error?.code === 'ARCHIVE_ENTRY_SIZE_LIMIT'
      && error?.statusCode === 413
      && error?.rollbackFailures?.length === 0
      && error?.recoveryPaths?.length === 0,
  )
  assert.equal(fs.existsSync(path.join(workspace, 'stream-limit/output')), false)
})

test('archive_list validates thousands of independent paths without quadratic conflict scans', {
  timeout: 10_000,
}, async () => {
  const entryCount = 5_000
  const names = Array.from({ length: entryCount }, (_, index) => `files/item-${String(index).padStart(5, '0')}.txt`)
  write('many-entries.zip', centralDirectoryOnlyZip(names))

  const listed = await dispatchBatchFileTool('archive_list', { input: 'many-entries.zip' })
  assert.equal(listed.entryCount, entryCount)
  assert.equal(listed.entries.at(-1).path, names.at(-1))
})

test('archive_extract overwrite rolls the whole batch back when cancelled after first publication', async () => {
  write('extract-rollback/source/a.txt', 'new A')
  write('extract-rollback/source/b.txt', 'new B')
  await dispatchBatchFileTool('archive_create', {
    inputs: [{ path: 'extract-rollback/source', archivePath: 'payload' }],
    output: 'extract-rollback/archive.zip',
  })
  write('extract-rollback/output/payload/a.txt', 'old A')
  write('extract-rollback/output/payload/b.txt', 'old B')

  const controller = new AbortController()
  const originalLinkSync = fs.linkSync
  let publications = 0
  fs.linkSync = (...linkArgs) => {
    const result = originalLinkSync(...linkArgs)
    publications += 1
    if (publications === 1) controller.abort()
    return result
  }
  try {
    await assert.rejects(
      () => dispatchBatchFileTool('archive_extract', {
        input: 'extract-rollback/archive.zip',
        outputDir: 'extract-rollback/output',
        overwrite: true,
      }, { signal: controller.signal }),
      (error) => error?.code === 'BATCH_FILE_CANCELLED'
        && error?.statusCode === 499
        && error?.rollbackFailures?.length === 0
        && error?.recoveryPaths?.length === 0,
    )
  } finally {
    fs.linkSync = originalLinkSync
  }

  assert.equal(publications, 1)
  assert.equal(fs.readFileSync(path.join(workspace, 'extract-rollback/output/payload/a.txt'), 'utf8'), 'old A')
  assert.equal(fs.readFileSync(path.join(workspace, 'extract-rollback/output/payload/b.txt'), 'utf8'), 'old B')
  const leftovers = workspaceEntries().filter((entry) => /\.(?:bak|tmp)$/u.test(entry))
  assert.deepEqual(leftovers, [])
})
