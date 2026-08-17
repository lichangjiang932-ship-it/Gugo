/**
 * @deprecated Import the shared loop from toolLoopRuntime.js.
 * This facade remains for third-party extensions and older tests.
 */
import {
  runToolLoop as runToolLoopRuntime,
  runToolsLoop as runToolsLoopRuntime,
} from './toolLoopRuntime.js'

export * from './toolLoopRuntime.js'

export async function runToolsLoop(options = {}) {
  return runToolsLoopRuntime(options)
}

export async function runToolLoop(options = {}) {
  return runToolLoopRuntime(options)
}
