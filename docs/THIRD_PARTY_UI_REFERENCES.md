# UI reference attribution

Gugo's host UI refinement consulted and adapted interaction ideas, mask stop values and segmented-control geometry from:

- Project: open-claude-ui
- Author: Caho1
- Source: https://github.com/Caho1/open-claude-ui
- Pinned revision: `2834bc158a4849f21c97cbb2e0b10525f6e646f1`
- Relevant files: `code-examples/ScrollFadeContainer.tsx`, `code-examples/useClaudeScrollPinning.ts`, `code-examples/SegmentedControl.tsx`, `code-examples/CdsButton.tsx`, `code-examples/McpToolDecisionCard.tsx`, `docs/03-会话核心流与指令交互引擎.md`
- Gugo adaptations: `src/lib/scrollPinning.js`, `src/components/ui/ScrollFadeContainer.*`, `src/components/ui/Segmented.*`

The local checkout at `D:/open-claude-ui` was also verified at this revision. Its decision-card example contains a simulated 1200ms transition to success; Gugo does not copy that simulation, its permission logic or its brand palette. The implementations are adapted to Gugo's own state, accessibility, token and lifecycle contracts. This does not assert independent verification of every reverse-engineering claim made by the reference project. No Anthropic binaries, fonts, icons, audio or private application data are redistributed.

## Upstream license

MIT License

Copyright (c) 2026 Caho1

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
