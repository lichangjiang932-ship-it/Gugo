import { registerDynamicTool, unregisterByOrigin } from './toolRegistry.js'

const definitions = [
  ['connected_app_list', 'List Browser apps connected and enabled by the current user for task assistance.', {}, []],
  ['connected_app_open', 'Open a connected Browser app by provider ID. Only enabled apps from the trusted catalog are allowed.', { provider: { type: 'string' } }, ['provider']],
  ['notion_search', 'Search pages and databases shared with the connected Notion integration.', { query: { type: 'string' } }, []],
  ['notion_fetch_page', 'Read a Notion page and its first 100 child blocks by page ID.', { pageId: { type: 'string' } }, ['pageId']],
  ['github_search_repositories', 'Search repositories visible to the connected GitHub account.', { query: { type: 'string' } }, ['query']],
  ['github_get_file', 'Read a file or list a directory in a GitHub repository.', {
    owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' },
  }, ['owner', 'repo', 'path']],
]

export function registerConnectorTools() {
  unregisterByOrigin('connector')
  for (const [name, description, properties, required] of definitions) {
    registerDynamicTool({
      name,
      origin: 'connector',
      source: name.split('_')[0],
      spec: { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } },
    })
  }
}
