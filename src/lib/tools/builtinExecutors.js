import { AGENT_EXECUTORS } from './agentExecutors.js'
import { ARTIFACT_EXECUTORS } from './artifactExecutors.js'
import { WORKSPACE_EXECUTORS } from './workspaceExecutors.js'

export const EXECUTORS = {
  ...WORKSPACE_EXECUTORS,
  ...ARTIFACT_EXECUTORS,
  ...AGENT_EXECUTORS,
}

