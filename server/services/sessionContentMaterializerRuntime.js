import { randomUUID } from 'node:crypto'
import os from 'node:os'

import {
  acknowledgeSessionContentOutbox,
  claimSessionContentOutbox,
  materializeSessionContentOutbox,
  releaseSessionContentOutboxFailure,
} from './sessionContentOutboxStore.js'
import {
  createSessionJsonlMaterializer,
  materializeSessionContentEvent,
} from './sessionJsonlMaterializer.js'
import { logger } from '../utils/logger.js'

const DEFAULT_INTERVAL_MS = 250
const MIN_INTERVAL_MS = 25
const MAX_INTERVAL_MS = 60_000

let activeRuntime = null

function normalizedInterval(value) {
  const interval = Number(value)
  if (!Number.isSafeInteger(interval) || interval < MIN_INTERVAL_MS) return DEFAULT_INTERVAL_MS
  return Math.min(interval, MAX_INTERVAL_MS)
}

export function createSessionContentMaterializerRuntime({
  intervalMs = DEFAULT_INTERVAL_MS,
  env = process.env,
  cwd = process.cwd(),
  ownerId = `session-jsonl:${os.hostname()}:${process.pid}:${randomUUID()}`,
  claim = claimSessionContentOutbox,
  acknowledge = acknowledgeSessionContentOutbox,
  materialize = materializeSessionContentOutbox,
  releaseFailure = releaseSessionContentOutboxFailure,
  append = (row) => materializeSessionContentEvent(row, { env, cwd }),
  onError = (error) => logger.warn(
    `[session-content] materialization pass failed: ${error?.message || error}`,
  ),
} = {}) {
  const delay = normalizedInterval(intervalMs)
  const materializer = createSessionJsonlMaterializer({
    claim,
    acknowledge,
    materialize,
    releaseFailure,
    append,
    ownerId,
  })
  let timer = null
  let started = false
  let closing = false
  let stopped = false
  let activeDrain = null

  const schedule = () => {
    if (closing || stopped || timer) return
    timer = setTimeout(run, delay)
    timer.unref?.()
  }

  const run = () => {
    timer = null
    if (closing || stopped) return Promise.resolve([])
    if (activeDrain) return activeDrain
    activeDrain = materializer.drainOnce()
      .then((results) => {
        for (const result of results || []) {
          if (!result?.ok) onError(result?.error || new Error('session content materialization failed'))
        }
        return results
      })
      .catch((error) => {
        onError(error)
        return []
      })
      .finally(() => {
        activeDrain = null
        schedule()
      })
    return activeDrain
  }

  return Object.freeze({
    start() {
      if (stopped) throw new Error('session content materializer runtime is closed')
      started = true
      void run()
      return true
    },
    drainOnce: run,
    async close() {
      if (closing || stopped) return
      closing = true
      if (timer) clearTimeout(timer)
      timer = null
      await activeDrain
      // A turn can commit another outbox row after the last periodic claim and
      // immediately request process shutdown. Once upstream writers are
      // stopped, perform one final synchronous drain before releasing SQLite.
      if (started) {
        try {
          const results = await materializer.drainOnce()
          for (const result of results || []) {
            if (!result?.ok) onError(result?.error || new Error('session content materialization failed'))
          }
        } catch (error) {
          onError(error)
        }
      }
      stopped = true
    },
  })
}

export function startSessionContentMaterializerRuntime(options = {}) {
  if (activeRuntime) return activeRuntime
  const runtime = createSessionContentMaterializerRuntime(options)
  activeRuntime = runtime
  runtime.start()
  return runtime
}

export async function closeSessionContentMaterializerRuntime() {
  const runtime = activeRuntime
  activeRuntime = null
  await runtime?.close()
}
