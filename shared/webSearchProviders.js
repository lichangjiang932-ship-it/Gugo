export const WEB_SEARCH_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'tavily',
    label: 'Tavily',
    initial: 'T',
    accent: 'bg-sky-100 text-sky-700',
    docsUrl: 'https://docs.tavily.com/documentation/api-reference/endpoint/search',
    extraFields: [],
  }),
  Object.freeze({
    id: 'brave',
    label: 'Brave Search',
    initial: 'B',
    accent: 'bg-orange-100 text-orange-700',
    docsUrl: 'https://api-dashboard.search.brave.com/app/keys',
    extraFields: [],
  }),
  Object.freeze({
    id: 'serper',
    label: 'Serper',
    initial: 'S',
    accent: 'bg-violet-100 text-violet-700',
    docsUrl: 'https://serper.dev/',
    extraFields: [],
  }),
  Object.freeze({
    id: 'bing',
    label: 'Bing Web Search',
    initial: 'B',
    accent: 'bg-teal-100 text-teal-700',
    docsUrl: 'https://learn.microsoft.com/bing/search-apis/bing-web-search/',
    extraFields: [],
  }),
  Object.freeze({
    id: 'google_cse',
    label: 'Google Custom Search',
    initial: 'G',
    accent: 'bg-blue-100 text-blue-700',
    docsUrl: 'https://developers.google.com/custom-search/v1/overview',
    extraFields: Object.freeze([
      Object.freeze({ key: 'cx', labelKey: 'webSearch.googleCx', placeholder: '0123456789:abcdef' }),
    ]),
  }),
  Object.freeze({
    id: 'custom',
    label: 'Custom REST API',
    initial: '···',
    accent: 'bg-ink-fade/15 text-ink-soft',
    docsUrl: '',
    extraFields: Object.freeze([]),
  }),
])

export const WEB_SEARCH_PROVIDER_IDS = Object.freeze(WEB_SEARCH_PROVIDERS.map((provider) => provider.id))

export function getWebSearchProvider(providerId) {
  return WEB_SEARCH_PROVIDERS.find((provider) => provider.id === providerId) || null
}
