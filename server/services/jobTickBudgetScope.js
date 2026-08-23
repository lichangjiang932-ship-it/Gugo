import { getJobBudget, releaseJobBudget } from '../utils/jobBudget.js'

/** Keep one scheduler tick bound to the budget generation it actually used. */
export function createJobTickBudgetScope(job) {
  let expectedBudget = getJobBudget(job)

  return Object.freeze({
    async run(execute) {
      try {
        return await execute()
      } finally {
        expectedBudget ||= getJobBudget(job)
      }
    },
    release() {
      return releaseJobBudget(job, expectedBudget)
    },
  })
}
