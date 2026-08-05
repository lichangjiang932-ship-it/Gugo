---
name: connector-operator
description: >
  Guides the agent through the Access connectors: Notion search/read, GitHub
  repository/file access, Slack channels and messages, Google Drive files, QQ
  Mail send/read, and managed Browser apps. Use when the user asks to search or
  read Notion/GitHub/Slack/Google Drive/QQ Mail, send email via QQ Mail, or
  operate a connected web app such as Gmail/Outlook/Docs/Sheets/Jira. Also use
  when connector tools report "not connected" to guide the user to the Access
  center. Trigger phrases: "查一下我的 Notion/GitHub/Slack/网盘/邮箱",
  "帮我读 GitHub 仓库", "用连接器", "connected_app", "notion_search",
  "qq_mail_send"。
---

# Connector Operator

> 统一调度 Access 中心的原生连接器与受管浏览器应用。所有连接器工具只有在用户已在「连接」页连接并启用对应服务后才可用；未连接时优先引导用户去连接，而不是假装成功。

## 核心纪律

1. **先探测，再假设**。不确定用户已连接哪些服务时，先调用 `connected_app_list` 获取真实可用列表，不要凭记忆假设。
2. **未连接 = 明确告知**。任何连接器工具返回 `ok: false` 或错误 `is not connected or is disabled (409)` 时，**停止后续同类调用**，用一句话告诉用户「去 连接中心 → 打开对应卡片 → 连接并测试」，不要重试轰炸。
3. **只读默认，写操作要确认**。`qq_mail_send` 会真实发信：发送前必须向用户复述收件人、主题与正文概要并取得确认。`connected_app_open` 会打开本机浏览器窗口，属于可见副作用，调用前告知用户。
4. **尊重作用域**。Notion 只能读「已共享给该集成」的页面；Slack 默认只读公开频道；Google Drive 默认只读。拿不到数据时优先怀疑权限，而不是数据不存在。
5. **凭据纪律**。绝不输出、回显或要求用户贴出 token / 授权码；token 只存在于服务端。用户问「我的 token 是什么」时，引导到连接中心管理。
6. **结果裁剪**。大文件 / 长消息列表可能被截断：遇到 `truncated: true` 或分页字段（`hasMore` / `nextCursor` / `nextPageToken`）时，告诉用户存在更多内容，并按需继续读取，不要静默丢弃。

## 工具速查

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `connected_app_list` | 列出已连接且启用的 Browser 应用 | 无 |
| `connected_app_open` | 代操作某个受管浏览器应用 | `provider` |
| `notion_search` | 搜索共享给集成的页面/数据库 | `query` |
| `notion_fetch_page` | 读页面 + 前 100 个块 | `pageId` |
| `github_search_repositories` | 按关键字搜仓库 | `query` |
| `github_get_file` | 读文件或列目录 | `owner` `repo` `path` `ref?` |
| `slack_list_channels` | 列出可见频道 | `limit?` |
| `slack_read_channel` | 读频道近期消息 | `channelId` `limit?` |
| `google_drive_search` | 按名字搜文件 | `query?` `limit?` |
| `google_drive_get_file` | 读文件元数据 + 文本内容 | `fileId` |
| `qq_mail_list_recent` | 列最近邮件 | `limit?` |
| `qq_mail_read` | 按 UID 读单封邮件 | `uid` |
| `qq_mail_send` | 发邮件（需确认） | `to` `subject` `text?` `html?` |

完整语义与每个 provider 的注意点见 `references/connectors.md`。

## 常见工作流

- **搜资料 / 读文件**：先 `connected_app_list` 或直接按目标调用对应搜索工具 → 命中后读取详情 → 汇总给用户。见 `workflows/search-and-read.md`。
- **发邮件（QQ 邮箱）**：先列最近邮件确认身份可用 → 起草内容 → **向用户确认** → 发送 → 回报。见 `workflows/send-message.md`。
- **代操作网页应用**：用户提到 Gmail/Outlook/Docs/Sheets/Jira 等已连接 Browser 应用时，用 `connected_app_open` 打开，再通过浏览器工具完成操作。

## 边界

- 本技能**不创建凭据**、不解析 token，也不替代用户在「连接」页的授权动作。
- 微信/飞书/Telegram 等社交桥不在本技能工具范围内（它们走消息桥渠道）。
- 涉及删除、批量发送、公开可见的写操作一律先确认。
