import { localPluginPackageReceiptIdentity } from './localPluginPackageReceipt.js'

export const LOCAL_PLUGIN_PACKAGE_TRANSACTION_SCHEMA_VERSION = 2

const LEGACY_TRANSACTION_SCHEMA_VERSION = 1
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/u
const SHA256_RE = /^sha256-[a-f0-9]{64}$/u

function transactionCorrupt(message) {
  return Object.assign(new Error(message), {
    code: 'PLUGIN_PACKAGE_TRANSACTION_CORRUPT',
    statusCode: 409,
    retryable: false,
  })
}

export function assertLocalPluginPackageTransactionReceipt(
  receipt,
  expectedDigest,
  label,
  pluginId,
  expectedReceiptIdentity = null,
) {
  if (!receipt || receipt.packageDigest !== expectedDigest) {
    throw transactionCorrupt(`${label} digest does not match transaction ${pluginId}`)
  }
  if (
    expectedReceiptIdentity !== null
    && localPluginPackageReceiptIdentity(receipt) !== expectedReceiptIdentity
  ) {
    throw transactionCorrupt(`${label} receipt identity does not match transaction ${pluginId}`)
  }
}

export function validateLocalPluginPackageTransactionJournal(
  journal,
  transactionId,
  entryName,
) {
  const pluginId = String(journal?.pluginId || '').trim()
  const legacyKeys = [
    'hadExisting',
    'operation',
    'packageDigest',
    'pluginId',
    'previousPackageDigest',
    'schemaVersion',
    'transactionId',
  ]
  const expectedKeys = (
    journal?.schemaVersion === LOCAL_PLUGIN_PACKAGE_TRANSACTION_SCHEMA_VERSION
      ? [...legacyKeys, 'packageReceiptIdentity', 'previousPackageReceiptIdentity']
      : legacyKeys
  ).sort()
  const keys = Object.keys(journal || {}).sort()
  const commonInvalid = (
    !PLUGIN_ID_RE.test(pluginId)
    || keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || ![
      LEGACY_TRANSACTION_SCHEMA_VERSION,
      LOCAL_PLUGIN_PACKAGE_TRANSACTION_SCHEMA_VERSION,
    ].includes(journal?.schemaVersion)
    || journal.transactionId !== transactionId
    || !['install', 'uninstall'].includes(journal.operation)
    || typeof journal.hadExisting !== 'boolean'
  )
  const digestInvalid = journal?.operation === 'install'
    ? (
      !SHA256_RE.test(String(journal.packageDigest || ''))
      || (journal.hadExisting
        ? !SHA256_RE.test(String(journal.previousPackageDigest || ''))
        : journal.previousPackageDigest !== null)
    )
    : (
      journal?.hadExisting !== true
      || journal?.packageDigest !== null
      || !SHA256_RE.test(String(journal?.previousPackageDigest || ''))
    )
  const receiptIdentityInvalid = (
    journal?.schemaVersion === LOCAL_PLUGIN_PACKAGE_TRANSACTION_SCHEMA_VERSION
    && (journal.operation === 'install'
      ? (
        !SHA256_RE.test(String(journal.packageReceiptIdentity || ''))
        || (journal.hadExisting
          ? !SHA256_RE.test(String(journal.previousPackageReceiptIdentity || ''))
          : journal.previousPackageReceiptIdentity !== null)
      )
      : (
        journal.packageReceiptIdentity !== null
        || !SHA256_RE.test(String(journal.previousPackageReceiptIdentity || ''))
      ))
  )
  if (commonInvalid || digestInvalid || receiptIdentityInvalid) {
    throw transactionCorrupt(`plugin package transaction journal is invalid: ${entryName}`)
  }
  return { ...journal, pluginId }
}
