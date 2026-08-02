import { registerDynamicTool, unregisterByOrigin } from './toolRegistry.js'
import {
  fetchNotionPage,
  getGoogleDriveFile,
  getGithubFile,
  listSlackChannels,
  listConnectedBrowserApps,
  openConnectedBrowserApp,
  readSlackChannel,
  searchGoogleDrive,
  searchGithubRepositories,
  searchNotion,
} from './connectorService.js'

const definitions = [
  ['connected_app_list', 'List Browser apps connected and enabled by the current user for task assistance.', {}, []],
  ['connected_app_open', 'Use a persistently connected Browser app by provider ID. The visible managed session is restored automatically when needed.', { provider: { type: 'string' } }, ['provider']],
  ['notion_search', 'Search pages and databases shared with the connected Notion integration.', { query: { type: 'string' } }, []],
  ['notion_fetch_page', 'Read a Notion page and its first 100 child blocks by page ID.', { pageId: { type: 'string' } }, ['pageId']],
  ['github_search_repositories', 'Search repositories visible to the connected GitHub account.', { query: { type: 'string' } }, ['query']],
  ['github_get_file', 'Read a file or list a directory in a GitHub repository.', {
    owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' },
  }, ['owner', 'repo', 'path']],
  ['slack_list_channels', 'List public and private Slack channels visible to the connected app.', {
    limit: { type: 'number' },
  }, []],
  ['slack_read_channel', 'Read recent messages from a Slack channel by channel ID.', {
    channelId: { type: 'string' }, limit: { type: 'number' },
  }, ['channelId']],
  ['google_drive_search', 'Search files visible to the connected Google Drive account.', {
    query: { type: 'string' }, limit: { type: 'number' },
  }, []],
  ['google_drive_get_file', 'Read metadata and text content from a Google Drive file by ID.', {
    fileId: { type: 'string' },
  }, ['fileId']],
]

export const CONNECTOR_TOOL_SPECS = Object.freeze(definitions.map(([name, description, properties, required]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
})))

export const CONNECTOR_TOOL_NAMES = Object.freeze(CONNECTOR_TOOL_SPECS.map((spec) => spec.function.name))

export async function executeConnectorTool(name, args = {}, { userId, fetchImpl, env } = {}) {
  if (!userId) return { ok: false, error: 'connector tools require userId' }
  try {
    if (name === 'connected_app_list') {
      return { ok: true, apps: listConnectedBrowserApps({ userId }) }
    }
    if (name === 'connected_app_open') {
      return { ok: true, ...(await openConnectedBrowserApp({ userId, provider: args.provider })) }
    }
    if (name === 'notion_search') {
      return { ok: true, ...(await searchNotion({ userId, query: args.query })) }
    }
    if (name === 'notion_fetch_page') {
      return { ok: true, ...(await fetchNotionPage({ userId, pageId: args.pageId })) }
    }
    if (name === 'github_search_repositories') {
      return { ok: true, ...(await searchGithubRepositories({ userId, query: args.query })) }
    }
    if (name === 'github_get_file') {
      return { ok: true, ...(await getGithubFile({ userId, ...args, fetchImpl })) }
    }
    if (name === 'slack_list_channels') {
      return { ok: true, ...(await listSlackChannels({ userId, ...args, fetchImpl })) }
    }
    if (name === 'slack_read_channel') {
      return { ok: true, ...(await readSlackChannel({ userId, ...args, fetchImpl })) }
    }
    if (name === 'google_drive_search') {
      return { ok: true, ...(await searchGoogleDrive({ userId, ...args, fetchImpl, env })) }
    }
    if (name === 'google_drive_get_file') {
      return { ok: true, ...(await getGoogleDriveFile({ userId, ...args, fetchImpl, env })) }
    }
    return { ok: false, error: `unknown connector tool: ${name}` }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}

export function registerConnectorTools() {
  unregisterByOrigin('connector')
  for (const spec of CONNECTOR_TOOL_SPECS) {
    const name = spec.function.name
    registerDynamicTool({
      name,
      origin: 'connector',
      source: name.split('_')[0],
      spec,
      exec: (args, context) => executeConnectorTool(name, args, context),
    })
  }
}
