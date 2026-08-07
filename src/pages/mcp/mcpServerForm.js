import { serializeKeyValueLines } from '../../lib/mcpKeyValue.js'

export function emptyServer() {
  return {
    id: '', name: '', transport: 'http', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    env: {}, cwd: '', url: '', headers: {}, enabled: true, autoApprove: [], oauthClientId: '', oauthClientSecret: '',
    oauthScopes: '', oauthAuthorizationEndpoint: '', oauthTokenEndpoint: '',
  }
}

export function formFromServer(server) {
  return {
    ...server,
    envText: serializeKeyValueLines(server?.env),
    headersText: serializeKeyValueLines(server?.headers),
    oauthClientId: server?.oauth?.clientId || '',
    oauthClientSecret: '',
    oauthScopes: (server?.oauth?.scopes || []).join(' '),
    oauthAuthorizationEndpoint: server?.oauth?.authorizationEndpoint || '',
    oauthTokenEndpoint: server?.oauth?.tokenEndpoint || '',
  }
}
