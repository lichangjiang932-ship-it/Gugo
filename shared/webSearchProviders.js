export const WEB_SEARCH_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'tavily',
    label: 'Tavily',
    docsUrl: 'https://docs.tavily.com/documentation/api-reference/endpoint/search',
    extraFields: [],
  }),
  Object.freeze({
    id: 'brave',
    label: 'Brave Search',
    docsUrl: 'https://api-dashboard.search.brave.com/app/keys',
    extraFields: [],
  }),
  Object.freeze({
    id: 'serper',
    label: 'Serper',
    docsUrl: 'https://serper.dev/',
    extraFields: [],
  }),
  Object.freeze({
    id: 'bing',
    label: 'Bing Web Search',
    docsUrl: 'https://learn.microsoft.com/bing/search-apis/bing-web-search/',
    extraFields: [],
  }),
  Object.freeze({
    id: 'google_cse',
    label: 'Google Custom Search',
    docsUrl: 'https://developers.google.com/custom-search/v1/overview',
    extraFields: Object.freeze([
      Object.freeze({ key: 'cx', labelKey: 'webSearch.googleCx', placeholder: '0123456789:abcdef' }),
    ]),
  }),
  Object.freeze({
    id: 'custom',
    label: 'Custom REST API',
    docsUrl: '',
    extraFields: Object.freeze([]),
  }),
])

export const WEB_SEARCH_PROVIDER_IDS = Object.freeze(WEB_SEARCH_PROVIDERS.map((provider) => provider.id))

export function getWebSearchProvider(providerId) {
  return WEB_SEARCH_PROVIDERS.find((provider) => provider.id === providerId) || null
}
