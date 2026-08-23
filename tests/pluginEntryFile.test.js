import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readPluginEntryFile } from '../server/plugins/pluginEntryFile.js'

async function withEntryFixture(run) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gugo-plugin-entry-file-'))
  const entryPath = path.join(rootDir, 'entry.js')
  await fs.writeFile(entryPath, 'safe-source')
  try {
    await run({ rootDir, entryPath })
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true })
  }
}

async function fileHandlePrototype(entryPath) {
  const handle = await fs.open(entryPath, 'r')
  try {
    return Object.getPrototypeOf(handle)
  } finally {
    await handle.close()
  }
}

test('non-truncating plugin entry reads reject growth during the FileHandle read', async () => {
  await withEntryFixture(async ({ rootDir, entryPath }) => {
    const prototype = await fileHandlePrototype(entryPath)
    const originalRead = prototype.read
    let changed = false
    prototype.read = async function patchedRead(...args) {
      const result = await originalRead.apply(this, args)
      if (!changed && result.bytesRead > 0) {
        changed = true
        await fs.appendFile(entryPath, '-changed')
      }
      return result
    }
    try {
      await assert.rejects(
        () => readPluginEntryFile({ rootDir, entryPath, maxBytes: 1024 }),
        (error) => error?.code === 'PLUGIN_ENTRY_CHANGED',
      )
    } finally {
      prototype.read = originalRead
    }
  })
})

test('non-truncating plugin entry reads reject same-size mtime/content drift', async () => {
  await withEntryFixture(async ({ rootDir, entryPath }) => {
    const prototype = await fileHandlePrototype(entryPath)
    const originalRead = prototype.read
    let changed = false
    prototype.read = async function patchedRead(...args) {
      const result = await originalRead.apply(this, args)
      if (!changed && result.bytesRead > 0) {
        changed = true
        await fs.writeFile(entryPath, 'evil-source')
        const future = new Date(Date.now() + 5_000)
        await fs.utimes(entryPath, future, future)
      }
      return result
    }
    try {
      await assert.rejects(
        () => readPluginEntryFile({ rootDir, entryPath, maxBytes: 1024 }),
        (error) => error?.code === 'PLUGIN_ENTRY_CHANGED',
      )
    } finally {
      prototype.read = originalRead
    }
  })
})

test('non-truncating plugin entry reads reject a short read', async () => {
  await withEntryFixture(async ({ rootDir, entryPath }) => {
    const prototype = await fileHandlePrototype(entryPath)
    const originalRead = prototype.read
    let intercepted = false
    prototype.read = async function patchedRead(buffer) {
      if (!intercepted) {
        intercepted = true
        return { bytesRead: 0, buffer }
      }
      return originalRead.apply(this, arguments)
    }
    try {
      await assert.rejects(
        () => readPluginEntryFile({ rootDir, entryPath, maxBytes: 1024 }),
        (error) => error?.code === 'PLUGIN_ENTRY_CHANGED',
      )
    } finally {
      prototype.read = originalRead
    }
  })
})

test('canonical containment keeps case-distinct directories separate when the filesystem supports them', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gugo-plugin-entry-case-'))
  const rootDir = path.join(parent, 'Plugin')
  const caseVariant = path.join(parent, 'plugin')
  try {
    await fs.mkdir(rootDir)
    try {
      await fs.mkdir(caseVariant)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        t.skip('filesystem is not case-sensitive')
        return
      }
      throw error
    }
    const entryPath = path.join(caseVariant, 'entry.js')
    await fs.writeFile(entryPath, 'outside-case-variant')
    await assert.rejects(
      () => readPluginEntryFile({ rootDir, entryPath, maxBytes: 1024 }),
      (error) => error?.code === 'PLUGIN_ENTRY_SCOPE_INVALID',
    )
  } finally {
    await fs.rm(parent, { recursive: true, force: true })
  }
})

test('plugin entry reads reject roots below linked directories', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gugo-plugin-entry-linked-parent-'))
  const realParent = path.join(parent, 'real-parent')
  const linkedParent = path.join(parent, 'linked-parent')
  const realRoot = path.join(realParent, 'plugin')
  const rootDir = path.join(linkedParent, 'plugin')
  const entryPath = path.join(rootDir, 'entry.js')
  try {
    await fs.mkdir(realRoot, { recursive: true })
    await fs.writeFile(path.join(realRoot, 'entry.js'), 'safe-source')
    try {
      await fs.symlink(realParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`linked-directory assertion unavailable: ${error.code}`)
        return
      }
      throw error
    }

    await assert.rejects(
      () => readPluginEntryFile({ rootDir, entryPath, maxBytes: 1024 }),
      (error) => error?.code === 'PLUGIN_ENTRY_SCOPE_INVALID',
    )
  } finally {
    await fs.rm(parent, { recursive: true, force: true })
  }
})
