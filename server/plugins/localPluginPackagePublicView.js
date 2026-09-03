import { snapshotPublicPluginInstallReceipt } from './pluginDistributionContract.js'

function invalidView() {
  return Object.assign(new Error('local plugin package store is invalid'), {
    code: 'PLUGIN_PACKAGE_STORE_FAILED',
    statusCode: 500,
    retryable: false,
  })
}

export function localPluginPackagePublicView(value) {
  try {
    return snapshotPublicPluginInstallReceipt(value)
  } catch {
    throw invalidView()
  }
}
