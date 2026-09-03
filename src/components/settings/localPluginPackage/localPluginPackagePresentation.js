export const REVISION_CONFLICT = 'PLUGIN_PACKAGE_REVISION_CONFLICT'

export function packageDescription(entry, t) {
  const digest = String(entry?.packageDigest || '')
  const publisher = entry?.publisherVerified === true
    ? t('settings.localPluginPackageVerifiedPublisher', {
      marketplace: entry?.marketplace?.displayName || entry?.marketplace?.name || '',
      publisher: entry?.publisher?.displayName || entry?.publisher?.id || '',
      keyId: String(entry?.publisher?.keyId || '').slice(0, 19),
    })
    : t('settings.localPluginPackageUnverifiedPublisher')
  return [
    entry?.pluginVersion ? `v${entry.pluginVersion}` : '',
    digest ? `${digest.slice(0, 19)}…` : '',
    Number.isSafeInteger(entry?.fileCount)
      ? t('settings.localPluginPackageFiles', { count: entry.fileCount })
      : '',
    publisher,
  ].filter(Boolean).join(' · ')
}
