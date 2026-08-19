export const PPT_SKILL_ID_ALIASES = Object.freeze([
  'ppt',
  'ppt-master',
  'axippt',
  'htmlppt',
  'guizang-ppt',
])

const PPT_SKILL_ID_ALIAS_SET = new Set(PPT_SKILL_ID_ALIASES)

export function canonicalizeSkillId(skillId) {
  const value = String(skillId ?? '').trim()
  if (!value) return null
  return PPT_SKILL_ID_ALIAS_SET.has(value.toLowerCase()) ? 'ppt' : value
}

const SKILL_ARTIFACT_TOOL = Object.freeze({
  ppt: 'create_pptx',
  doc: 'create_docx',
  excel: 'create_xlsx',
  webpage: 'create_html_app',
  pdf: 'create_pdf',
  image: 'generate_image',
})

// 常见 PPT/文档/表格类技能 ID → 文件工具映射。技能前缀（如 /ppt-master 做演示）
// 在 skillId 无法精确命中时按关键词判定，而"做演示"这类短指令没有 artifact 名词，
// 会漏解锁；这里把已知技能 ID 显式归类，前缀命中即解锁对应工具。
const SKILL_ID_ALIASES = Object.freeze({
  doc: ['doc', 'write-doc'],
  excel: ['excel', 'analyze-excel'],
  webpage: ['webpage', 'html', 'website'],
  pdf: ['pdf'],
  image: ['image', 'imagegen', 'image-gen'],
})

export function resolveArtifactToolForSkillId(skillId) {
  const id = String(canonicalizeSkillId(skillId) || '').toLowerCase()
  if (SKILL_ARTIFACT_TOOL[id]) return SKILL_ARTIFACT_TOOL[id]
  for (const [kind, aliases] of Object.entries(SKILL_ID_ALIASES)) {
    if (aliases.includes(id)) return SKILL_ARTIFACT_TOOL[kind]
  }
  return null
}

const ARTIFACT_TERMS = Object.freeze({
  pptx: /\bpptx?\b|\.pptx?\b|power\s*point|幻灯片|演示文稿|演示稿|路演稿|slide\s*deck|\bslides?\b/gi,
  docx: /\bdocx?\b|\.docx?\b|\bword\b|word\s*文档|文档|报告|会议纪要|纪要|周报|合同|简历|document|report|minutes/gi,
  xlsx: /\bxlsx?\b|\.xlsx?\b|\bexcel\b|工作簿|电子表格|spread\s*sheet/gi,
  html: /\bhtml?\b|\.html?\b|\bweb\s*page\b|\bwebsite\b|\blanding\s*page\b|网页|网站|落地页/gi,
  pdf: /\bpdf\b|\.pdf\b|便携式文档/gi,
  image: /\bimages?\b|\bpictures?\b|\bphotos?\b|\billustrations?\b|\bposters?\b|\blogos?\b|\bmarketing\s+(?:images?|graphics?|art)\b|\bcover\s+art\b|\bhero\s+art\b|\u56fe\u7247|\u56fe\u50cf|\u63d2\u56fe|\u63d2\u753b|\u914d\u56fe|\u6d77\u62a5|\u8425\u9500\u56fe|\u5ba3\u4f20\u56fe|\u5e7f\u544a\u56fe|\u5c01\u9762\u56fe|\u5fbd\u6807|(?:\u54c1\u724c)?\u6807\u5fd7/gi,
})

const BEFORE_ACTION = /(?:帮我|请|麻烦|给我|我要|我需要|我想要|希望|来(?:一|个|份|套)?|写|编写|撰写|做|制作|生成|创建|输出|导出|整理成|转换成|转换为|转成|转为|改成|改为|做成|放入|放进|加入|写入|整理到|设计|起草|重做|重制|修改|编辑|更新|优化|润色|make|create|generate|build|produce|export|convert|design|draft|prepare|write|revise|edit|update|redesign|give\s+me|i\s+(?:want|need))[^。！？!?\n]{0,32}$/i
const AFTER_ACTION = /^[^，,；;。！？!?\n]{0,12}(?:写|编写|撰写|做|制作|生成|创建|输出|导出|重做|修改|编辑|更新|优化|润色|make|create|generate|export|edit|update)/i
const DIRECT_NEGATION = /(?:不要|不再|别再?|禁止|避免|无需|不用|不需要|不可|不能|不应|不想要|勿|拒绝|防止|阻止|确保不会|没有要求|没要求|没有让|没让|未要求|(?:没有|没|未)(?:有)?说(?:过)?(?:要)?|without|do\s+not|don't|dont|never|avoid|prevent|stop|must\s+not|should\s+not|no\s+need\s+to)[^，,；;。！？!?\n]{0,28}$/i
const AUTO_OR_ACCIDENTAL = /(?:自动|随意|擅自|自行|莫名|错误|意外|偷偷|被|乱)[^。！？!?\n]{0,10}(?:生成|制作|创建|输出|导出|变成|转成|generate|create|make|export)[^。！？!?\n]{0,8}$/i
const META_QUESTION = /(?:为什么|为何|怎么会|怎会|如何避免|排查|检查|调查|修复|解决|防止|阻止|关于|提到|讨论|解释|原因|问题|bug|逻辑|代码|工具|why|how\s+did|fix|debug|investigate|prevent|stop|about|discuss)[^。！？!?\n]{0,28}$/i
const CAPABILITY_QUESTION = /(?:能不能|能否|可以不可以|是否可以|会不会|能|可以)[^。！？!?\n]{0,8}(?:生成|制作|创建|导出)[^。！？!?\n]{0,4}$/i
const NEGATION_AFTER = /^[^，,；;。！？!?\n]{0,10}(?:不要|不用|不需要|禁止|别|无需|不可|不能|do\s+not|don't|dont|never|not\s+needed)/i
const META_AFTER = /^[^。！？!?\n]{0,12}(?:问题|bug|逻辑|代码|工具|为什么|为何|自动生成|误生成|被生成|乱生成|随意生成|problem|issue|bug|logic|tool)/i
const GLOBAL_DENIAL = /(?:没有|没|未)(?:有)?(?:说(?:过)?(?:要)?|让|要求|叫|授权)[^。！？!?\n]{0,24}(?:生成|制作|创建|输出|导出|变成|转成)|(?:i\s+did(?:\s+not|n't)|without\s+me)\s+(?:ask|request|authoriz|say|tell)[^.!?\n]{0,24}(?:creat|generat|mak|export)/i
// “请报告真实 exitCode / report the test result” asks the assistant to
// state execution evidence in chat. `报告` / `report` is a verb there, not
// a request for a downloadable Word document. Explicit authoring phrases
// (生成报告 / write a report) remain eligible for DOCX.
const RESULT_REPORT_OBJECT = /^[\s:：]*(?:(?:the\s+)?(?:real|actual|current|final|latest|specific)\s+|(?:真实|实际|当前|最终|最新|具体|本次)\s*)?(?:(?:test|check|verification|execution)\s+|(?:测试|检查|验证|执行)\s*)?(?:exit\s*code|exitcode|stdout|stderr|status|results?|progress|outcome|error|reason|findings?|退出码|结果|状态|进度|错误|异常|原因|结论|输出)/i
const ARTIFACT_PRODUCTION_BEFORE = /(?:写(?:一|1)?份?|做|编写|撰写|制作|生成|创建|导出|整理成|转换成|转换为|转成|转为|改成|改为|做成|放入|放进|加入|写入|整理到|make|create|generate|produce|export|draft|prepare|write|build|convert)(?:[^。！？?!\n]{0,24})$/i
const ARTIFACT_INPUT_ACTION_BEFORE = /(?:使用|用|利用|采用|基于|根据|参考|读取|查看|浏览|分析|导入|引用|展示|显示|包含|收录|把|将|来自|从|use|using|with|from|read|inspect|browse|analy[sz]e|reference|based\s+on|import|include|show|display)(?:[^。！？!?；;\n]{0,32})$/i
const ARTIFACT_INPUT_AFTER = /^[^。！？!?；;\n]{0,20}(?:作为|用作|用于|放入|放进|加入|展示在|显示在|写入|整理到|生成|制作|创建|写|编写|撰写|as\s+(?:an?\s+)?(?:input|source|reference)|into|to\s+(?:build|create|write|make)|for\s+(?:a|the)?\s*(?:website|webpage|document|deck|presentation))/i
const ARTIFACT_COMPOUND_MODIFIER_AFTER = /^(?:展示|浏览|查看|画廊|图库|图片墙|管理|检索|搜索|gallery|viewer|browser|catalog|library|list)(?:网站|网页|页面|系统|工具|应用|app|website|webpage|page)?/i
const ARTIFACT_OUTPUT_RELATION_BEFORE = /(?:把|将)[^。！？!?；;\n]{1,48}(?:作为|用作|设为|设置为|设成|当作)[^。！？!?；;\n]{0,12}$/i
const PDF_TO_IMAGE_CONVERSION = /(?:\b(?:convert|render|export)\b[^。！？!?;\n]{0,64}\bpdf\b[^。！？!?;\n]{0,32}\b(?:to|into|as)\b[^。！？!?;\n]{0,24}\b(?:images?|pictures?|png|jpe?g|webp)\b|(?:把|将)?[^。！？!?；;\n]{0,24}(?:pdf|\.pdf)[^。！？!?；;\n]{0,24}(?:转(?:换)?(?:成|为)|导出(?:成|为)|渲染(?:成|为)|生成)[^。！？!?；;\n]{0,16}(?:图片|图像|png|jpe?g|webp))/i
const SKILL_PREFIX = /^\/([a-z0-9_-]+)(?:\s|$)/i

// A slash artifact skill is a delivery contract, not merely another keyword.
// Keep it on its own generator unless the prompt clearly asks for an
// additional *file format*. This prevents content phrases such as
// "/webpage ... quarterly report" from silently turning one webpage into both
// HTML and DOCX, while still allowing "/webpage ... and a Word document".
const ADDITIONAL_ARTIFACT_CUE = /(?:\b(?:also|and|plus|both|too|as\s+well\s+as|along\s+with|additionally|separately)\b|\u540c\u65f6|\u53e6\u5916|\u53e6\u52a0|\u4ee5\u53ca|\u5e76\u4e14|\u518d(?:\u751f\u6210|\u521b\u5efa|\u5236\u4f5c|\u5bfc\u51fa)|\u5404(?:\u751f\u6210|\u521b\u5efa|\u5236\u4f5c|\u5bfc\u51fa)?(?:\u4e00|1)\u4efd)/i
const STRONG_ARTIFACT_FORMAT = Object.freeze({
  pptx: /\bpptx?\b|\.pptx?\b|power\s*point|slide\s*deck|\u5e7b\u706f\u7247|\u6f14\u793a\u6587\u7a3f/i,
  docx: /\bdocx?\b|\.docx?\b|\bword\b|word\s*document|\u0057\u006f\u0072\u0064\s*\u6587\u6863|\u6587\u6863/i,
  xlsx: /\bxlsx?\b|\.xlsx?\b|\bexcel\b|spread\s*sheet|\u5de5\u4f5c\u7c3f|\u7535\u5b50\u8868\u683c/i,
  html: /\bhtml?\b|\.html?\b|\bweb\s*page\b|\bwebsite\b|\blanding\s*page\b|\u7f51\u9875|\u7f51\u7ad9|\u843d\u5730\u9875/i,
  pdf: /\bpdf\b|\.pdf\b|\u4fbf\u643a\u5f0f\u6587\u6863/i,
  image: /\bimages?\b|\bpictures?\b|\bphotos?\b|\billustrations?\b|\bposters?\b|\u56fe\u7247|\u56fe\u50cf|\u63d2\u56fe|\u914d\u56fe|\u6d77\u62a5|\u5c01\u9762\u56fe/i,
})

// A terse follow-up such as “这里不足，修改一下” intentionally omits the
// file format because the immediately preceding deliverable is the subject.
// This is deliberately action-oriented: merely discussing or asking about an
// older file must not keep artifact generators enabled forever.
const ARTIFACT_REVISION_ACTION = /(?:继续(?:修改|编辑|完善|优化|调整|润色|改进|补充|更新|迭代)|(?:请|帮我|麻烦)?(?:把|将)?(?:它|这个|这里|刚才的|上一个|上一版|该(?:文件|页面|文档|表格|演示|幻灯片))?[^。！？!?\n]{0,24}(?:修改|编辑|完善|优化|调整|润色|改进|补充|更新|迭代|重做|重制|替换|换成|改成|改(?:一?下)?|换(?:一?下|个)?|删(?:一?下|掉)?|删除|添加|加(?:一?下|上)?|补(?:一?下|上)?|缩小|放大)|(?:再|重新|继续|请|帮我|麻烦)?(?:改|换|删|加|补|调|修)(?:一?下|个|掉|成|为)?[^。！？!?\n]{0,24}|(?:这里|这版|上一版|刚才的)[^。！？!?\n]{0,24}(?:不足|不对|不好|有问题)[^。！？!?\n]{0,20}(?:改|修|调整|优化|完善)|(?:revise|edit|update|improve|refine|adjust|polish|iterate|redo|redesign|change|replace|remove|add|continue\s+(?:working|editing|improving))\b)/i
// Object-first follow-ups often describe the desired placement instead of
// saying "modify" explicitly: "把这张人物图作为背景" still changes the
// immediately preceding webpage. Every branch starts at a sentence boundary
// and accepts only command prefixes so "不要把...", "是否用...", "Why
// use...", and similar discussion cannot unlock mutation tools from a
// substring in the middle of the sentence.
const ARTIFACT_REVISION_PLACEMENT = /(?:^|[\n。！？!?；;，,])\s*(?:(?:(?:请|帮我|麻烦(?:你)?|直接|继续|再|只)\s*)*(?:(?:把|将)\s*[^。！？!?；;\n]{1,40}?(?:作为|设为|设置为|设成|用作|当作|当)\s*(?:网页|网站|页面|首页|文档|幻灯片|演示)?\s*(?:的)?\s*(?:背景(?:图|图片)?|封面(?:图|图片)?|主视觉)(?:使用)?|(?:用|使用|以)\s*[^。！？!?；;\n]{1,40}?(?:作为|用作|当作|来做|做(?:成)?)\s*(?:网页|网站|页面|首页|文档|幻灯片|演示)?\s*(?:的)?\s*(?:背景(?:图|图片)?|封面(?:图|图片)?|主视觉))|(?:(?:please\s+|(?:can|could|would)\s+you\s+)?(?:use|set|make)\s+(?:(?:this|that|these|those|the|my|your|uploaded|attached|provided|existing|current)\s+){0,4}(?:image|photo|picture|portrait|attachment)\s+(?:(?:as|for)\s+)?(?:(?:the|an?)\s+)?(?:(?:website|webpage|page|document|slide|deck)\s+)?(?:background(?!\s+(?:information|context|material|reference)\b)|cover|hero(?:\s+(?:image|art))?)))/i
const EXISTING_ASSET_PLACEMENT = /(?:(?:这|那|该|此)(?:一)?(?:张|幅|个)?(?:人物)?(?:图|图片|图像|照片)|(?:上传(?:的)?|附件(?:中|里|的)?|我(?:上传|提供|发)(?:的)?)[^。！？!?；;\n]{0,12}(?:(?:人物)?(?:图|图片|图像|照片|附件)|[^\s。！？!?；;]+\.(?:avif|gif|jpe?g|png|webp))|attachment:\/\/[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}|[^\s。！？!?；;]+\.(?:avif|gif|jpe?g|png|webp)|(?:(?:this|that|these|those|my|your)\s+)(?:(?:attached|uploaded|provided|existing|current)\s+)?(?:image|photo|picture|portrait|attachment)|(?:the\s+)?(?:attached|uploaded|provided|existing|current)\s+(?:image|photo|picture|portrait|attachment))/i
// A complete image set read from a named directory is input material for the
// requested website/document, even when the user naturally calls it an
// “image website”. Only an independent “also create a new image” clause may
// unlock generate_image in that situation.
const EXISTING_IMAGE_COLLECTION_INPUT = /(?:(?:读取|扫描|遍历|使用|展示|收录|来自|从|read|scan|browse|use|show|include|from|目录|文件夹|folder|directory)[\s\S]{0,96}(?:全部|所有|每(?:一|个|张)|all|every|each)[\s\S]{0,40}(?:jpe?g|png|webp|图片|图像|照片|images?|photos?|pictures?)|(?:全部|所有|每(?:一|个|张)|all|every|each)[\s\S]{0,40}(?:jpe?g|png|webp|图片|图像|照片|images?|photos?|pictures?)[\s\S]{0,96}(?:读取|扫描|遍历|使用|展示|收录|目录|文件夹|read|scan|browse|use|show|include|folder|directory))/i
const EXISTING_IMAGE_SET_CONTEXT = /(?:(?:已有|现有|本地|上传(?:的)?|附件(?:中|里|的)?|existing|local|uploaded|attached)[^。！？!?；;\n]{0,32}(?:jpe?g|png|webp|图片|图像|照片|images?|photos?|pictures?)|(?:目录|文件夹|路径|盘|地方|位置|folder|directory|path|drive|location)[^。！？!?；;\n]{0,32}(?:有(?:很多|许多|大量|一批)?|包含|存放|放着|contains?|has|with)[^。！？!?；;\n]{0,32}(?:jpe?g|png|webp|图片|图像|照片|images?|photos?|pictures?)|(?:有很多|有许多|有大量|有一批|many|multiple|a\s+collection\s+of)[^。！？!?；;\n]{0,24}(?:jpe?g|png|webp|图片|图像|照片|images?|photos?|pictures?))/i
const EXISTING_IMAGE_REUSE_CONTEXT = /(?:(?:用|使用|利用|读取|扫描|遍历|展示|显示|收录|包含|引用|导入|use|using|read|scan|browse|show|display|include|reference|import)[^。！？!?；;\n]{0,40}(?:(?:这些|那些|上述|其中|已有|现有|本地|上传(?:的)?|附件(?:中|里|的)?|these|those|existing|local|uploaded|attached)[^。！？!?；;\n]{0,16})?(?:jpe?g|png|webp|图片|图像|照片|images?|photos?|pictures?)|(?:确保|保证|make\s+sure|ensure)[^。！？!?；;\n]{0,64}(?:全部|所有|每(?:一|个|张)|所有内容|all|every|each|everything)[^。！？!?；;\n]{0,32}(?:被?使用|展示|显示|收录|包含|use|used|show|shown|display|include|included))/i
const EXISTING_ASSET_MUTATION_COMMAND_PREFIX = /^(?:(?:请|帮我|麻烦(?:你)?|直接|继续|再|只)\s*)*(?:(?:把|将|在|向|给|用|使用)\s*|(?:please\s+)?(?:add|insert|put|place|embed|use|set|replace)\b)/i
const EXISTING_ASSET_MUTATION_ACTION_BEFORE = /(?:加入|添加|插入|放入|放进|放到|置入|嵌入|作为|用作|设为|设置为|设成|替换为|(?:add|insert|put|place|embed|use|set|replace))\s*$/i
const EXISTING_ASSET_MUTATION_ACTION_AFTER = /^\s*(?:加入|添加|插入|放入|放进|放到|置入|嵌入|作为|用作|设为|设置为|设成|替换为)/i
const ADDITIONAL_IMAGE_PRODUCTION = /(?:(?:另外|另行|同时|还要|并且|以及|再)\s*(?:请|帮我|麻烦)?\s*(?:生成|创建|制作|画|绘制)|(?:also|additionally|separately)\s+(?:generate|create|make|draw))[^。！？!?\n]{0,32}(?:图|图片|图像|照片|海报|插图|image|photo|picture|poster|illustration)/i
const EXPLICIT_IMAGE_CREATION = /(?:(?:生成|创建|制作|设计|画|绘制)\s*(?:一|1)?(?:张|幅|个)?[^。！？!?\n]{0,16}(?:图|图片|图像|照片|海报|插图|插画|徽标|标志|logo)|(?:generate|create|make|design|draw)\s+(?:an?\s+)?[^.!?\n]{0,16}(?:image|picture|photo|poster|illustration|logo|graphic))/i

function hasUnnegatedExplicitImageCreation(prompt = '') {
  const text = String(prompt || '')
  const matcher = new RegExp(EXPLICIT_IMAGE_CREATION.source, 'gi')
  for (const match of text.matchAll(matcher)) {
    const before = text.slice(Math.max(0, match.index - 32), match.index)
    if (!DIRECT_NEGATION.test(before)) return true
  }
  return false
}
const ARTIFACT_REVISION_SHORT_DENIAL = /(?:不要|不用|无需|别|禁止|停止|取消)\s*(?:再)?\s*(?:改|换|删|加|补|调|修)(?:一?下|掉|成|为)?/gi

function isExistingAssetPlacement(text = '') {
  const value = String(text || '').trim()
  const placement = value.match(ARTIFACT_REVISION_PLACEMENT)?.[0] || ''
  if (placement && EXISTING_ASSET_PLACEMENT.test(placement)) return true
  const assetPattern = new RegExp(
    EXISTING_ASSET_PLACEMENT.source,
    EXISTING_ASSET_PLACEMENT.flags.includes('g')
      ? EXISTING_ASSET_PLACEMENT.flags
      : `${EXISTING_ASSET_PLACEMENT.flags}g`,
  )
  for (const asset of value.matchAll(assetPattern)) {
    const before = value.slice(Math.max(0, asset.index - 48), asset.index)
    const after = value.slice(asset.index + asset[0].length, asset.index + asset[0].length + 48)
    const clauseStart = Math.max(
      value.lastIndexOf('\n', asset.index - 1),
      value.lastIndexOf('。', asset.index - 1),
      value.lastIndexOf('！', asset.index - 1),
      value.lastIndexOf('？', asset.index - 1),
      value.lastIndexOf('；', asset.index - 1),
      value.lastIndexOf(';', asset.index - 1),
      value.lastIndexOf('，', asset.index - 1),
      value.lastIndexOf(',', asset.index - 1),
    )
    const commandClause = value.slice(clauseStart + 1).trimStart()
    if (EXISTING_ASSET_MUTATION_COMMAND_PREFIX.test(commandClause)
      && (EXISTING_ASSET_MUTATION_ACTION_BEFORE.test(before)
        || EXISTING_ASSET_MUTATION_ACTION_AFTER.test(after))) return true
  }
  return false
}
const ARTIFACT_REVISION_DENIAL = /(?:不要|不用|无需|别|禁止|停止|取消)[^，,；;：:。！？!?\n]{0,20}(?:修改|编辑|更新|优化|调整|重做|生成|导出)|(?:do\s+not|don't|dont|never|stop|cancel)[^,;:.!?\n]{0,24}(?:revise|edit|update|change|generate|export)/i
const ARTIFACT_REVISION_DISCUSSION = /^(?:(?:我想|我只是想|只是想)?(?:知道|了解|问(?:一下)?)?\s*[,，：:]?\s*(?:为什么|为何|怎么|如何)|请?(?:解释|说明|分析|讨论)|告诉我)[^。！？!?\n]{0,80}|(?:修改|编辑|调整|优化|改|换)[^。！？!?\n]{0,10}(?:是什么|什么意思|含义|原则|方法|逻辑|代码|工具)/i
const ARTIFACT_REVISION_EXPLANATION_QUESTION = /^\s*(?:我(?:只是)?想(?:知道|了解|问(?:一下)?)|只是想(?:知道|了解))[^。！？!?\n]{0,120}(?:怎么|如何|为什么|为何)[^。！？!?\n]*[?？]\s*$/i
// Once a deliverable is immediately adjacent, users often describe only the
// desired visual state instead of repeating an edit verb or filename. Keep
// these cues contextual: the same complaint in an unrelated conversation must
// not unlock artifact mutation tools.
const ARTIFACT_REVISION_CONTEXTUAL_CONTINUE = /^(?:继续|接着|往下做|继续吧|接着做|continue|go\s+on|keep\s+going)[\s。.!！]*$/i
const ARTIFACT_REVISION_CONTEXTUAL_PLACEMENT = /^(?:(?:请|帮我|麻烦(?:你)?|直接|再)?\s*(?:把|将)\s*[^。！？!?；;\n]{1,48}?(?:放|移|挪|置|排列|对齐)(?:到|至|在|于|成)\s*[^。！？!?；;\n]{1,32}|(?:please\s+)?(?:move|place|align|position)\s+[^.!?\n]{1,48}\s+(?:to|on|at|in)\s+[^.!?\n]{1,32})[\s。.!！]*$/i
const ARTIFACT_REVISION_CONTEXTUAL_FEEDBACK = /^(?=[^。！？!?\n]{2,64}[。.!！]*$)(?:(?:这个|这张|这段|这里|页面|网页|背景(?:颜色)?|颜色|人物|图片|图像|按钮|标题|文字|字体|字号|间距|布局|卡片|表格|图表|封面|主视觉|动画|效果|内容)[^。！？!?\n]{0,28}(?:太(?:浅|深|大|小|亮|暗|高|低|宽|窄|快|慢|密|疏)|有点[^。！？!?\n]{1,12}|不够[^。！？!?\n]{1,12}|不好看|难看|不协调|不清楚|看不清|不明显|不对|有问题|不合适)(?:了|啦)?|(?:人物|图片|图像|按钮|标题|文字|字体|字号|间距|布局|卡片|表格|图表|封面|主视觉)[^。！？!?\n]{0,16}(?:(?:再|更)(?:大|小|高|低|宽|窄|亮|暗|粗|细|靠左|靠右|往左|往右|往上|往下|上移|下移)|(?:大|小|高|低|宽|窄|亮|暗|粗|细|居中|左对齐|右对齐|靠左|靠右)(?:一?点|一些)?))[\s。.!！]*$/i
const ARTIFACT_REVISION_CONTEXTUAL_DENIAL = /^(?:不要|别|不用|无需|禁止|停止|取消|先不要|暂时不要|do\s+not|don't|dont|never|stop|cancel)/i
const ARTIFACT_REVISION_CONTEXTUAL_QUESTION = /^(?:是不是|是否|能否|可否|要不要|你觉得|你认为|should\b|could\b|can\b|would\b|is\b|are\b)|[?？]\s*$/i
const ARTIFACT_REPLACE_ORIGINAL_CUE = /(?:原地(?:修改|编辑|更新|覆盖)|(?:修改|编辑|更新|覆盖|改动?|调整)(?:原版|原文件|原文档|原表格|原演示|当前文件|当前版本|上一版)|(?:在|基于)(?:原版|原文件|当前文件|当前版本|上一版)(?:上|中|直接)?(?:修改|编辑|更新|覆盖|改动?|调整)|直接覆盖(?:原版|原文件|当前文件|上一版)|(?:edit|update|modify|overwrite)\s+(?:the\s+)?(?:original|existing|same)\s+(?:file|artifact|document|deck|workbook|page)|in[ -]?place)/i
// Object-first follow-ups name an already established artifact through a
// pronoun or current-page noun. In a continuation turn they mean "change the
// same thing", not "create a sibling copy". Keep image/source conversions
// out of this cue by restricting the subject to the current artifact itself.
const ARTIFACT_OBJECT_TRANSFORMATION = /(?:^|[\s,，。；;!！])(?:请|帮我|麻烦(?:你)?|继续|直接)?\s*(?:把|将)\s*(?:它|这个(?:网页|网站|页面|文件|文档|表格|演示)?|该(?:网页|网站|页面|文件|文档|表格|演示)|当前(?:网页|网站|页面|文件|文档|表格|演示)|网页|网站|页面)\s*(?:做成|改成|改为|改造(?:成|为)|变成|转成|转为)/i
const ARTIFACT_CREATE_COPY_CUE = /(?:(?:新建|另建|另做|另生成|另外生成|重新创建)(?:一|1)?(?:个|份)?(?:新)?(?:文件|版本|副本)?|(?:创建|生成|制作)(?:一|1)?(?:个|份)?新(?:文件|版本|副本)|另存为|(?:create|make|save)\s+(?:a\s+)?(?:new|separate)\s+(?:file|copy|version))/i
const ARTIFACT_CREATE_COPY_DENIAL = /(?:(?:不要|别|无需)(?:再)?(?:新建|另建|另做|新生成|创建新(?:文件|版本|副本))|without\s+creating\s+(?:a\s+)?new\s+(?:file|copy))/gi
const ARTIFACT_REPLACE_ORIGINAL_DENIAL = /(?:(?:保留|不改|不要修改|不要覆盖)(?:原版|原文件|当前文件|上一版)|keep\s+(?:the\s+)?original)/gi
const ARTIFACT_FILENAME_PRESERVATION = /(?:(?:保留|保持|维持|不改|不修改|别修改|不要修改|不要更改|不要改变|别更改|别改变)\s*(?:(?:原|当前)\s*)?文件\s*(?:名(?:称)?|的\s*(?:文件\s*)?名(?:称)?)|(?:keep|preserve|retain|do\s+not\s+change|don't\s+change|dont\s+change)\s+(?:the\s+)?(?:(?:original|existing|same|current)\s+)?(?:file\s*name|filename))/gi
const CODE_SNIPPET_DENIAL = /(?:不要|别|无需|不用|禁止|避免)[^。！？!?\n]{0,24}(?:代码|源码|code|source)|(?:do\s+not|don't|dont|never|without)[^.!?\n]{0,24}(?:code|source)/i
const EXPLICIT_CODE_SNIPPET_REQUEST = /(?:代码片段|源码片段|示例代码|完整代码|完整源码|(?:html|css|javascript|typescript|python|java|c\+\+|sql)\s*(?:代码|源码)|\bcode\s+snippet\b|\bfull\s+source(?:\s+code)?\b)|(?:给我|输出|提供|展示|贴出|发我|返回|生成|写出)[^。！？!?\n]{0,20}(?:代码|源码)|(?:show|provide|print|paste|return|write|give\s+me)[^.!?\n]{0,20}(?:code|source)/i
const ARTIFACT_TYPE_BY_EXTENSION = Object.freeze({
  ppt: 'pptx',
  pptx: 'pptx',
  doc: 'docx',
  docx: 'docx',
  xls: 'xlsx',
  xlsx: 'xlsx',
  htm: 'html',
  html: 'html',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'image',
})
const FILE_TARGET_REFERENCE = /(?:[a-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[^\s"'`“”‘’<>|?*，。；：！？（）()\u005b\u005d【】{}\\/]+[\\/])*[^\s"'`“”‘’<>|?*，。；：！？（）()\u005b\u005d【】{}\\/]+\.(?:pptx?|docx?|xlsx?|html?|pdf|png|jpe?g|webp|gif|svg)(?=$|[\s"'`“”‘’<>（）()\u005b\u005d【】{},;:，。；：！？])/giu
const REMOTE_URL_REFERENCE = /\b(?:https?|ftp):\/\/[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/giu
const WORKSPACE_FILE_CUE = /(?:本地|工作区|项目(?:中|内|里)|仓库|目录|磁盘)(?:中|内|里|上|的)?[^。！？!?\n]{0,20}(?:现有|已有)?(?:原)?文件|(?:现有|已有)(?:的)?(?:本地|工作区|项目)?(?:原)?文件|(?:local|workspace|project|repository|on[- ]disk)\s+(?:existing\s+)?files?|existing\s+(?:local\s+|workspace\s+|project\s+)?files?/i
const MANAGED_ARTIFACT_DENIAL = /(?:不要|别|禁止|不允许|无需|不用|不得)[^。！？!?\n]{0,48}(?:artifact|托管产物|可下载产物|产物卡片)|(?:without|do\s+not|don't|dont|never|must\s+not|no)\s+[^.!?\n]{0,48}(?:managed\s+)?artifact/i
const LOCAL_PATH_CONTEXT = /(?:本地|工作区|当前?(?:的)?项目|项目(?:根)?目录|仓库|目录|磁盘|原文件|现有文件|已有文件|原版文件|local|workspace|project|repository|on[- ]disk|existing\s+file)/i
const LOCAL_MUTATION_ACTION = /(?:继续\s*)?(?:修改|编辑|更新|覆盖|改写|调整|优化|完善|润色|修复|替换|edit|update|modify|overwrite|revise|adjust|refine)\s*(?:这个|该|现有的?|已有的?|原版的?|原)?\s*$/i
const LOCAL_MUTATION_AFTER = /^\s*(?:这个|该|现有的?|已有的?|原版的?|原)?\s*(?:文件)?\s*(?:修改|编辑|更新|覆盖|改写|调整|优化|完善|润色|修复|替换|edit|update|modify|overwrite|revise|adjust|refine)\b/i
const FILE_CREATION_ACTION = /(?:新建|创建|生成|制作|导出|另存为|create|generate|make|produce|export|save\s+as)\s*(?:一个|一份|新的?|the|a|an)?\s*$/i
const LEADING_FILE_ACTION = /^(?:(?:请|帮我|麻烦|给我|直接|继续|把|将|再|重新)\s*)*(?:新建|创建|生成|制作|导出|修改|编辑|更新|覆盖|打开|读取|检查)\s*/iu
const LOCAL_PATCH_INTENT = /(?:修复|修改|编辑|更新|覆盖|改写|调整|优化|完善|润色|替换|fix|edit|update|modify|overwrite|revise|adjust|refine)/i
const ARTIFACT_CREATION_BEFORE = /(?:另外|另行|另外再|并另外|随后|之后|后再|再|重新)?\s*(?:新建|创建|生成|制作|导出|另存为|create|generate|make|produce|export|save\s+as)(?:[^。！？!?\n]{0,24})$/i
const ARTIFACT_CREATION_AFTER = /^[^，,；;。！？!?\n]{0,12}(?:新建|创建|生成|制作|导出|create|generate|make|produce|export)/i

export const ARTIFACT_DELIVERY_TARGETS = Object.freeze({
  WORKSPACE_FILE: 'workspace_file',
  MANAGED_ARTIFACT: 'managed_artifact',
  MIXED: 'mixed',
  STANDALONE: 'standalone',
})

function maskRemoteUrlReferences(prompt = '') {
  REMOTE_URL_REFERENCE.lastIndex = 0
  const masked = String(prompt || '').replace(REMOTE_URL_REFERENCE, (url) => ' '.repeat(url.length))
  REMOTE_URL_REFERENCE.lastIndex = 0
  return masked
}

export function stripRemoteUrlReferences(prompt = '') {
  REMOTE_URL_REFERENCE.lastIndex = 0
  const stripped = String(prompt || '').replace(REMOTE_URL_REFERENCE, ' ')
  REMOTE_URL_REFERENCE.lastIndex = 0
  return stripped
}

function normalizeFileTargetPath(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withoutAction = /[\\/]/.test(raw) || /^[a-z]:/i.test(raw)
    ? raw
    : raw.replace(LEADING_FILE_ACTION, '')
  return withoutAction.trim()
}

function fileTargetType(path = '') {
  const match = String(path || '').match(/\.([a-z0-9]+)$/i)
  return match ? ARTIFACT_TYPE_BY_EXTENSION[match[1].toLowerCase()] || null : null
}

function extractFileTargetReferences(prompt = '') {
  const text = maskRemoteUrlReferences(prompt)
  FILE_TARGET_REFERENCE.lastIndex = 0
  const references = []
  const seen = new Set()
  for (const match of text.matchAll(FILE_TARGET_REFERENCE)) {
    const path = normalizeFileTargetPath(match[0])
    const type = fileTargetType(path)
    if (!path || !type) continue
    const normalized = path.replace(/\\/g, '/').toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    references.push({
      path,
      filename: path.split(/[\\/]/).pop() || path,
      type,
      index: match.index,
      length: match[0].length,
      raw: match[0],
    })
  }
  FILE_TARGET_REFERENCE.lastIndex = 0
  return { text, references }
}

function typeForArtifactTool(toolName = '') {
  return Object.entries({
    pptx: 'create_pptx',
    docx: 'create_docx',
    xlsx: 'create_xlsx',
    html: 'create_html_app',
    pdf: 'create_pdf',
    image: 'generate_image',
  }).find(([, tool]) => tool === toolName)?.[0] || null
}

function filenameEquals(left = '', right = '') {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase()
}

function intentTypes(intent = {}) {
  return Object.keys(ARTIFACT_TERMS).filter((type) => intent?.[type] === true)
}

/**
 * Resolve local/workspace targets independently from managed artifact formats.
 * One local HTML edit therefore cannot disable an independently requested PDF,
 * PPTX, DOCX, XLSX, or image artifact in the same user turn.
 */
export function resolveArtifactDeliveryTargets(prompt = '', {
  priorArtifacts = [],
  priorArtifactTypes = [],
  hasExplicitManagedArtifactReference = false,
  skillId = undefined,
} = {}) {
  const source = String(prompt || '').trim()
  const { text, references } = extractFileTargetReferences(source)
  const prior = Array.isArray(priorArtifacts) ? priorArtifacts : []
  const hasPriorArtifactContext = prior.length > 0
    || (Array.isArray(priorArtifactTypes) && priorArtifactTypes.length > 0)
  const localFileTargets = []
  const managedFileTargets = []
  let hasLocalPatchIntent = false
  // “保留原文件名” describes the replacement disposition; its “原文件”
  // substring is not evidence that the named file lives in the workspace.
  // Mask it at equal length so reference indices continue to line up.
  ARTIFACT_FILENAME_PRESERVATION.lastIndex = 0
  const localCueText = text.replace(
    ARTIFACT_FILENAME_PRESERVATION,
    (match) => ' '.repeat(match.length),
  )
  ARTIFACT_FILENAME_PRESERVATION.lastIndex = 0
  const globallyLocal = WORKSPACE_FILE_CUE.test(localCueText)
    || MANAGED_ARTIFACT_DENIAL.test(localCueText)
    || /(?:当前项目根目录|项目根目录|工作目录|authorized\s+(?:workspace|directory))/i.test(localCueText)

  for (const reference of references) {
    const before = text.slice(Math.max(0, reference.index - 64), reference.index)
    const after = text.slice(reference.index + reference.length, reference.index + reference.length + 40)
    const around = localCueText.slice(
      Math.max(0, reference.index - 48),
      reference.index + reference.length + 48,
    )
    const explicitPath = /^(?:[a-z]:[\\/]|\.{1,2}[\\/]|[\\/])/i.test(reference.path)
      || /[\\/]/.test(reference.path)
    const matchesPrior = prior.some((artifact) => filenameEquals(artifact?.filename, reference.filename))
    const explicitManaged = hasExplicitManagedArtifactReference && matchesPrior
    const localContext = globallyLocal || LOCAL_PATH_CONTEXT.test(around)
    const mutationContext = LOCAL_MUTATION_ACTION.test(before) || LOCAL_MUTATION_AFTER.test(after)
    const creationContext = FILE_CREATION_ACTION.test(before)
    // Rendered page-N files are image-side verification outputs. Treating the
    // same token inside an HTML filename (for example product-page-123.html)
    // as a local derived output breaks an explicitly referenced managed page.
    const derivedOutputContext = reference.type === 'image'
      && /(?:render|verify|preview|screenshot|page[-_ ]?\d+|渲染|验证|预览|截图|逐页)/i.test(around)
    const local = explicitPath
      || localContext
      || MANAGED_ARTIFACT_DENIAL.test(source)
      || derivedOutputContext
      || (!explicitManaged && (mutationContext || !creationContext))
    ;(local ? localFileTargets : managedFileTargets).push({
      path: reference.path,
      filename: reference.filename,
      type: reference.type,
    })
    if (local && (mutationContext || LOCAL_PATCH_INTENT.test(before) || LOCAL_PATCH_INTENT.test(after))) {
      hasLocalPatchIntent = true
    }
  }

  const workspaceArtifactTypes = [...new Set(localFileTargets.map(({ type }) => type))]
  // File extensions are authoritative format declarations. Mask every
  // filename before running the looser semantic detector so a basename such
  // as report.pdf cannot also trigger DOCX through the word “report”. The
  // managed target types are unioned back explicitly below.
  const fileReferenceRanges = references
  let residualText = text
  for (const reference of [...fileReferenceRanges].sort((a, b) => b.index - a.index)) {
    residualText = `${residualText.slice(0, reference.index)}${' '.repeat(reference.length)}${residualText.slice(reference.index + reference.length)}`
  }

  const resolvedSkill = skillId === undefined ? parseArtifactSkillId(source) : skillId
  const skillType = typeForArtifactTool(resolveArtifactToolForSkillId(resolvedSkill))
  const residualSkill = skillType && workspaceArtifactTypes.includes(skillType) ? null : resolvedSkill
  if (!residualSkill && skillType) {
    residualText = residualText.replace(SKILL_PREFIX, (match) => ' '.repeat(match.length))
  }
  const residualIntent = detectArtifactIntentRaw(residualText, {
    skillId: residualSkill,
    priorArtifactTypes: localFileTargets.length > 0 ? [] : priorArtifactTypes,
    hasPriorArtifact: localFileTargets.length === 0 && hasPriorArtifactContext,
  })
  const residualIntentTypes = intentTypes(residualIntent)
  // A local patch often names content inside the file (for example “fix the
  // image rotation in gallery.html”). Those nouns are patch subjects, not a
  // request for a second managed artifact. Preserve only independently stated
  // creation clauses such as “then generate a marketing image”.
  const explicitCreationTypes = Object.keys(ARTIFACT_TERMS)
    .filter((type) => hasExplicitArtifactCreationRequest(residualText, type))
  if (hasUnnegatedExplicitImageCreation(residualText) && !explicitCreationTypes.includes('image')) {
    explicitCreationTypes.push('image')
  }
  const managedResidualTypes = hasLocalPatchIntent ? explicitCreationTypes : residualIntentTypes
  const managedArtifactTypes = [...new Set([
    ...managedFileTargets.map(({ type }) => type),
    ...managedResidualTypes,
  ])]

  const hasLocal = localFileTargets.length > 0
  const hasManaged = managedArtifactTypes.length > 0
  const hasPriorArtifact = prior.length > 0
  const target = hasLocal && hasManaged
    ? ARTIFACT_DELIVERY_TARGETS.MIXED
    : hasLocal
      ? ARTIFACT_DELIVERY_TARGETS.WORKSPACE_FILE
      : hasPriorArtifact && isArtifactRevisionRequest(source, { hasPriorArtifact: true })
        ? ARTIFACT_DELIVERY_TARGETS.MANAGED_ARTIFACT
        : ARTIFACT_DELIVERY_TARGETS.STANDALONE

  return {
    target,
    intent: hasLocalPatchIntent
      ? hasManaged ? 'mixed_intent' : 'patch_intent'
      : hasManaged ? 'create_intent' : 'none',
    localFileTargets,
    workspaceArtifactTypes,
    managedArtifactTypes,
  }
}

export function resolveArtifactDeliveryTarget(prompt = '', options = {}) {
  return resolveArtifactDeliveryTargets(prompt, options).target
}

export function resolveArtifactRevisionMode(prompt = '') {
  const text = String(prompt || '').trim()
  if (!text) return 'unspecified'
  ARTIFACT_FILENAME_PRESERVATION.lastIndex = 0
  const preserveFilename = ARTIFACT_FILENAME_PRESERVATION.test(text)
  ARTIFACT_FILENAME_PRESERVATION.lastIndex = 0
  const dispositionText = text.replace(ARTIFACT_FILENAME_PRESERVATION, ' ')
  ARTIFACT_CREATE_COPY_DENIAL.lastIndex = 0
  ARTIFACT_REPLACE_ORIGINAL_DENIAL.lastIndex = 0
  const createCopyDenied = ARTIFACT_CREATE_COPY_DENIAL.test(dispositionText)
  const replaceOriginalDenied = ARTIFACT_REPLACE_ORIGINAL_DENIAL.test(dispositionText)
  ARTIFACT_CREATE_COPY_DENIAL.lastIndex = 0
  ARTIFACT_REPLACE_ORIGINAL_DENIAL.lastIndex = 0
  const createCopy = replaceOriginalDenied
    || ARTIFACT_CREATE_COPY_CUE.test(dispositionText.replace(ARTIFACT_CREATE_COPY_DENIAL, ''))
  const replaceOriginal = createCopyDenied
    || ARTIFACT_REPLACE_ORIGINAL_CUE.test(dispositionText.replace(ARTIFACT_REPLACE_ORIGINAL_DENIAL, ''))
    || (!createCopy && ARTIFACT_OBJECT_TRANSFORMATION.test(dispositionText))
    || (preserveFilename && !createCopy)
  if (replaceOriginal && createCopy) return 'conflict'
  if (replaceOriginal) return 'replace_original'
  if (createCopy) return 'create_copy'
  return 'unspecified'
}

export function isExplicitCodeSnippetRequest(prompt = '') {
  const text = String(prompt || '').trim()
  return Boolean(
    text
      && !CODE_SNIPPET_DENIAL.test(text)
      && EXPLICIT_CODE_SNIPPET_REQUEST.test(text),
  )
}

export function isArtifactRevisionRequest(prompt = '', { hasPriorArtifact = false } = {}) {
  const text = String(prompt || '').trim()
  if (!text
    || GLOBAL_DENIAL.test(text)
    || ARTIFACT_REVISION_DENIAL.test(text)
    || ARTIFACT_REVISION_DISCUSSION.test(text)
    || ARTIFACT_REVISION_EXPLANATION_QUESTION.test(text)) return false
  const existingAssetPlacement = isExistingAssetPlacement(text)
  const actionText = text.replace(ARTIFACT_REVISION_SHORT_DENIAL, ' ')
  ARTIFACT_REVISION_SHORT_DENIAL.lastIndex = 0
  const explicitRevision = ARTIFACT_REVISION_ACTION.test(actionText)
    || ARTIFACT_OBJECT_TRANSFORMATION.test(actionText)
    || existingAssetPlacement
    || resolveArtifactRevisionMode(text) !== 'unspecified'
  if (explicitRevision || !hasPriorArtifact) return explicitRevision
  if (ARTIFACT_REVISION_CONTEXTUAL_DENIAL.test(text)
    || ARTIFACT_REVISION_CONTEXTUAL_QUESTION.test(text)) return false
  return ARTIFACT_REVISION_CONTEXTUAL_CONTINUE.test(text)
    || ARTIFACT_REVISION_CONTEXTUAL_PLACEMENT.test(text)
    || ARTIFACT_REVISION_CONTEXTUAL_FEEDBACK.test(text)
}

function normalizePriorArtifactTypes(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase().replace(/^\./, ''))
    .map((value) => value === 'ppt' ? 'pptx' : value === 'doc' ? 'docx' : value === 'xls' ? 'xlsx' : value)
    .filter((value) => Object.hasOwn(ARTIFACT_TERMS, value)))
}

export function parseArtifactSkillId(prompt = '') {
  const match = String(prompt || '').trim().match(SKILL_PREFIX)
  return match ? canonicalizeSkillId(match[1]) : null
}

function clauseAroundOccurrence(text, match) {
  const start = Math.max(
    text.lastIndexOf('。', match.index - 1),
    text.lastIndexOf('！', match.index - 1),
    text.lastIndexOf('？', match.index - 1),
    text.lastIndexOf('!', match.index - 1),
    text.lastIndexOf('?', match.index - 1),
    text.lastIndexOf('\n', match.index - 1),
  ) + 1
  const tail = text.slice(match.index + match[0].length)
  const boundary = tail.search(/[。！？!?\n]/)
  const end = boundary < 0 ? text.length : match.index + match[0].length + boundary
  return text.slice(start, end)
}

function artifactMentionIsInputMaterial(text, match, type) {
  const before = text.slice(Math.max(0, match.index - 72), match.index)
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 96)
  const clause = clauseAroundOccurrence(text, match)
  const otherTypeMentioned = Object.entries(ARTIFACT_TERMS).some(([candidate, matcher]) => {
    if (candidate === type) return false
    const probe = new RegExp(matcher.source, matcher.flags.replace('g', ''))
    return probe.test(clause)
  })
  if (!otherTypeMentioned) return false

  const inputRelationship = ARTIFACT_INPUT_ACTION_BEFORE.test(before)
    || ARTIFACT_INPUT_AFTER.test(after)
    || ARTIFACT_COMPOUND_MODIFIER_AFTER.test(after)
  const conversionConnector = after.match(/^[^。！？!?；;\n]{0,48}?\b(?:to|into|as)\b/i)
  const conversionTarget = conversionConnector
    ? after.slice(conversionConnector[0].length)
    : ''
  const conversionSource = Boolean(conversionConnector && Object.entries(ARTIFACT_TERMS).some(([candidate, matcher]) => {
    if (candidate === type) return false
    const probe = new RegExp(matcher.source, matcher.flags.replace('g', ''))
    return probe.test(conversionTarget)
  }))
  if (!inputRelationship && !conversionSource) return false

  // English conversion clauses put the source format before to/into/as and
  // the requested output after it: "convert PDF to images" must expose only
  // generate_image, never create_pdf as a second deliverable.
  if (conversionSource) return true

  // A direct request such as "生成图片并做网站" is genuinely multi-output.
  // Existing/input material wording, or a compound noun such as "图片画廊网站",
  // makes the same mention an input/topic instead of a second deliverable.
  const directProduction = ARTIFACT_PRODUCTION_BEFORE.test(before)
    || ARTIFACT_OUTPUT_RELATION_BEFORE.test(before)
  const compoundModifier = ARTIFACT_COMPOUND_MODIFIER_AFTER.test(after)
  if (compoundModifier) return true
  return !directProduction
}

function artifactMentionsBetween(text, start, end) {
  const mentions = []
  for (const [type, matcher] of Object.entries(ARTIFACT_TERMS)) {
    const probe = new RegExp(matcher.source, matcher.flags.includes('g') ? matcher.flags : `${matcher.flags}g`)
    for (const mention of text.slice(start, end).matchAll(probe)) {
      mentions.push({ type, index: start + mention.index })
    }
  }
  return mentions.sort((left, right) => left.index - right.index)
}

/**
 * Bind a generic correction such as “I never asked it to generate that” to
 * the closest artifact mention instead of denying every format in the turn.
 * An explicit object in the same comma-delimited clause wins; otherwise the
 * correction refers back to the nearest preceding artifact mention.
 */
function occurrenceIsDeniedByCorrection(text, match, type) {
  const sentenceStart = Math.max(
    text.lastIndexOf('。', match.index - 1),
    text.lastIndexOf('！', match.index - 1),
    text.lastIndexOf('？', match.index - 1),
    text.lastIndexOf('!', match.index - 1),
    text.lastIndexOf('?', match.index - 1),
    text.lastIndexOf('\n', match.index - 1),
  ) + 1
  const sentenceTail = text.slice(match.index + match[0].length)
  const sentenceBoundary = sentenceTail.search(/[。！？!?\n]/)
  const sentenceEnd = sentenceBoundary < 0
    ? text.length
    : match.index + match[0].length + sentenceBoundary
  const denialProbe = new RegExp(GLOBAL_DENIAL.source, GLOBAL_DENIAL.flags.includes('g')
    ? GLOBAL_DENIAL.flags
    : `${GLOBAL_DENIAL.flags}g`)

  for (const denial of text.slice(sentenceStart, sentenceEnd).matchAll(denialProbe)) {
    const denialStart = sentenceStart + denial.index
    const denialEnd = denialStart + denial[0].length
    const minorTail = text.slice(denialEnd, sentenceEnd)
    const minorBoundary = minorTail.search(/[，,；;]/)
    const minorEnd = minorBoundary < 0 ? sentenceEnd : denialEnd + minorBoundary
    const explicitObjects = artifactMentionsBetween(text, denialEnd, minorEnd)
    if (explicitObjects.length > 0) {
      if (explicitObjects.some((mention) => mention.type === type)) return true
      continue
    }

    const preceding = artifactMentionsBetween(text, sentenceStart, denialStart).at(-1)
    if (preceding?.type === type) return true
  }
  return false
}

function occurrenceIsExplicitRequest(text, match, type) {
  const before = text.slice(Math.max(0, match.index - 48), match.index)
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 32)
  const identifierPrefix = text.slice(Math.max(0, match.index - 16), match.index)

  if (/(?:create|generate)[_-]$/i.test(identifierPrefix)) return false
  if (/^(?:报告|report)$/i.test(match[0])
    && RESULT_REPORT_OBJECT.test(after)
    && !ARTIFACT_PRODUCTION_BEFORE.test(before)) return false
  if (DIRECT_NEGATION.test(before) || NEGATION_AFTER.test(after)) return false
  if (AUTO_OR_ACCIDENTAL.test(before) || CAPABILITY_QUESTION.test(before)) return false
  if (occurrenceIsDeniedByCorrection(text, match, type)) return false
  if (artifactMentionIsInputMaterial(text, match, type)) return false

  const requested = BEFORE_ACTION.test(before)
    || ARTIFACT_OUTPUT_RELATION_BEFORE.test(before)
    || AFTER_ACTION.test(after)
  if (!requested) return false
  if (META_QUESTION.test(before) && !/(?:帮我|请|麻烦|给我|我要|我需要|我想要|make|create|generate|export|give\s+me|i\s+(?:want|need))[^。！？!?\n]{0,24}$/i.test(before)) {
    return false
  }
  if (META_AFTER.test(after) && !/(?:修改|编辑|更新|优化|润色|重做|edit|update|revise|redesign)[^。！？!?\n]{0,20}$/i.test(before)) {
    return false
  }
  return true
}

function hasExplicitArtifactCreationRequest(prompt = '', type) {
  const text = String(prompt || '').trim()
  const matcher = ARTIFACT_TERMS[type]
  if (!text || !matcher) return false
  matcher.lastIndex = 0
  for (const match of text.matchAll(matcher)) {
    if (!occurrenceIsExplicitRequest(text, match, type)) continue
    const before = text.slice(Math.max(0, match.index - 64), match.index)
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 32)
    if (ARTIFACT_CREATION_BEFORE.test(before) || ARTIFACT_CREATION_AFTER.test(after)) return true
  }
  return false
}

export function hasExplicitArtifactRequest(prompt = '', type) {
  const text = String(prompt || '').trim()
  const matcher = ARTIFACT_TERMS[type]
  if (!text || !matcher || ARTIFACT_REVISION_EXPLANATION_QUESTION.test(text)) return false
  // Denials are scoped to each concrete format occurrence below. Treating a
  // sentence-wide denial as universal would turn “continue the website, but
  // do not generate a new image” into no artifact intent at all. The image
  // occurrence is rejected by DIRECT_NEGATION while the positive website
  // request remains authorized.
  matcher.lastIndex = 0
  for (const match of text.matchAll(matcher)) {
    if (occurrenceIsExplicitRequest(text, match, type)) return true
  }
  return false
}

/**
 * A PDF rasterization request consumes an existing PDF. It must use the
 * deterministic renderer, never the generative image model.
 */
export function isPdfToImageConversionRequest(prompt = '') {
  return PDF_TO_IMAGE_CONVERSION.test(String(prompt || ''))
}

function detectArtifactIntentRaw(prompt = '', {
  skillId = undefined,
  priorArtifactTypes = [],
  hasPriorArtifact = false,
} = {}) {
  const text = String(prompt || '')
  const revisionRequest = isArtifactRevisionRequest(text, {
    hasPriorArtifact: hasPriorArtifact || priorArtifactTypes.length > 0,
  })
  const resolvedSkill = skillId === undefined ? parseArtifactSkillId(text) : skillId
  const skillTool = resolvedSkill ? resolveArtifactToolForSkillId(resolvedSkill) : null
  const explicitPptx = hasExplicitArtifactRequest(text, 'pptx')
  const explicitDocx = hasExplicitArtifactRequest(text, 'docx')
  const explicitXlsx = hasExplicitArtifactRequest(text, 'xlsx')
  const explicitHtml = hasExplicitArtifactRequest(text, 'html')
  const explicitPdf = hasExplicitArtifactRequest(text, 'pdf')
  const explicitNonImageArtifact = explicitPptx || explicitDocx || explicitXlsx || explicitHtml || explicitPdf
  const existingAssetPlacement = isExistingAssetPlacement(text)
    && (revisionRequest || explicitNonImageArtifact)
  const existingImageCollectionInput = explicitNonImageArtifact
    && (EXISTING_IMAGE_COLLECTION_INPUT.test(text)
      || (EXISTING_IMAGE_SET_CONTEXT.test(text) && EXISTING_IMAGE_REUSE_CONTEXT.test(text)))
  const additionalImageProduction = ADDITIONAL_IMAGE_PRODUCTION.test(text)
  // In "use this image as the background", the image is an input asset, not
  // a request to generate a second image artifact. An independent clause such
  // as "also generate a new illustration" remains explicit production.
  const explicitImage = (hasExplicitArtifactRequest(text, 'image') || hasUnnegatedExplicitImageCreation(text))
    && (!(existingAssetPlacement || existingImageCollectionInput) || additionalImageProduction)
  const allowAdditionalFormat = (type) => Boolean(
    ADDITIONAL_ARTIFACT_CUE.test(text)
      && STRONG_ARTIFACT_FORMAT[type]?.test(text)
      && hasExplicitArtifactRequest(text, type),
  )
  const pptx = skillTool === 'create_pptx' || (skillTool ? allowAdditionalFormat('pptx') : explicitPptx)
  const explicitAny = Boolean(skillTool || explicitPptx || explicitDocx || explicitXlsx || explicitHtml || explicitPdf || explicitImage)
  const inherited = (!explicitAny || existingAssetPlacement)
    && revisionRequest
    ? normalizePriorArtifactTypes(priorArtifactTypes)
    : new Set()
  // When an existing/uploaded image is being placed into another deliverable,
  // that image is input material. A previously delivered image artifact must
  // not turn the revision into a second generate_image requirement. Keep the
  // surrounding HTML/PPTX/DOCX/etc. contract and require image generation only
  // when the user independently asks for a new image.
  if (existingAssetPlacement && !additionalImageProduction) inherited.delete('image')
  return {
    pptx: pptx || inherited.has('pptx'),
    // "PPT report" / "PPT 汇报" describes the deck's purpose; it is not a
    // second Word deliverable. Once PPT intent is explicit, require both a
    // multi-deliverable cue and a strong Word/DOCX term before adding DOCX.
    docx: skillTool === 'create_docx'
      || (skillTool
        ? allowAdditionalFormat('docx')
        : explicitDocx && (!pptx || allowAdditionalFormat('docx'))) || inherited.has('docx'),
    xlsx: skillTool === 'create_xlsx' || (skillTool ? allowAdditionalFormat('xlsx') : explicitXlsx) || inherited.has('xlsx'),
    html: skillTool === 'create_html_app' || (skillTool ? allowAdditionalFormat('html') : explicitHtml) || inherited.has('html'),
    pdf: skillTool === 'create_pdf' || (skillTool ? allowAdditionalFormat('pdf') : explicitPdf) || inherited.has('pdf'),
    image: skillTool === 'generate_image' || (skillTool ? allowAdditionalFormat('image') : explicitImage) || inherited.has('image'),
  }
}

export function detectArtifactIntent(prompt = '', options = {}) {
  const delivery = resolveArtifactDeliveryTargets(prompt, options)
  const managed = new Set(delivery.managedArtifactTypes)
  return Object.fromEntries(Object.keys(ARTIFACT_TERMS).map((type) => [type, managed.has(type)]))
}
