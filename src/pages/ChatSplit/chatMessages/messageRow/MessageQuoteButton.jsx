import { Quote } from 'lucide-react'
import { copyableMessageText } from '../messageContent.js'

function selectedMessageText(selection, row) {
  if (!row || !selection || selection.isCollapsed || selection.rangeCount !== 1) return ''
  const range = selection.getRangeAt(0)
  const blockFor = (node) => (node.nodeType === 1 ? node : node.parentElement)
    ?.closest?.('[data-quotable="true"]')
  const start = blockFor(range.startContainer)
  const end = blockFor(range.endContainer)
  if (!start || start !== end || !row.contains(start)) return ''
  return selection.toString().trim()
}

export default function MessageQuoteButton({ content, onQuoteSelection, t }) {
  if (typeof onQuoteSelection !== 'function' || !copyableMessageText(content).trim()) return null
  const quote = (event) => {
    const selection = window.getSelection()
    const selected = selectedMessageText(selection, event.currentTarget.closest('[data-message-role]'))
    onQuoteSelection(selected || copyableMessageText(content))
    // Ordinary selection/copy never changes the composer or removes a range.
    // Only this explicit action consumes a range belonging to this message.
    if (selected) selection.removeAllRanges()
  }
  return (
    <button
      type="button"
      data-testid="quote-message"
      className="chat-message-action inline-flex items-center gap-1 text-ink-fade hover:text-ink"
      title={t('nav.quoteSelectionTitle')}
      onMouseDown={(event) => { if (event.button === 0) event.preventDefault() }}
      onClick={quote}
    >
      <Quote className="h-3 w-3" aria-hidden="true" />{t('nav.quoteSelection')}
    </button>
  )
}
