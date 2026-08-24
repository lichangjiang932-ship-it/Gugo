export const REVISION_CONFLICT = 'PLUGIN_PACKAGE_REVISION_CONFLICT'

export function packageDescription(entry, t) {
  const digest = String(entry?.packageDigest || '')
  return [
    entry?.pluginVersion ? `v${entry.pluginVersion}` : '',
    digest ? `${digest.slice(0, 19)}…` : '',
    Number.isSafeInteger(entry?.fileCount)
      ? t('settings.localPluginPackageFiles', { count: entry.fileCount })
      : '',
  ].filter(Boolean).join(' · ')
}
