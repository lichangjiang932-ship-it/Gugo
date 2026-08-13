/**
 * 后台 Job 的提示词块（单一来源）。
 *
 * 以前这些块直接内联在 jobRuntime.createDefaultExecuteStep 里 —— artifact 规则、
 * 代码工作流、延迟唤醒,几十行硬编码文案散在流程中间。抽到这里:
 *   - jobRuntime 只负责按顺序拼装,文案全部从这里出
 *   - 新增/修改提示词有单一落点,并且能单独测试
 *
 * 纯函数、无 IO、无副作用,符合 services/ 红线(不 import routes/react)。
 */

/**
 * 文件产物提示词。artifactTools 是 allowedArtifactTools() 返回的 Set,
 * 只有用户明确要了某种产物时才注入对应规则 —— 修 bug 的任务不会再被推去做 PPT。
 */
export function buildArtifactPrompt(artifactTools) {
  const lines = []
  if (artifactTools.size) {
    const available = [
      artifactTools.has('create_pptx') ? 'create_pptx (PowerPoint)' : null,
      artifactTools.has('create_docx') ? 'create_docx (Word)' : null,
      artifactTools.has('create_xlsx') ? 'create_xlsx (Excel)' : null,
      artifactTools.has('create_html_app') ? 'create_html_app (HTML)' : null,
      artifactTools.has('generate_image') ? 'generate_image (image)' : null,
    ].filter(Boolean)
    lines.push(
      `用户明确要了可下载的文件产物,你可以调用:${available.join('、')}。`,
      '把内容完整填好再调用。文件生成后仍要用文字说明做了什么、结论是什么 —— 文件不能代替回答。',
    )
  } else {
    lines.push(
      '本次未匹配到专用的 PowerPoint / Word / Excel 产物生成器；这不代表通用文件或 Shell 能力不可用。',
      '始终以本轮实际工具列表为准。若用户要求修改或生成其他格式，使用已列出的写入、Shell 或其他执行工具完成并验证。',
    )
  }

  if (artifactTools.has('create_pptx')) {
    lines.push(
      '',
      '【高级 PPT 必守规则】(create_pptx 时强制)',
      '1. 配色、版式、字体由系统控制,你只给文字 + 数据,不要在 bullet 里堆 emoji/装饰符号。',
      '2. 标题 ≤ 14 字、结论式("X 增长 Y%" 而不是 "X 的情况");bullet ≤ 30 字、动词开头、含数字。',
      '3. 单页 bullet ≤ 4 条,超出请拆页。短句胜过长段。',
      '4. 必须用 layout 字段控制版式:cover(封面) / section(章节页) / kpi(数据卡 — 传 kpi 数组) / chart(图表 — 传 chart 字段) / statement(单点结论大字) / split(双栏对比) / process(横向流程) / quote(引用) / bullets(常规要点) / end(感谢页)。',
      '5. 6 页以上的 deck 至少含 1 个 layout="section" 章节分隔 + 至少 1 个 kpi 或 chart。',
      '6. cover 不要叫"封面";直接用真实主题作 title,系统会自动用 deck title 显示大字。',
      '7. theme 字段按主题选: noir(默认/科技) / paper(文档/品牌) / ocean(金融/咨询) / forest(可持续/医疗)。',
    )
  }
  return lines.join('\n')
}

/** 代码工作流提示词:理解/编辑/反思/诚实/求助/授权/失败处理。 */
export function buildCodeWorkflowPrompt() {
  return [
    '【代码工作流】',
    '代码理解：遇到"这个函数/类在哪"先调 find_symbol；需要全文搜索用 grep_code；看依赖用 list_imports。不要盲用 bash_exec("grep -r ...")。',
    '代码编辑：多文件/不可分割的改动优先用 apply_patch（原子，任一失败自动回滚）。不确定时先传 dry_run=true 预览。',
    '反思节奏：多步任务先 manage_todos 拆分；每完成一个关键动作后调一次 reflect 复盘（事实/下一步/confidence）。',
    '完成度诚实：manage_todos 只有在对应动作真的成功后才能标 completed。有工具失败、验证没跑通或结果没确认时，保持 in_progress 并在文字里说明卡在哪，不要为了让进度好看而全部标完成。',
    '遇阶求助：出现歧义、缺信息、需授权、有风险决策时，调 request_clarification 问用户而不是编造。问具体可决策的细节，能给选项就给。',
    '目录授权：需要访问尚未授权的本地目录时，调 request_directory；修改/创建/删除文件必须请求 read_write，只读分析才请求 read_only。它会挂起当前 Job，授权后原 Job 原地继续。',
    '写入失败：收到 PATH_NOT_WRITABLE / FILESYSTEM_WRITE_DENIED 后立即停止在同一根目录改试 src、.tmp、output；这是确定性权限失败。保留任务进度并请求用户修复该目录权限，不要把未完成工作说成已完成。',
  ].join('\n')
}

/** 延迟唤醒:用 sleep_until 原地续跑,而不是另起一个 cron。 */
export function buildDelayedFollowupPrompt() {
  return 'For delayed follow-ups, use sleep_until. It resumes this same durable Job with the same conversation and tool state; do not create a separate cron task.'
}

/**
 * 引用与超链接引导(C3 新增):让模型在提到来源/文件/URL 时给出可点击的引用,
 * 而不是只吐纯文本。前端 MarkdownRenderer 已支持 target=_blank 的链接。
 */
export function buildCitationPrompt() {
  return [
    '【引用与链接】',
    '回复中提到来源、网页、文档、文件时，优先用 Markdown 链接给出可点击引用，例如 [标题](https://...) 或 [文件名](相对路径)。',
    '引用本地文件给出相对工作区路径；引用网页/文档给出完整 URL；给出结论性数字或事实时附上来源链接。',
    '不要只写纯文本路径或「见上文」；能跳转的链接能显著减少用户来回确认。',
  ].join('\n')
}
