const message = [
  'Direct desktop publishing is disabled.',
  'Push a matching v*.*.* tag (or dispatch the Release workflow for an existing tag)',
  'so CI gates, code-signature verification, checksums, provenance, and immutable release checks all run.',
].join(' ')

process.stderr.write(`${message}\n`)
process.exitCode = 1
