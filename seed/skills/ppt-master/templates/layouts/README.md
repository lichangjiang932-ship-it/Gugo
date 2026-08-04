# Page Layout Template Library (7 Templates)

Pre-built, general-purpose PPT page layouts supporting multiple styles and use
cases. The lightweight machine-readable index is in `layouts_index.json`.

> Template selection is opt-in by explicit path. The main workflow defaults to
> free design. A template is used only when the user gives an explicit template
> directory path in the initial message.

## Distribution boundary

This directory intentionally contains only general-purpose, project-owned
layout templates. Customer-specific templates, registered trademarks,
corporate identity assets, institutional logos, and internal delivery
specifications are not part of the open-source distribution. Keep such assets
in a separately authorized private asset pack and review its license and
confidentiality terms before use.

## Template index

| Template | Use cases | Design tone |
|---|---|---|
| `academic_defense` | Thesis defense, research reports, grant applications | Rigorous, clear hierarchy |
| `ai_ops` | AI operations, IT architecture, infrastructure reports | Structured, modular, information-dense |
| `government_blue` | Planning, project, and policy briefings | Formal, modern, blue |
| `government_red` | Work summaries and public-sector briefings | Authoritative, dignified, red |
| `medical_university` | Medical reports, case discussions, clinical education | Professional, trustworthy |
| `pixel_retro` | Tech talks, tutorials, creative showcases | Retro, pixel, playful |
| `psychology_attachment` | Psychology training, lectures, case analysis | Warm, calm, professional |

## Template file structure

Each template contains these standard files. A table-of-contents page is
optional.

| Filename | Required | Purpose |
|---|---|---|
| `design_spec.md` | Yes | Color, typography, spacing, and layout specification |
| `01_cover.svg` | Yes | Cover page |
| `02_toc.svg` | No | Table of contents |
| `02_chapter.svg` | Yes | Chapter divider |
| `03_content.svg` | Yes | Flexible content page |
| `04_ending.svg` | Yes | Closing page |

Templates define visual consistency and structural pages. Content pages keep a
flexible content area so the executor can choose the layout that best fits the
actual material.

## Placeholder contract

New templates use `{{PLACEHOLDER}}` markers.

| Placeholder | Purpose |
|---|---|
| `{{TITLE}}`, `{{SUBTITLE}}` | Cover title and subtitle |
| `{{DATE}}`, `{{AUTHOR}}` | Cover or closing metadata |
| `{{CHAPTER_NUM}}`, `{{CHAPTER_TITLE}}` | Chapter marker and title |
| `{{PAGE_TITLE}}`, `{{CONTENT_AREA}}` | Content title and flexible body |
| `{{PAGE_NUM}}`, `{{SOURCE}}` | Footer metadata |
| `{{TOC_ITEM_1_TITLE}}` … `{{TOC_ITEM_N_TITLE}}` | Table-of-contents entries |
| `{{THANK_YOU}}`, `{{CONTACT_INFO}}` | Closing content |

## Usage

Give the AI an explicit directory path, for example:

```text
Use skills/ppt-master/templates/layouts/academic_defense/ for this deck.
```

The workflow copies the directory's SVG files, design specification, and
authorized local assets into the project before the strategist phase begins.
Bare template names do not trigger automatic copying.

## Developing a general-purpose template

1. Create a directory under `templates/layouts/`.
2. Add the required files from the structure above.
3. Use `viewBox="0 0 1280 720"` in every SVG.
4. Keep all styling inline; do not use scripts, animation, `foreignObject`, or
   remote assets.
5. Use clear placeholder markers and register the template in
   `layouts_index.json`.
6. Confirm the template contains no third-party logos, confidential delivery
   material, or organization-specific identity system.

## SVG compatibility rules

- Prefer native SVG geometry and `<text>` with `<tspan>`.
- Escape XML-sensitive characters in text and attributes.
- Use HEX colors with `fill-opacity` or `stroke-opacity`; do not use `rgba()`.
- Do not use `<style>`, CSS classes, `<script>`, `mask`, `textPath`, or animated
  elements.
- `clipPath` is allowed only for image geometry where the renderer requires it.
- Keep content inside the 1280×720 canvas and verify the result in the target
  presentation renderer.
