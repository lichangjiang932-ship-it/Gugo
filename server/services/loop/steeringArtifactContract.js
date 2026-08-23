const STEERING_ARTIFACT_TERMS = new Map([
  ['create_html_app', '(?:网页|网站|页面|HTML(?:\\s*(?:文件|页面))?|web(?:site|page)|site)'],
  ['create_pptx', '(?:PPTX?|幻灯片|演示文稿|PowerPoint|slide(?:\\s*deck)?)'],
  ['create_docx', '(?:DOCX?|Word(?:\\s*document)?|文档|报告文件)'],
  ['create_xlsx', '(?:XLSX?|Excel|电子表格|工作簿|spreadsheet|workbook)'],
  ['create_pdf', '(?:PDF(?:\\s*(?:文件|文档))?)'],
  ['generate_image', '(?:图片|图像|插图|海报|image|picture)'],
])

export function cancelledArtifactToolsFromSteering(value) {
  const text = String(value || '')
  const cancelled = new Set()
  for (const [toolName, term] of STEERING_ARTIFACT_TERMS) {
    const explicitCancellation = new RegExp([
      `(?:不要|不再|停止|别|不用|不需要)(?:再|继续)?\\s*(?:生成|创建|制作|输出|导出|交付|调用)\\s*(?:(?:任何|新的?|一张|一个|一份)\\s*)*${term}`,
      `(?:取消|放弃|去掉|删除|无需|不必|不再需要)\\s*(?:生成|创建|制作|输出|导出|交付)?\\s*(?:(?:任何|新的?|一张|一个|一份)\\s*)*${term}`,
      `不要\\s*(?:(?:任何|新的?|一张|一个|一份)\\s*)*${term}(?:文件|产物)?(?:了|啦)?(?=[，,。；;！!？?\\s]|$)`,
      `${term}\\s*(?:不要|无需|不必|不再)\\s*(?:生成|创建|制作|输出|导出|交付)`,
      `(?:do\\s+not|don't|no\\s+longer|stop|cancel)\\s+(?:create|generate|make|export|deliver|produce)\\s+(?:a\\s+|an\\s+|any\\s+|new\\s+)?${term}`,
    ].join('|'), 'i')
    if (explicitCancellation.test(text)) cancelled.add(toolName)
  }
  return cancelled
}

export function steeringDefinesExclusiveArtifactContract(value, detectedTools) {
  if (!(detectedTools instanceof Set) || detectedTools.size === 0) return false
  const text = String(value || '')
  return /(?:只|仅)(?:需|需要|要|生成|创建|制作|输出|导出|交付|保留|使用|用)|(?:改为|换成|替换为)\s*(?:只|仅)?|\bonly\b|\binstead\b/i.test(text)
}
