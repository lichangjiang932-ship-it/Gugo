import { buildExploredPlan } from './jobPlanner.js'
import { runPlanningExploration } from './jobPlanningExplorationRuntime.js'
import { runDefaultJobModel } from './jobModelExecutionRuntime.js'

export function createDefaultJobPlanner({
  buildPlan = buildExploredPlan,
  explorePlan = runPlanningExploration,
  runPlanningModel = runDefaultJobModel,
} = {}) {
  return (prompt, { userId, modelName, modelEnv } = {}) => buildPlan(prompt, {
    userId,
    exploreModel: ({ messages }) => explorePlan({
      prompt,
      messages,
      userId,
      modelName,
      modelEnv,
    }),
    runModel: ({ messages }) => runPlanningModel({
      messages,
      userId,
      modelName,
      modelEnv,
    }),
  })
}
