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

## Bundled Windows media sidecars

The Windows desktop installer contains separate `ffmpeg.exe` and `ffprobe.exe`
sidecars. They are staged at release time from exact npm development
dependencies; the large executable files are intentionally not committed to
this repository.

| Sidecar | Resolver wrapper | Windows binary package | Exact reported build | Build source | Binary license |
|---|---|---|---|---|---|
| `ffmpeg.exe` | `@ffmpeg-installer/ffmpeg@1.1.0` | `@ffmpeg-installer/win32-x64@4.1.0` | `N-92722-gf22fcd4483` (`20181217-f22fcd4`) | [Zeranoe Windows 64-bit static build recorded by the package](https://www.npmjs.com/package/@ffmpeg-installer/win32-x64/v/4.1.0) | GNU General Public License version 3 |
| `ffprobe.exe` | `@ffprobe-installer/ffprobe@2.1.2` | `@ffprobe-installer/win32-x64@5.1.0` | `2023-02-13-git-2296078397-essentials_build-www.gyan.dev` (`20230213-2296078`) | [Gyan.dev Windows build](https://www.gyan.dev/ffmpeg/builds/) | GNU General Public License version 3 |

Both binaries report builds configured with `--enable-gpl` and
`--enable-version3`. The wrapper JavaScript packages declare LGPL-2.1, but
that does not replace the GPLv3 terms of the bundled executables. Corresponding
FFmpeg source revisions are available at
[`f22fcd4483`](https://github.com/FFmpeg/FFmpeg/tree/f22fcd4483) and
[`2296078397`](https://github.com/FFmpeg/FFmpeg/tree/2296078397). The complete
GPLv3 text is shipped as `resources/licenses/GPL-3.0.txt`; hashes and detailed
staging provenance are in `resources/licenses/FFMPEG-SIDECARS.md`.

## Sharp and libvips

Image transforms use `sharp@0.35.3` (Apache-2.0). Its platform packages ship
prebuilt libvips shared libraries under `LGPL-3.0-or-later`; the exact package
selected by npm depends on the operating system and CPU architecture. Gugo
loads these as replaceable shared libraries and does not modify libvips.

The complete LGPLv3 supplement and the incorporated GPLv3 terms are shipped as
`resources/licenses/LGPL-3.0.txt` and `resources/licenses/GPL-3.0.txt`.
Corresponding libvips source is available from
[libvips/libvips](https://github.com/libvips/libvips); Sharp's platform build
and packaging sources are available from
[lovell/sharp](https://github.com/lovell/sharp). The installed npm platform
package also records its precise binary and dependency versions.

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
| `fontkit` | MIT |
| `highlight.js` | BSD-3-Clause |
| `html-to-image` | MIT |
| `jsdom` | MIT |
| `jszip` | MIT OR GPL-3.0-or-later; Gugo uses it under MIT |
| `lucide-react` | ISC |
| `node-unrar-js` | MIT; bundles the official UnRAR source under the upstream UnRAR source license |
| `pdf-lib` | MIT |
| `pdfjs-dist` | Apache-2.0 |
| `pptxgenjs` | MIT |
| `qrcode` | MIT |
| `react`, `react-dom` | MIT |
| `react-markdown`, `rehype-highlight`, `rehype-sanitize`, `remark-gfm` | MIT |
| `sharp` | Apache-2.0; platform libvips shared libraries are LGPL-3.0-or-later |
| `three` | MIT |
| `undici` | MIT |
| `zod` | MIT |

## Bundled PDF font

`server/assets/fonts/NotoSansSC-Regular.ttf` is a weight-400 static instance of
Noto Sans SC from Google Fonts. It is redistributed under the SIL Open Font
License 1.1 so PDF watermarks, text overlays, and form appearances can embed
Chinese glyphs without relying on host fonts. The complete license, source,
conversion details, and checksum are shipped beside the font in
`server/assets/fonts/OFL.txt` and `server/assets/fonts/README.md`.

Run `npm run licenses` after dependency changes. The command inspects every
package in the production lock graph and fails on missing, unknown, or
non-allowlisted license metadata.
