# 搜索与读取工作流

适用于：查 Notion 页面 / 搜 GitHub 仓库或读文件 / 查 Slack 消息 / 找 Drive 文件 / 看邮箱。

## 步骤

1. **确认目标 provider**。用户意图含糊时，用 `connected_app_list` 看有哪些可用；或用一句提问澄清「在哪个服务里找？」。
2. **搜索/列出**：
   - Notion：`notion_search`（query 用用户原词）
   - GitHub：`github_search_repositories`（仓库名关键词）
   - Slack：`slack_list_channels` 拿频道列表
   - Drive：`google_drive_search`（文件名关键词）
   - 邮箱：`qq_mail_list_recent`
3. **读取详情**：
   - Notion 页面 → `notion_fetch_page` 拿 pageId
   - GitHub 文件 → `github_get_file`（owner/repo/path 从上一步结果提取）
   - Slack 消息 → `slack_read_channel` 拿 channelId
   - Drive 文件 → `google_drive_get_file` 拿 fileId
   - 邮件 → `qq_mail_read` 拿 uid
4. **汇总**。给出结论 + 关键条目 + 来源；有截断/分页时说明并主动询问是否继续。

## 错误处理

| 现象 | 处理 |
|---|---|
| `409 not connected` | 停手，引导用户去连接中心启用该服务 |
| `401 OAUTH_REFRESH_REQUIRED` | 提示用户重新授权（连接中心） |
| 搜索 0 结果 | 如实报告；建议换关键词或检查权限 |
| `truncated / hasMore` | 标注截断；按需继续取下一页 |

## 检查点

- [ ] 没有假装成功：结果真实来自工具返回
- [ ] 截断与权限问题如实标注
- [ ] 关键条目带来源（页面名 / 仓库路径 / 频道 / 文件名）
