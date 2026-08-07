export function manualIntegrationValues(provider, form = {}) {
  const mailProviders = ['qq_mail', 'gmail', 'outlook', 'exchange', 'custom_mail']
  const config = mailProviders.includes(provider)
    ? Object.fromEntries([
        ['user', form.user],
        ['from', form.from],
        ['smtpHost', form.smtpHost],
        ['smtpPort', form.smtpPort === '' || form.smtpPort == null ? '' : Number(form.smtpPort)],
        ['imapHost', form.imapHost],
        ['imapPort', form.imapPort === '' || form.imapPort == null ? '' : Number(form.imapPort)],
      ].filter(([, value]) => value !== '' && value != null))
    : provider === 'notion' || provider === 'slack'
    ? { workspace: form.workspace || '' }
    : provider === 'github' || provider === 'google_drive' || provider === 'google_calendar'
      ? { account: form.account || '' }
      : provider === 'jira'
        ? { siteUrl: form.siteUrl || '', email: form.email || '' }
      : provider === 'trello'
          ? { apiKey: form.apiKey || '' }
          : provider === 'gitlab'
            ? { baseUrl: form.baseUrl || '' }
            : provider === 'zendesk'
              ? { subdomain: form.subdomain || '', email: form.email || '' }
              : provider === 'confluence'
                ? { siteUrl: form.siteUrl || '', email: form.email || '' }
                : provider === 'salesforce'
                  ? { instanceUrl: form.instanceUrl || '' }
      : provider === 'telegram'
        ? { botUsername: form.botUsername || '', mode: 'polling' }
        : provider === 'discord'
          ? { applicationId: form.appId || '' }
          : { appId: form.appId || '' }
  const secret = {}
  if (['feishu', 'qq'].includes(provider) && form.appSecret) secret.appSecret = form.appSecret
  if (provider === 'qq' && form.token) secret.token = form.token
  if (provider === 'telegram' && form.token) secret.botToken = form.token
  if (provider === 'discord' && form.token) secret.botToken = form.token
  if (['notion', 'github', 'google_drive', 'google_calendar', 'jira', 'linear', 'trello', 'gitlab', 'asana', 'clickup', 'airtable', 'monday', 'hubspot', 'zendesk', 'todoist', 'dropbox', 'onedrive', 'confluence', 'salesforce'].includes(provider) && form.token) secret.token = form.token
  if (provider === 'slack' && form.token) secret.botToken = form.token
  if (mailProviders.includes(provider) && form.password) secret.password = form.password
  return { config, secret }
}
