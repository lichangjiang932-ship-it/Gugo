import fs from 'node:fs'

export function readSourceTree(url) {
  const path = new URL(url, import.meta.url)
  const stat = fs.statSync(path)
  if (stat.isFile()) return fs.readFileSync(path, 'utf8')
  return fs.readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || /\.(?:js|jsx)$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => readSourceTree(new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, path)))
    .join('\n')
}
