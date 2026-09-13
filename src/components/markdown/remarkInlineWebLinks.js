function exactWebUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value) || /\s/.test(value)) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password
  } catch { return false }
}

/** Models often backtick a source URL. Link only that entire safe URL, never code or commands. */
export default function remarkInlineWebLinks() {
  return (tree) => {
    function visit(node) {
      if (!Array.isArray(node?.children) || ['link', 'linkReference', 'code'].includes(node.type)) return
      node.children = node.children.map((child) => {
        if (child.type === 'inlineCode' && exactWebUrl(child.value)) {
          return { type: 'link', url: child.value, children: [{ type: 'text', value: child.value }] }
        }
        visit(child)
        return child
      })
    }
    visit(tree)
  }
}
