import path from 'node:path'

import { readBoundedJson } from './localPluginPackageMetadata.js'
import {
  publicLocalPluginPackageReceipt,
  validateLocalPluginPackageReceipt,
} from './localPluginPackageReceipt.js'
import {
  LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE,
  snapshotLocalPluginPackage,
} from './localPluginPackageSnapshot.js'
import {
  LOCAL_PLUGIN_PACKAGE_METADATA_LIMIT_BYTES,
  canonicalPath,
  packageStoreError,
} from './localPluginPackageStoreSupport.js'

export function verifyInstalledLocalPluginPackage(packageDir) {
  const resolved = path.resolve(packageDir)
  const receipt = validateLocalPluginPackageReceipt(readBoundedJson(
    path.join(resolved, LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE),
    LOCAL_PLUGIN_PACKAGE_METADATA_LIMIT_BYTES,
    'PLUGIN_PACKAGE_RECEIPT_INVALID',
  ))
  const snapshot = snapshotLocalPluginPackage(resolved, { receiptMode: 'exclude' })
  if (
    receipt.pluginId !== snapshot.manifest.id
    || receipt.pluginVersion !== snapshot.manifest.version
    || receipt.packageDigest !== snapshot.packageDigest
    || receipt.fileCount !== snapshot.fileCount
    || receipt.totalBytes !== snapshot.totalBytes
  ) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_CONTENT_MISMATCH',
      `installed plugin package ${receipt.pluginId} no longer matches its install receipt`,
      409,
    )
  }
  if (path.basename(canonicalPath(resolved)) !== receipt.pluginId) {
    throw packageStoreError(
      'PLUGIN_PACKAGE_CONTENT_MISMATCH',
      'installed plugin package directory does not match its manifest id',
      409,
    )
  }
  return publicLocalPluginPackageReceipt(receipt)
}
