/**
 * 把聚合结果渲染成 Markdown（DSH 聊天界面按 Markdown 渲染）。
 * 纯函数，无副作用，便于单独测试。
 *
 * 聚合结果里的金额是 USD（官方价的单位）；这里通过传入的 `money` 换算成展示币种。
 */
const num = (value) => value.toLocaleString('en-US')
const date = (ms) => new Date(ms).toLocaleDateString('zh-CN')

const rangeLabel = (report) => {
  if (report.first === undefined) return '无数据'
  const span = `${date(report.first)} → ${date(report.last)}`
  if (report.from !== undefined || report.to !== undefined) {
    return `${report.from ?? '最早'} → ${report.to ?? '今天'} · ${span}`
  }
  return report.days === undefined ? `全部历史 · ${span}` : `最近 ${report.days} 个自然日 · ${span}`
}

const table = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((cells) => `| ${cells.join(' | ')} |`),
]

export function renderUsage(report, money) {
  const lines = []
  lines.push(`**DSH 用量与花费**（${rangeLabel(report)}）`)
  lines.push('')

  if (report.steps === 0) {
    lines.push('该范围内没有已上报用量的模型调用。')
    return lines.join('\n')
  }

  const providers = [...report.byProvider].sort((a, b) => b[1].cost - a[1].cost)
  lines.push(...table(
    ['Provider', '调用', '输入', '缓存命中', '输出', '花费'],
    [
      ...providers.map(([provider, b]) => [
        provider, num(b.calls), num(b.input), num(b.cacheRead), num(b.output), money.format(b.cost),
      ]),
      [
        '**总计**', `**${num(report.total.calls)}**`, `**${num(report.total.input)}**`,
        `**${num(report.total.cacheRead)}**`, `**${num(report.total.output)}**`,
        `**${money.format(report.total.cost)}**`,
      ],
    ],
  ))

  const models = [...report.byModel].sort((a, b) => b[1].cost - a[1].cost)
  if (models.length > 1) {
    lines.push('')
    lines.push('按 model：')
    lines.push(...table(
      ['Model', '调用', '花费'],
      models.map(([model, b]) => [model, num(b.calls), money.format(b.cost)]),
    ))
  }

  lines.push('')
  lines.push(money.converts
    ? `> 计价：DeepSeek 官方价（USD / 每百万 token，取自 pi-ai 内置目录）按 1 USD = ${money.cnyPerUsd} CNY 折算为${money.label}`
    : '> 计价：DeepSeek 官方价（USD / 每百万 token，取自 pi-ai 内置目录）')
  if (money.converts) lines.push(`> 未折算的原始金额：$${report.total.cost.toFixed(4)} USD`)
  if (money.fellBack) {
    lines.push('> ⚠️ 配置了 `currency: CNY` 但未提供 `cnyPerUsd`，已回退为美元显示')
  }
  lines.push(
    `> 统计 ${num(report.steps)} 步 · ${num(report.sessions)} 个会话`,
  )
  if (report.asOf !== undefined && report.asOf !== null) {
    const at = new Date(report.asOf).toLocaleTimeString('zh-CN')
    lines.push(`> 数据截至 ${at}${report.refreshing === true ? '（正在后台更新…）' : ''}`)
  }
  if (report.projected !== undefined) {
    lines.push(
      `> 数据来源：投影 ${num(report.projected)} 个会话 · 扫描 ${num(report.scanned)} 个` +
      `（复用缓存 ${num(report.reused)}）· 耗时 ${report.elapsedMs} ms`,
    )
  }
  if (report.unreadable > 0) {
    lines.push(`> ⚠️ ${num(report.unreadable)} 个会话读取失败，已跳过`)
  }
  if (report.unpriced.size > 0) {
    lines.push(`> ⚠️ 未定价（按 $0 计，花费被低估）：${[...report.unpriced].join('、')}`)
  }
  return lines.join('\n')
}
