// Local plugin package store public facade. Transaction, recovery, locking,
// discovery and verification internals live in focused modules beside it.

export {
  LOCAL_PLUGIN_PACKAGE_STORE_SCHEMA_VERSION,
  LOCAL_PLUGIN_PACKAGE_TRANSACTION_DIRNAME,
} from './localPluginPackageStoreSupport.js'
export { LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION } from './localPluginPackageReceipt.js'
export { verifyInstalledLocalPluginPackage } from './localPluginPackageVerification.js'
export { recoverLocalPluginPackageTransactions } from './localPluginPackageRecovery.js'
export {
  discoverInstalledLocalPluginPackagesSync,
  listInstalledLocalPluginPackages,
  listInstalledLocalPluginPackagesSync,
  runWithLockedLocalPluginPackageStoreSnapshot,
} from './localPluginPackageDiscovery.js'
export {
  installLocalPluginPackage,
  uninstallLocalPluginPackage,
} from './localPluginPackageMutation.js'
