export function splitPersonaManifestIds(text) {
  return [...new Set(String(text || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean))]
}
