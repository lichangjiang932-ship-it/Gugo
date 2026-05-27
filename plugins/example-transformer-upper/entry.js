function transform(input) {
  if (typeof input === 'string') return input.toUpperCase()
  if (input && typeof input === 'object' && typeof input.text === 'string') {
    return { text: input.text.toUpperCase() }
  }
  return input
}
