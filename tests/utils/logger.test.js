import { test } from 'node:test'
import assert from 'node:assert/strict'

async function freshLogger(env) {
  for (const k of Object.keys(env)) process.env[k] = env[k]
  const mod = await import(`../../server/utils/logger.js?cache=${Math.random()}`)
  return mod.logger
}

function capture(method) {
  const original = console[method]
  const lines = []
  console[method] = (...args) => lines.push(args.join(' '))
  return {
    lines,
    restore: () => { console[method] = original },
  }
}

test('logger: default level is info — debug suppressed, info/warn/error pass', async () => {
  delete process.env.LOG_LEVEL
  const logger = await freshLogger({})
  const log = capture('log')
  const warn = capture('warn')
  const err = capture('error')
  try {
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
  } finally {
    log.restore(); warn.restore(); err.restore()
  }
  assert.equal(log.lines.length, 1)
  assert.match(log.lines[0], /\[info\] i$/)
  assert.equal(warn.lines.length, 1)
  assert.match(warn.lines[0], /\[warn\] w$/)
  assert.equal(err.lines.length, 1)
  assert.match(err.lines[0], /\[error\] e$/)
})

test('logger: LOG_LEVEL=debug lets debug through', async () => {
  const logger = await freshLogger({ LOG_LEVEL: 'debug' })
  const log = capture('log')
  try {
    logger.debug('hello')
  } finally {
    log.restore()
  }
  assert.equal(log.lines.length, 1)
  assert.match(log.lines[0], /\[debug\] hello$/)
})

test('logger: LOG_LEVEL=error silences info/warn but keeps error', async () => {
  const logger = await freshLogger({ LOG_LEVEL: 'error' })
  const log = capture('log')
  const warn = capture('warn')
  const err = capture('error')
  try {
    logger.info('i')
    logger.warn('w')
    logger.error('e')
  } finally {
    log.restore(); warn.restore(); err.restore()
  }
  assert.equal(log.lines.length, 0)
  assert.equal(warn.lines.length, 0)
  assert.equal(err.lines.length, 1)
})

test('logger: unknown LOG_LEVEL falls back to info', async () => {
  const logger = await freshLogger({ LOG_LEVEL: 'bogus' })
  const log = capture('log')
  try {
    logger.debug('d')
    logger.info('i')
  } finally {
    log.restore()
  }
  assert.equal(log.lines.length, 1)
  assert.match(log.lines[0], /\[info\] i$/)
})

test('logger: format prefixes ISO timestamp + level', async () => {
  const logger = await freshLogger({ LOG_LEVEL: 'info' })
  const log = capture('log')
  try {
    logger.info('payload', 42)
  } finally {
    log.restore()
  }
  assert.equal(log.lines.length, 1)
  assert.match(
    log.lines[0],
    /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[info\] payload 42$/,
  )
})

// 恢复默认
delete process.env.LOG_LEVEL
