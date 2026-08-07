// Stream completion event contract: { type: 'complete' }
export { callModelThroughProxy, summarizeSessionTitle } from './modelClient/modelCompletion.js'
export {
  deleteModelProvider,
  discoverModelProvider,
  getModelStatus,
  getSystemDiagnostics,
  listModelProviders,
  saveModelProvider,
  testModelEndpoint,
  testModelProvider,
} from './modelClient/modelProviders.js'
export { StreamTruncatedError, callModelThroughProxyStream } from './modelClient/modelStream.js'
