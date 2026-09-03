import { getJob as getJobRow } from './jobStore.js'
import { createJobRuntimeEventHub } from './jobRuntimeEventHub.js'

export function createDefaultJobRuntimeEventHub({ getJob = getJobRow } = {}) {
  if (typeof getJob !== 'function') {
    throw new TypeError('createDefaultJobRuntimeEventHub requires getJob to be a function')
  }
  return createJobRuntimeEventHub({
    resolveJobOwner: (jobId) => getJob(jobId)?.userId || null,
  })
}
