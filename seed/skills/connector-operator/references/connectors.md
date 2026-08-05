# 连接器参考手册

> 每个 provider 的语义、注意点与常见坑。工具签名以服务端实际注册为准。

## 通用

- 所有连接器工具都要求用户已登录且该服务在「连接」页为**已连接 + 已启用**。
- 错误码：
  - `409 ... is not connected or is disabled` → 未连接或已停用，引导用户去连接中心。
  - `401 OAUTH_REFRESH_REQUIRED` → OAuth token 已过期且无法续期，提示用户在连接中心重新授权。
  - `502` → 上游 API 失败，可稍后重试一次。
  - `400/404` → 参数问题（如无效 pageId / channelId / 路径），检查参数格式。

## Notion（notion_search / notion_fetch_page）

- 只能读取**已共享给该 Integration** 的页面/数据库；没共享 = 搜索不到。
- `notion_fetch_page` 只返回前 100 个 child blocks；`hasMore: true` 表示还有更多，需要时可提示用户。
- 页面 ID 是 32 位十六进制（可含 `-` 分隔），取自 URL：`notion.so/<workspace>/<32hex>?v=...`。
- 数据库页面用 `properties.title.title[].plain_text` 拼标题；不要假设字段名。

## GitHub（github_search_repositories / github_get_file）

- `github_get_file` 传 `owner` / `repo` / `path`；`ref` 可选（分支/commit/tag）。
- 路径为仓库内相对路径；`path` 指向目录时返回目录列表（`type: 'directory'`）。
- 私有仓库需要用户 PAT 授予该仓库权限；`private: true` 的结果不要外传。
- 搜索按仓库维度，不是代码内容搜索。

## Slack（slack_list_channels / slack_read_channel）

- `slack_list_channels` 默认只返回**公开频道** + 机器人已加入的私有频道（受 OAuth 默认 scope 限制）。
- `slack_read_channel` 需要 `channelId`（形如 `C123ABC`，不是频道名）；先从 list 结果拿 ID。
- 消息按时间倒序返回；`hasMore` 表示还有更早的消息。
- 不要在频道里发送任何内容——本连接器没有发消息工具。

## Google Drive（google_drive_search / google_drive_get_file）

- 默认 scope 只读（`drive.readonly`）；OAuth 续期由服务端自动完成。
- `google_drive_get_file`：Google 原生文档/表格/幻灯片会自动导出为文本；纯文本/JSON/CSV 直接读取；其他二进制文件返回 `binary: true` 且无内容。
- 搜不到文件时优先怀疑权限与 scope，而不是文件不存在。
- 大文件内容可能被截断（`truncated: true`），如实标注。

## QQ Mail（qq_mail_list_recent / qq_mail_read / qq_mail_send）

- `qq_mail_list_recent` 返回最近邮件元数据；`qq_mail_read` 按 `uid` 读单封全文。
- `qq_mail_send` 是**真实发信**：发信前必须向用户确认收件人、主题、正文概要。
- `to` 支持单个地址或数组；`text` 与 `html` 至少提供一个。
- 授权码不是 QQ 登录密码；账号未连接时在连接中心填写「QQ 邮箱授权码」。

## 受管浏览器应用（connected_app_list / connected_app_open）

- 覆盖 Gmail / Outlook / Slack / Teams / WhatsApp / Docs / Sheets / Drive / Jira / Trello 等浏览器应用。
- `connected_app_open` 会打开（或恢复）本机受管浏览器窗口并登录对应网站；`provider` 形如 `web_gmail`、`web_google_docs`。
- 打开后通过浏览器工具（点击、输入、截图、读页面）完成操作；受管会话长期保持，异常退出会自动恢复。
- 浏览器应用**不是**原生 API：能力边界 = 浏览器里能做的事。

## 隐私与合规

- 外部数据（私有仓库代码、邮件内容、Drive 文件）默认只在本会话使用，不要写入公开位置或转发给第三方。
- 需要把外部内容写进文件/网页产物时，先问用户是否包含敏感信息。
- 用户询问凭据/密钥时：引导到「连接」页管理，绝不代查、绝不输出。
