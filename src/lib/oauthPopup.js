export function openOAuthAuthorizationWindow(url, provider) {
  const browserWindow = globalThis.window
  const openPopup = browserWindow?.open
  if (typeof openPopup !== 'function') return null
  return openPopup.call(
    browserWindow,
    String(url || ''),
    `gugo-oauth-${String(provider || 'connector')}`,
    'popup=yes,width=620,height=760,resizable=yes,scrollbars=yes',
  )
}
