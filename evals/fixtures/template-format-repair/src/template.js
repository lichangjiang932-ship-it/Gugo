export function formatMessage(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`missing value: ${key}`)
    return String(values[key])
  })
}
