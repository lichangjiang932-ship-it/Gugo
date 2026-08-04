# Third-Party Notices

Gugo is distributed under the MIT License. The following components retain
their own copyright and license terms. This file is informational and does not
replace the license text shipped by each dependency.

## Vendored browser runtime

These files are committed under `public/sandbox/` so previews also work in
air-gapped environments.

| File | Component | Version | Source | License |
|---|---|---:|---|---|
| `babel.standalone.js` | `@babel/standalone` | 7.29.7 | https://unpkg.com/@babel/standalone@7.29.7/babel.min.js | MIT |
| `react.umd.js` | React development UMD | 18.3.1 | https://unpkg.com/react@18.3.1/umd/react.development.js | MIT |
| `react-dom.umd.js` | ReactDOM development UMD | 18.3.1 | https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js | MIT |
| `tailwind.js` | Tailwind CSS Play CDN | 3.4.17 | https://cdn.tailwindcss.com/3.4.17 | MIT |

Upstream license texts:

- Babel: https://github.com/babel/babel/blob/main/LICENSE
- React and ReactDOM: https://github.com/facebook/react/blob/main/LICENSE
- Tailwind CSS: https://github.com/tailwindlabs/tailwindcss/blob/v3.4.17/LICENSE

The checked-in Babel bundle also includes the upstream
`regenerator-runtime` MIT notice in its source banner.

## Direct production dependencies

Exact installed versions are resolved by `package-lock.json`. The direct
runtime dependency families and declared licenses are:

| Package | License |
|---|---|
| `@e965/xlsx` | Apache-2.0 |
| `@react-three/fiber`, `@react-three/postprocessing` | MIT |
| `@tailwindcss/typography` | MIT |
| `better-sqlite3` | MIT |
| `framer-motion` | MIT |
| `highlight.js` | BSD-3-Clause |
| `html-to-image` | MIT |
| `jsdom` | MIT |
| `jszip` | MIT OR GPL-3.0-or-later; Gugo uses it under MIT |
| `lucide-react` | ISC |
| `pptxgenjs` | MIT |
| `qrcode` | MIT |
| `react`, `react-dom` | MIT |
| `react-markdown`, `rehype-highlight`, `rehype-sanitize`, `remark-gfm` | MIT |
| `three` | MIT |
| `undici` | MIT |
| `zod` | MIT |

Run `npm run licenses` after dependency changes. The command inspects every
package in the production lock graph and fails on missing, unknown, or
non-allowlisted license metadata.
