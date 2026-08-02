export function manualIntegrationValues(provider, form = {}) {
  const config = provider === 'notion' || provider === 'slack'
    ? { workspace: form.workspace || '' }
    : provider === 'github' || provider === 'google_drive'
      ? { account: form.account || '' }
      : provider === 'telegram'
        ? { botUsername: form.botUsername || '', mode: 'polling' }
        : { appId: form.appId || '' }
  const secret = {}
  if (['feishu', 'qq'].includes(provider) && form.appSecret) secret.appSecret = form.appSecret
  if (provider === 'qq' && form.token) secret.token = form.token
  if (provider === 'telegram' && form.token) secret.botToken = form.token
  if (['notion', 'github', 'google_drive'].includes(provider) && form.token) secret.token = form.token
  if (provider === 'slack' && form.token) secret.botToken = form.token
  return { config, secret }
}
