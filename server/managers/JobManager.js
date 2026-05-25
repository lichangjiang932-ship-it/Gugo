/**
 * server/managers/JobManager.js
 *
 * 后台作业全生命周期的统一门面。
 * 薄壳 facade，转发 services/jobStore + services/jobRuntime。
 */

import * as Store from '../services/jobStore.js'
import { getJobRuntime, closeJobRuntime } from '../services/jobRuntime.js'

export const JobManager = {
  // —— 作业 CRUD ——
  create: Store.createJob,
  get: Store.getJob,
  list: Store.listJobs,
  update: Store.updateJob,

  // —— step / artifact ——
  appendSteps: Store.appendJobSteps,
  getStep: Store.getJobStep,
  listSteps: Store.listJobSteps,
  listQueuedSteps: Store.listQueuedSteps,

  // —— runtime ——
  getRuntime: getJobRuntime,
  closeRuntime: closeJobRuntime,
}
