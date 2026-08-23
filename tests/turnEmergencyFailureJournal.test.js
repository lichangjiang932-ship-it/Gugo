import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  acquireTurnEmergencyFailureJournalLock,
  recordTurnEmergencyFailure,
} from '../server/services/turnEmergencyFailureJournal.js'

function writeLockOwner(journalPath, metadata) {
  const directory = `${journalPath}.lock`
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'owner.json'), `${JSON.stringify(metadata)}\n`)
  return directory
}

test('emergency turn failure journal falls back when the primary data location is unwritable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-emergency-'))
  try {
    const primaryDirectory = path.join(root, 'primary-is-a-directory')
    const fallbackDirectory = path.join(root, 'fallback')
    fs.mkdirSync(primaryDirectory, { recursive: true })
    fs.mkdirSync(fallbackDirectory, { recursive: true })

    const result = recordTurnEmergencyFailure({
      batch: [{
        userId: 'user-1',
        event: {
          id: 'event-1', sessionId: 'session-1', turnId: 'turn-1',
          sequence: 4, type: 'turn.checkpoint', payload: { phase: 'tool' },
        },
        checkpointState: { iteration: 3, messages: [{ role: 'assistant', content: 'kept' }] },
      }],
      error: Object.assign(new Error('database is read only'), { code: 'SQLITE_READONLY' }),
      journalError: new Error('event_write_failures is unavailable'),
      attempts: 3,
      failedAt: 1_234,
    }, {
      env: { TURN_EMERGENCY_FAILURE_LOG_PATH: primaryDirectory },
      cwd: root,
      tempDir: fallbackDirectory,
    })

    assert.equal(result.path, path.join(fallbackDirectory, 'gugo-turn-emergency-failures.jsonl'))
    const rows = fs.readFileSync(result.path, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].error.code, 'SQLITE_READONLY')
    assert.equal(rows[0].entries[0].event.type, 'turn.checkpoint')
    assert.equal(rows[0].entries[0].checkpointState.iteration, 3)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an active primary lock sends the emergency writer to fallback and releases cleanly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-emergency-lock-fallback-'))
  try {
    const dataDirectory = path.join(root, 'data')
    const fallbackDirectory = path.join(root, 'fallback')
    const primaryPath = path.join(dataDirectory, 'turn-emergency-failures.jsonl')
    const lock = acquireTurnEmergencyFailureJournalLock(primaryPath)
    try {
      const result = recordTurnEmergencyFailure({
        batch: [{ userId: 'lock-user', event: { id: 'fallback-event' } }],
        errorMessage: 'primary lock is held',
      }, {
        env: { APP_DATA_DIR: dataDirectory },
        cwd: root,
        tempDir: fallbackDirectory,
      })
      assert.equal(result.path, path.join(fallbackDirectory, 'gugo-turn-emergency-failures.jsonl'))
      assert.equal(fs.existsSync(primaryPath), false)
    } finally {
      lock.release()
    }
    const nextLock = acquireTurnEmergencyFailureJournalLock(primaryPath)
    nextLock.release()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('only a proven same-host dead and expired lock is reclaimed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-emergency-stale-lock-'))
  try {
    const journalPath = path.join(root, 'turn-emergency-failures.jsonl')
    const token = randomUUID()
    writeLockOwner(journalPath, {
      schemaVersion: 1,
      token,
      pid: 999_999,
      hostname: 'same-test-host',
      acquiredAt: 100,
    })
    const lock = acquireTurnEmergencyFailureJournalLock(journalPath, {
      now: 10_000,
      hostname: 'same-test-host',
      staleMs: 1_000,
      isProcessAlive: (pid) => {
        assert.equal(pid, 999_999)
        return false
      },
    })
    assert.notEqual(JSON.parse(fs.readFileSync(lock.path, 'utf8')).token, token)
    lock.release()
    assert.equal(fs.existsSync(`${journalPath}.lock`), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('active, foreign-host, and malformed locks fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-emergency-invalid-lock-'))
  try {
    const activePath = path.join(root, 'active.jsonl')
    const active = acquireTurnEmergencyFailureJournalLock(activePath)
    assert.throws(
      () => acquireTurnEmergencyFailureJournalLock(activePath, {
        now: Date.now() + 60 * 60 * 1000,
        staleMs: 1,
        isProcessAlive: () => true,
      }),
      (error) => error.code === 'TURN_EMERGENCY_FAILURE_JOURNAL_LOCKED',
    )
    active.release()

    const foreignPath = path.join(root, 'foreign.jsonl')
    writeLockOwner(foreignPath, {
      schemaVersion: 1,
      token: randomUUID(),
      pid: 999_998,
      hostname: 'another-host',
      acquiredAt: 1,
    })
    assert.throws(
      () => acquireTurnEmergencyFailureJournalLock(foreignPath, {
        now: 10_000,
        hostname: 'this-host',
        staleMs: 1,
        isProcessAlive: () => false,
      }),
      (error) => error.code === 'TURN_EMERGENCY_FAILURE_JOURNAL_LOCKED',
    )

    const malformedPath = path.join(root, 'malformed.jsonl')
    const malformedDirectory = `${malformedPath}.lock`
    fs.mkdirSync(malformedDirectory, { recursive: true })
    fs.writeFileSync(path.join(malformedDirectory, 'owner.json'), '{invalid json}\n')
    assert.throws(
      () => acquireTurnEmergencyFailureJournalLock(malformedPath, {
        now: 10_000,
        staleMs: 1,
        isProcessAlive: () => false,
      }),
      (error) => error.code === 'TURN_EMERGENCY_FAILURE_JOURNAL_LOCKED',
    )
    assert.equal(fs.readFileSync(path.join(malformedDirectory, 'owner.json'), 'utf8'), '{invalid json}\n')

    const invalidTokenPath = path.join(root, 'invalid-token.jsonl')
    const invalidTokenDirectory = writeLockOwner(invalidTokenPath, {
      schemaVersion: 1,
      token: '../not-a-uuid',
      pid: 999_997,
      hostname: os.hostname(),
      acquiredAt: 1,
    })
    assert.throws(
      () => acquireTurnEmergencyFailureJournalLock(invalidTokenPath, {
        now: 10_000,
        staleMs: 1,
        isProcessAlive: () => false,
      }),
      (error) => error.code === 'TURN_EMERGENCY_FAILURE_JOURNAL_LOCKED',
    )
    assert.equal(fs.existsSync(path.join(invalidTokenDirectory, 'owner.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('owner open, write, and fsync faults remove only the lock directory created by that attempt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-emergency-lock-fault-'))
  try {
    for (const failureKind of ['open', 'write', 'fsync']) {
      const journalPath = path.join(root, `${failureKind}.jsonl`)
      const descriptorPaths = new Map()
      let injected = false
      const failingFileSystem = {
        openSync(target, flags, ...args) {
          if (failureKind === 'open'
            && !injected
            && String(target).endsWith(path.join('.lock', 'owner.json'))
            && flags === 'wx') {
            injected = true
            throw Object.assign(new Error('injected owner open failure'), { code: 'EIO' })
          }
          const descriptor = fs.openSync(target, flags, ...args)
          descriptorPaths.set(descriptor, String(target))
          return descriptor
        },
        writeSync(descriptor, ...args) {
          if (failureKind === 'write'
            && !injected
            && descriptorPaths.get(descriptor)?.endsWith(path.join('.lock', 'owner.json'))) {
            injected = true
            throw new Error('injected owner write failure')
          }
          return fs.writeSync(descriptor, ...args)
        },
        fsyncSync(descriptor) {
          if (failureKind === 'fsync'
            && !injected
            && descriptorPaths.get(descriptor)?.endsWith(path.join('.lock', 'owner.json'))) {
            injected = true
            throw new Error('injected owner fsync failure')
          }
          return fs.fsyncSync(descriptor)
        },
        closeSync(descriptor) {
          descriptorPaths.delete(descriptor)
          return fs.closeSync(descriptor)
        },
      }
      assert.throws(
        () => acquireTurnEmergencyFailureJournalLock(journalPath, {
          fileSystem: failingFileSystem,
        }),
        (error) => error.code === 'TURN_EMERGENCY_FAILURE_JOURNAL_LOCKED',
      )
      assert.equal(injected, true)
      assert.equal(fs.existsSync(`${journalPath}.lock`), false)
      const recovered = acquireTurnEmergencyFailureJournalLock(journalPath)
      recovered.release()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('journal descriptor close failure still releases the primary lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-emergency-close-lock-'))
  try {
    const dataDirectory = path.join(root, 'data')
    const fallbackDirectory = path.join(root, 'fallback')
    const primaryPath = path.join(dataDirectory, 'turn-emergency-failures.jsonl')
    const descriptorPaths = new Map()
    let injected = false
    const failingFileSystem = {
      openSync(target, flags, ...args) {
        const descriptor = fs.openSync(target, flags, ...args)
        descriptorPaths.set(descriptor, { target: String(target), flags })
        return descriptor
      },
      closeSync(descriptor) {
        const opened = descriptorPaths.get(descriptor)
        descriptorPaths.delete(descriptor)
        const result = fs.closeSync(descriptor)
        if (!injected && opened?.target === primaryPath && opened.flags === 'a') {
          injected = true
          throw new Error('injected journal descriptor close failure')
        }
        return result
      },
    }
    const result = recordTurnEmergencyFailure({
      batch: [{ userId: 'close-user', event: { id: 'close-event' } }],
      errorMessage: 'close failure test',
    }, {
      env: { APP_DATA_DIR: dataDirectory },
      cwd: root,
      tempDir: fallbackDirectory,
      fileSystem: failingFileSystem,
    })
    assert.equal(injected, true)
    assert.equal(result.path, path.join(fallbackDirectory, 'gugo-turn-emergency-failures.jsonl'))
    assert.equal(fs.existsSync(`${primaryPath}.lock`), false)
    const lock = acquireTurnEmergencyFailureJournalLock(primaryPath)
    lock.release()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release does not delete an ABA-replaced lock directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-emergency-aba-lock-'))
  try {
    const journalPath = path.join(root, 'turn-emergency-failures.jsonl')
    const lock = acquireTurnEmergencyFailureJournalLock(journalPath)
    const displaced = `${lock.directory}.displaced`
    fs.renameSync(lock.directory, displaced)
    const replacementToken = randomUUID()
    writeLockOwner(journalPath, {
      schemaVersion: 1,
      token: replacementToken,
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: Date.now(),
    })
    lock.release()
    const replacement = JSON.parse(fs.readFileSync(path.join(lock.directory, 'owner.json'), 'utf8'))
    assert.equal(replacement.token, replacementToken)
    assert.equal(fs.existsSync(displaced), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
