import { gunzipSync } from 'node:zlib'

import { updateError } from './updateErrors.js'

/**
 * Turning an update's blockmaps into a transfer plan.

 * Pure arithmetic over the maps published beside the installer: which blocks of
 * the previous download can be reused, which have to be fetched, and how those
 * fetches are split into bounded ranges. Nothing here touches the network or the
 * disk, so the plan can be reasoned about — and tested — on its own.
 */

export const DEFAULT_UPDATE_CHUNK_SIZE = 2 * 1024 * 1024
export const MIN_UPDATE_CHUNK_SIZE = 1 * 1024 * 1024
export const MAX_UPDATE_CHUNK_SIZE = 4 * 1024 * 1024

export function boundedChunkSize(value) {
  const size = Number(value) || DEFAULT_UPDATE_CHUNK_SIZE
  return Math.max(MIN_UPDATE_CHUNK_SIZE, Math.min(MAX_UPDATE_CHUNK_SIZE, Math.floor(size)))
}

function blockMapFile(blockMap, label) {
  const file = blockMap?.files?.[0]
  if (!file || !Array.isArray(file.sizes) || !Array.isArray(file.checksums)) {
    throw updateError(`${label} blockmap is invalid`, 'UPDATE_BLOCKMAP_INVALID')
  }
  const offset = file.offset === undefined ? 0 : Number(file.offset)
  if (!Number.isSafeInteger(offset) || offset < 0
    || file.sizes.length !== file.checksums.length
    || file.sizes.some((size) => !Number.isInteger(size) || size <= 0)) {
    throw updateError(`${label} blockmap blocks are invalid`, 'UPDATE_BLOCKMAP_INVALID')
  }
  return { ...file, offset }
}

export function blockMapSize(blockMap) {
  return blockMapFile(blockMap, 'update').sizes.reduce((total, size) => total + size, 0)
}

export function parseBlockMap(buffer) {
  try {
    return JSON.parse(gunzipSync(buffer).toString('utf8'))
  } catch (cause) {
    throw updateError('update blockmap cannot be parsed', 'UPDATE_BLOCKMAP_INVALID', cause)
  }
}

function appendOperation(operations, operation) {
  const previous = operations.at(-1)
  if (previous
    && previous.kind === operation.kind
    && previous.sourceEnd === operation.sourceStart
    && previous.outputEnd === operation.outputStart) {
    previous.sourceEnd = operation.sourceEnd
    previous.outputEnd = operation.outputEnd
    return
  }
  operations.push(operation)
}

export function computeDifferentialOperations(oldBlockMap, newBlockMap) {
  if (oldBlockMap?.version !== newBlockMap?.version) {
    throw updateError('blockmap versions do not match', 'UPDATE_BLOCKMAP_VERSION_MISMATCH')
  }
  const oldFile = blockMapFile(oldBlockMap, 'current')
  const newFile = blockMapFile(newBlockMap, 'next')
  if (oldFile.name !== newFile.name) {
    throw updateError('blockmap file names do not match', 'UPDATE_BLOCKMAP_FILE_MISMATCH')
  }
  if (newFile.offset !== 0) {
    throw updateError('next blockmap does not cover the start of the installer', 'UPDATE_BLOCKMAP_OFFSET_UNSUPPORTED')
  }

  const oldBlocks = new Map()
  let oldOffset = oldFile.offset
  for (let index = 0; index < oldFile.checksums.length; index += 1) {
    const checksum = oldFile.checksums[index]
    const size = oldFile.sizes[index]
    if (!oldBlocks.has(checksum)) oldBlocks.set(checksum, { offset: oldOffset, size })
    oldOffset += size
  }

  const operations = []
  let newOffset = newFile.offset
  for (let index = 0; index < newFile.checksums.length; index += 1) {
    const size = newFile.sizes[index]
    const oldBlock = oldBlocks.get(newFile.checksums[index])
    const canCopy = oldBlock?.size === size
    appendOperation(operations, {
      kind: canCopy ? 'copy' : 'download',
      sourceStart: canCopy ? oldBlock.offset : newOffset,
      sourceEnd: (canCopy ? oldBlock.offset : newOffset) + size,
      outputStart: newOffset,
      outputEnd: newOffset + size,
    })
    newOffset += size
  }
  return operations
}

function splitDownloadOperations(operations, chunkSize) {
  const bounded = boundedChunkSize(chunkSize)
  const result = []
  for (const operation of operations) {
    if (operation.kind !== 'download') {
      result.push(operation)
      continue
    }
    let sourceStart = operation.sourceStart
    let outputStart = operation.outputStart
    while (sourceStart < operation.sourceEnd) {
      const length = Math.min(bounded, operation.sourceEnd - sourceStart)
      result.push({
        kind: 'download',
        sourceStart,
        sourceEnd: sourceStart + length,
        outputStart,
        outputEnd: outputStart + length,
      })
      sourceStart += length
      outputStart += length
    }
  }
  return result
}

export function buildUpdatePlan({ size, oldBlockMap = null, newBlockMap = null, chunkSize } = {}) {
  const totalSize = Number(size)
  if (!Number.isInteger(totalSize) || totalSize <= 0) {
    throw updateError('update size is invalid', 'UPDATE_SIZE_INVALID')
  }
  let mode = 'full'
  let operations = [{ kind: 'download', sourceStart: 0, sourceEnd: totalSize, outputStart: 0, outputEnd: totalSize }]
  if (oldBlockMap && newBlockMap) {
    const nextFile = blockMapFile(newBlockMap, 'update')
    if (nextFile.offset === 0 && blockMapSize(newBlockMap) === totalSize) {
      operations = computeDifferentialOperations(oldBlockMap, newBlockMap)
      mode = 'differential'
    }
  }
  operations = splitDownloadOperations(operations, chunkSize)
  const downloadBytes = operations
    .filter((operation) => operation.kind === 'download')
    .reduce((total, operation) => total + operation.outputEnd - operation.outputStart, 0)
  return { mode, size: totalSize, downloadBytes, operations }
}
