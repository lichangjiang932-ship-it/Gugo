import { Globe2, TerminalSquare } from 'lucide-react'
import { SideChatGlyph } from './SideChatGlyph.jsx'

/** One glyph per tool, shared by the entry page and the header switch. */
export const TOOL_GLYPHS = Object.freeze({
  chat: SideChatGlyph,
  browser: Globe2,
  terminal: TerminalSquare,
})
