# Sandbox runtime assets

本目录的 JS 文件由 `src/pages/ChatSplit/RightPreviewPane.jsx` 的 React 预览 iframe 通过相对路径
`/sandbox/<file>` 加载，目的是让预览在 air-gapped / CN 屏蔽 unpkg 的环境下也能跑。

Vite 的 `publicDir` 会把整个 `public/` 直接复制到 `dist/`，所以构建产物里会有 `dist/sandbox/*`，
线上由同源静态服务提供，CSP `script-src 'self'` 即可放行。

## 版本与来源

| 文件 | 版本 | 来源 URL | 抓取日期 |
| --- | --- | --- | --- |
| `react.umd.js` | react 18.3.1 (development) | https://unpkg.com/react@18/umd/react.development.js | 2026-05-30 |
| `react-dom.umd.js` | react-dom 18.3.1 (development) | https://unpkg.com/react-dom@18/umd/react-dom.development.js | 2026-05-30 |
| `babel.standalone.js` | @babel/standalone 7.29.7 (minified) | https://unpkg.com/@babel/standalone/babel.min.js | 2026-05-30 |
| `tailwind.js` | tailwindcss play CDN 3.4.17 | https://cdn.tailwindcss.com/3.4.17 | 2026-05-30 |

## 更新方法

```bash
cd public/sandbox
curl -fsSL -o react.umd.js          https://unpkg.com/react@18.3.1/umd/react.development.js
curl -fsSL -o react-dom.umd.js      https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js
curl -fsSL -o babel.standalone.js   https://unpkg.com/@babel/standalone@7.29.7/babel.min.js
curl -fsSL -o tailwind.js           https://cdn.tailwindcss.com/3.4.17
```

然后更新上表的版本号 + 抓取日期，commit。
