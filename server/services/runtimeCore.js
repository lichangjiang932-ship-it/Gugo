import {
  releaseApprovalsForJob,
  releaseApprovalsForTurn,
} from './approvalGate.js'
import {
  deleteJobTurnCheckpoint,
  getJobTurnCheckpoint,
  makeJobTurnCheckpointResumable,
  saveJobTurnCheckpoint,
} from './jobTurnCheckpointStore.js'
import {
  deleteTurnCheckpoint,
  getTurnCheckpoint,
  saveTurnCheckpoint,
} from './turnCheckpointStore.js'
import { createJobExecutionLeaseCoordinator } from './jobExecutionLeaseRuntime.js'
import { createTurnExecutionLeaseCoordinator } from './turnExecutionLeaseRuntime.js'

function identity(value) {
  return value
}

function createCheckpointRuntime({
  load = null,
  save = null,
  clear = null,
  makeResumable = null,
} = {}) {
  return Object.freeze({
    load(scope) {
      return typeof load === 'function' ? load(scope) : null
    },
    save(scope, state, metadata = {}) {
      if (typeof save !== 'function') return null
      return save({ ...scope, ...metadata, state })
    },
    clear(scope) {
      return typeof clear === 'function' ? clear(scope) : 0
    },
    makeResumable(scope, options = {}) {
      return typeof makeResumable === 'function'
        ? makeResumable({ ...scope, ...options })
        : null
    },
  })
}

function createLeaseRuntime(coordinator, mapScope = identity, { asyncAcquire = false } = {}) {
  const normalizeScope = (scope) => mapScope(scope)
  const normalizeProof = (value) => {
    const ownerId = typeof value?.ownerId === 'string' ? value.ownerId.trim() : ''
    const fencingToken = Number(value?.fencingToken)
    if (!ownerId || !Number.isSafeInteger(fencingToken) || fencingToken <= 0) return null
    return Object.freeze({ ownerId, fencingToken })
  }
  const snapshotProof = (scope) => {
    if (typeof coordinator?.proof !== 'function') return null
    return normalizeProof(coordinator.proof(normalizeScope(scope)))
  }
  const snapshotProofAsync = async (scope) => {
    if (typeof coordinator?.proof !== 'function') return null
    return normalizeProof(await coordinator.proof(normalizeScope(scope)))
  }
  const acquiredLease = (controller, executionLease, releaseLease) => {
    let released = false
    let releasePromise = null
    return {
      controller,
      executionLease,
      async release() {
        if (released) return false
        if (releasePromise) return await releasePromise
        const attempt = Promise.resolve().then(() => releaseLease?.())
        releasePromise = attempt
        try {
          const result = await attempt
          released = true
          return result
        } finally {
          if (releasePromise === attempt) releasePromise = null
        }
      },
    }
  }
  return Object.freeze({
    ownerId: coordinator?.ownerId || null,
    claim(scope) {
      return typeof coordinator?.claim === 'function'
        ? coordinator.claim(normalizeScope(scope))
        : false
    },
    hold(scope, controller) {
      return typeof coordinator?.hold === 'function'
        ? coordinator.hold(normalizeScope(scope), controller)
        : () => {}
    },
    acquire(scope, controller = new AbortController()) {
      if (asyncAcquire) {
        return (async () => {
          if (!await this.claim(scope)) return null
          const executionLease = await snapshotProofAsync(scope)
          const releaseLease = await this.hold(scope, controller)
          return acquiredLease(controller, executionLease, releaseLease)
        })()
      }
      if (!this.claim(scope)) return null
      const executionLease = snapshotProof(scope)
      const releaseLease = this.hold(scope, controller)
      let released = false
      return {
        controller,
        executionLease,
        release() {
          if (released) return
          released = true
          releaseLease?.()
        },
      }
    },
    proof(scope) {
      return snapshotProof(scope)
    },
    isActive(scope) {
      return typeof coordinator?.isActive === 'function'
        ? coordinator.isActive(normalizeScope(scope))
        : false
    },
    owns(scope) {
      return typeof coordinator?.owns !== 'function'
        || coordinator.owns(normalizeScope(scope))
    },
    runIfOwned(scope, callback) {
      if (typeof coordinator?.runIfOwned === 'function') {
        return coordinator.runIfOwned(normalizeScope(scope), callback)
      }
      if (!this.owns(scope)) return { owned: false, value: undefined }
      return { owned: true, value: callback() }
    },
    hasActiveSession(scope) {
      return typeof coordinator?.hasActiveSession === 'function'
        ? coordinator.hasActiveSession(normalizeScope(scope))
        : false
    },
    requestCancellation(scope) {
      return typeof coordinator?.requestCancellation === 'function'
        ? coordinator.requestCancellation(normalizeScope(scope))
        : false
    },
    closeSteeringInbox(scope) {
      return typeof coordinator?.closeSteeringInbox === 'function'
        ? coordinator.closeSteeringInbox(normalizeScope(scope))
        : null
    },
  })
}

export function createRuntimeCore({
  checkpoint,
  executionLeases,
  mapLeaseScope = identity,
  releaseApprovals = null,
  asyncLease = false,
} = {}) {
  return Object.freeze({
    checkpoint: createCheckpointRuntime(checkpoint),
    lease: createLeaseRuntime(executionLeases, mapLeaseScope, { asyncAcquire: asyncLease }),
    approval: Object.freeze({
      release(scope) {
        return typeof releaseApprovals === 'function' ? releaseApprovals(scope) : 0
      },
    }),
  })
}

export function createJobRuntimeCore({
  executionLeases = createJobExecutionLeaseCoordinator(),
  readCheckpoint = getJobTurnCheckpoint,
  writeCheckpoint = saveJobTurnCheckpoint,
  clearCheckpoint = deleteJobTurnCheckpoint,
  resumeCheckpoint = makeJobTurnCheckpointResumable,
  releaseApprovals = ({ jobId } = {}) => releaseApprovalsForJob(jobId),
} = {}) {
  return createRuntimeCore({
    checkpoint: {
      load: readCheckpoint,
      save: writeCheckpoint,
      clear: clearCheckpoint,
      makeResumable: resumeCheckpoint,
    },
    executionLeases,
    mapLeaseScope: (scope) => (typeof scope === 'string' ? scope : scope?.jobId),
    releaseApprovals,
  })
}

export function createTurnRuntimeCore({
  executionLeases = createTurnExecutionLeaseCoordinator(),
  readCheckpoint = getTurnCheckpoint,
  writeCheckpoint = saveTurnCheckpoint,
  clearCheckpoint = deleteTurnCheckpoint,
  releaseApprovals = releaseApprovalsForTurn,
} = {}) {
  return createRuntimeCore({
    checkpoint: {
      load: readCheckpoint,
      save: writeCheckpoint,
      clear: clearCheckpoint,
    },
    executionLeases,
    asyncLease: true,
    releaseApprovals,
  })
}
