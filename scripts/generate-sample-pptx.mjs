// 生成一张展示 premium 效果的样品 deck
import { createPptx } from '../server/artifactGen.js'
process.env.ARTIFACT_DIR = process.argv[2] || './sample-out'

const r = await createPptx({
  title: '2026 增长策略',
  subtitle: '从规模扩张到效率驱动',
  theme: 'noir',
  brand: 'Gugo',
  slides: [
    { title: '占位', layout: 'cover' },
    { title: '本季度核心指标', layout: 'kpi', kpi: [
      { value: '47%', label: '收入同比', unit: 'YoY', delta: '+12pp' },
      { value: '320万', label: '月活用户', unit: 'MAU', delta: '+18%' },
      { value: '¥4.7M', label: '年化收入', unit: 'ARR', delta: '+47%' },
      { value: '94%', label: '客户留存', unit: 'NRR', delta: '+3pp' },
    ]},
    { title: '战略：从规模到效率', layout: 'section', eyebrow: '第一章 · 增长背景' },
    { title: '收入结构变化', layout: 'chart', chart: {
      type: 'bar',
      categories: ['企业版', '专业版', '团队版', '个人版'],
      series: [
        { name: '2025', values: [120, 80, 45, 25] },
        { name: '2026', values: [210, 95, 60, 35] },
      ],
    }},
    { title: '我们押注效率而非规模', layout: 'statement', bullets: ['当 AI 把单位产能放大 10 倍，团队规模不再是护城河'] },
    { title: '战略二选一', layout: 'split', bullets: [
      '继续 hiring 扩张，按人均产能爬坡',
      '冻结 headcount，把现金投入 GPU 与自动化',
    ]},
    { title: '执行路径', layout: 'process', bullets: [
      '诊断 — 盘点每位工程师的非创造性时间',
      '建模 — 把可自动化任务量化为 token 成本',
      '试点 — 选 2 个团队跑 90 天对照',
      '推广 — 制度化推到全公司',
    ]},
    { title: '客户原话', layout: 'quote', quote: {
      text: '过去 6 个月，我们用 1/3 的人完成了原计划 2 倍的事情',
      source: '某 SaaS 公司 CTO',
    }},
    { title: 'Q&A', layout: 'end', bullets: ['contact@example.com'] },
  ],
})
console.log('生成:', r.fullPath, `${(r.byteLength/1024).toFixed(1)} KB · ${r.slideCount} 页`)
