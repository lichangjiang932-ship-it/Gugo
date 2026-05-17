# 2026-05-17 ppt visual system upgrade design

## Goal
Raise the visual quality of both built-in presentation skills so generated decks feel designed rather than merely typeset.

## Current diagnosis
- `ppt` uses a restrained fixed visual template. It is legible, but many slides share the same pale background and sparse accent treatment.
- `htmlppt` already has richer primitives, but its prompt biases outputs toward one dark-tech aesthetic, so many decks converge on the same look.

## Recommended approach
Upgrade prompts and renderers together.

## Design
### 1. Standard PPT (`ppt`)
- Introduce multiple theme families rather than one palette:
  - tech blue-violet
  - warm business orange
  - finance green
  - consumer coral
- Let generated decks choose a theme from topic cues while keeping export deterministic.
- Enrich core slide templates with restrained decoration:
  - layered background gradients
  - corner badges / eyebrow labels
  - geometric shapes and translucent blobs
  - ribbons / side panels / section numerals
  - more differentiated cover, section, data, chart, and content slides
- Keep the existing information architecture and readability constraints intact.

### 2. Premium HTML PPT (`htmlppt`)
- Broaden the prompt from one dark-tech style into topic-aware visual systems.
- Require each deck to combine multiple visual ingredients, for example:
  - gradient fields
  - glow layers
  - grids or dot textures
  - geometric motifs
  - card layouts
  - KPI badges
  - image or illustration placeholders
- Require visual variety across the deck so consecutive slides differ in background, layout, or focal device.
- Preserve single-file HTML, keyboard navigation, responsive layout, and PPTX conversion compatibility.

### 3. Guardrails
- Richer, not noisier: visual elements must support hierarchy and never reduce text contrast.
- Decorations should remain theme-consistent inside one deck.
- Avoid gimmicks that break export fidelity or make office decks feel like landing pages.

## Testing
- Add parser / prompt regression tests where useful.
- Add renderer-level tests that verify multiple themes are available and preview generation still works.
- Re-run full tests, lint, and build.

## Out of scope
- User-facing theme picker UI
- Third-party image generation
- Replacing the current PPTX export architecture
