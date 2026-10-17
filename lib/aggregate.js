/**
 * 跨会话用量聚合。
 *
 * **投影优先**：活跃会话的状态由宿主的 `ctx.sessionProjections` 增量维护
 * （每个新提交的事件只调一次 `apply`），读取零 IO，见 projection.js。
 *
 * **兜底扫描**：满足下面任一情况时退回读日志 + 本地折叠，并按持久化层
 * stat 派生的 revision 缓存结果（见 cache.js）：
 *  - 会话没有挂载到本进程（冷会话）——宿主没有暴露 host-only 单元在磁盘缓存上的读取入口；
 *  - 投影状态经 `isUsageStateComplete` 判定不完整或口径不对（注册晚于会话、或懒折进了
 *    fork 继承前缀）。
 * 两条路径共用 projection.js 里的同一个 fold，因此结果逐位一致。
 *
 * **金额不在投影里**：投影只 fold 原始 token（按 provider/model/自然日），
 * 金额在读取时按当前 pi-ai 目录现算 —— pi-ai 调过价（flash $0.14 → $0.30），
 * 若把金额固化进投影，旧价会永远留在磁盘上。
 *
 * **窗口口径**：按本地自然日，`days` 表示「最近 N 个自然日（含今天）」。
 * 这是为把投影状态压到最小（跨会话遍历才可能零成本），也与用量面板的日粒度一致。
 */
import { createPricing, costOf } from './pricing.js'
import { USAGE_PROJECTION_KEY, dayKeyOf, foldUsageEvents, isUsageStateComplete } from './projection.js'

/**
 * 聚合桶。注意 `cost` 必须初始化：
 * 它不是投影状态的一部分（金额永远现算），但累加时要有个 0 起点，
 * 否则 `bucket.cost += cost` 会得到 NaN。
 */
const emptyBucket = () => ({
  calls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
})

/** 把一个自然日的桶累加进目标桶（只累加 token，金额由调用方按当前目录单独累加）。 */
const addBucket = (target, source) => {
  target.calls += source.calls
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

/** 桶 → `costOf` 认识的用量形状（字段名沿用日志口径）。 */
const toUsage = (bucket) => ({
  inputTokens: bucket.input,
  outputTokens: bucket.output,
  cacheReadTokens: bucket.cacheRead,
  cacheWriteTokens: bucket.cacheWrite,
})

/** 冷扫描的并发上限：读取是 IO 密集，但不宜与前台 agent 抢 IO。 */
const SCAN_CONCURRENCY = 4

/** 有界并发映射：保持结果顺序，且不会一次把所有会话都读进内存。 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 取一个会话的投影状态。两条路都**同步且零 IO**：
 *  - 活动会话（挂载在本进程）：`sessionProjections.snapshot()` 读内存单元状态，
 *    缺失的 cell 由宿主懒折；
 *  - 冷会话：`sessionProjectionCache.cachedSnapshot()` 读 durable 投影缓存（水位缓存），
 *    因此**重启之后也不必重扫日志**。
 * 两者都读不到时返回 undefined，交给兜底扫描。
 *
 * 完整性判据所需的 `inheritedEventCount` 对冷会话不另行获取：状态自己在 `init` 时
 * 就记下了它（`state.inherited`），`isUsageStateComplete` 会优先采用。
 */
function readProjection(ctx, entry) {
  const session = entry.session
  const inheritedEventCount = Number.isInteger(session?.inheritedEventCount) ? session.inheritedEventCount : undefined
  const snapshot = session !== undefined
    ? ctx.get('sessionProjections')?.snapshot(session, [USAGE_PROJECTION_KEY])
    : ctx.get('sessionProjectionCache')?.cachedSnapshot(entry.header, [USAGE_PROJECTION_KEY])
  return { state: snapshot?.values?.[USAGE_PROJECTION_KEY], inheritedEventCount }
}

/**
 * 枚举待统计的会话 —— **只走一遍持久化列表**。
 *
 * 为什么重要：`sessionQuery.listSessions()` 与 `sessionPersistence.list()` 各自都要
 * 遍历会话目录、读每个日志的 header、并逐个 stat（实测每会话约 1 ms）。两处都调
 * 等于把这笔固定开销翻倍，而且随会话数线性增长（200 个会话就是数百毫秒）。
 *
 * 冷会话来自持久化列表（顺带拿到失效用的 revision）；活动会话另外从 `sessions`
 * 注册表取 —— 它们可能还没落盘，但状态在内存里，读投影零 IO。
 * 持久化服务不可用时退回高层 `listSessions()`（此时没有 revision，也就没有缓存可用）。
 *
 * @returns `[{ header, revision?, session? }]`
 */
async function enumerateSessions(ctx, signal) {
  const registry = ctx.get('sessions')
  const revisions = new Map()
  const persistence = ctx.get('sessionPersistence')
  if (typeof persistence?.list === 'function') {
    try {
      for (const snapshot of await persistence.list()) revisions.set(snapshot.header.id, snapshot.revision)
    } catch {
      // 失去缓存能力，但不能让统计失败
    }
  }

  // 用高层的 listSessions()：它给出的 live 标记是权威的。
  // （曾为省一次列举改成自己拼注册表，结果活动会话不再走零 IO 的内存投影，
  //   每次都被当冷会话整份重读 —— 几秒的回归就是它。性能不能拿正确性换。）
  const records = await ctx.sessionQuery.listSessions(signal)
  return records.map((record) => ({
    header: record.header,
    revision: revisions.get(record.header.id),
    session: registry?.get?.(record.header.id),
  }))
}

/** `YYYY-MM-DD`。 */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 热力图序列覆盖的天数上限（53 周）。再长对"看形状"没有增量，只会撑大状态。 */
export const HEATMAP_DAYS = 371

/**
 * 解析统计窗口。三种形式：
 *  - 都省略 → 全部历史
 *  - `days: N` → 最近 N 个自然日（含今天）
 *  - `from` / `to`（`YYYY-MM-DD`）→ 自定义日期区间；`to` 省略表示到今天
 *
 * 为什么按自然日而不是滚动小时：投影状态按本地自然日分桶，这是把它压到最小的前提
 * （跨会话遍历才可能零成本）；日界对用量报表也够用。
 *
 * @returns `{ days?, from?, to?, fromDay?, toDay? }`；非法输入返回 `null`。
 */
export function parseWindow({ days, from, to } = {}) {
  if (days !== undefined && days !== null) {
    if (!Number.isInteger(days) || days < 1) return null
    return { days, fromDay: dayKeyOf(Date.now() - (days - 1) * 86_400_000), toDay: undefined }
  }
  const hasFrom = from !== undefined && from !== null && from !== ''
  const hasTo = to !== undefined && to !== null && to !== ''
  if (!hasFrom && !hasTo) return { fromDay: undefined, toDay: undefined }
  if (hasFrom && !DAY_PATTERN.test(String(from))) return null
  if (hasTo && !DAY_PATTERN.test(String(to))) return null
  if (hasFrom && hasTo && String(from) > String(to)) return null
  return {
    ...(hasFrom ? { from: String(from) } : {}),
    ...(hasTo ? { to: String(to) } : {}),
    fromDay: hasFrom ? String(from) : undefined,
    toDay: hasTo ? String(to) : undefined,
  }
}

/**
 * 汇总所有会话的用量与花费。
 *
 * @param ctx - 需已注入 `sessionQuery`；注入了 `sessions`/`sessionProjections` 才能走投影。
 * @param options.days - 最近 N 个自然日（含今天）。
 * @param options.from - 自定义区间起点（`YYYY-MM-DD`）。
 * @param options.to - 自定义区间终点（`YYYY-MM-DD`，含当天）。
 * @param options.signal - 取消信号。
 * @param options.overrides - 传给定价模块的模型覆盖。
 * @param options.cache - 兜底路径的会话级缓存，省略则不缓存。
 * @returns 聚合结果；`projected`/`scanned`/`reused`/`elapsedMs` 用于观测成本。
 * @throws 窗口非法时抛错（调用方应先经 `parseWindow` 校验）。
 */
export async function aggregateUsage(ctx, { days, from, to, signal, overrides, cache } = {}) {
  const pricing = createPricing(overrides)
  const window = parseWindow({ days, from, to })
  if (window === null) throw new Error('统计窗口非法：days 必须是正整数，或 from/to 为 YYYY-MM-DD')
  const startedAt = Date.now()

  // 清单与 live 标记走高层 listSessions()（live 标记是权威的），revision 另从持久化列表取
  const records = await enumerateSessions(ctx, signal)
  cache?.retain(new Set(records.map((entry) => entry.header.id)))

  let projected = 0
  let scanned = 0
  let reused = 0
  let unreadable = 0

  const states = await mapWithConcurrency(records, SCAN_CONCURRENCY, async (entry) => {
    // 1) 宿主维护的投影（活动会话读内存、冷会话读 durable 缓存，都是零 IO）
    const projection = readProjection(ctx, entry)
    if (isUsageStateComplete(projection.state, projection.inheritedEventCount)) {
      projected += 1
      return projection.state
    }

    // 2) 兜底：读日志并本地折叠，结果按 revision 缓存
    const id = entry.header.id
    const revision = entry.revision
    const cacheable = cache !== undefined && revision !== undefined
    if (cacheable) {
      const hit = cache.get(id, revision)
      if (hit !== undefined) {
        reused += 1
        return hit
      }
    }

    let snapshot
    try {
      snapshot = await ctx.sessionQuery.readSession(id)
    } catch {
      // 单个会话损坏不应让整条命令失败，只做计数。
      unreadable += 1
      return undefined
    }

    const inheritedEventCount = snapshot.inheritedEventCount ?? 0
    // 继承段已计入父会话，必须整段跳过，否则重复计费
    const state = foldUsageEvents(snapshot.events.slice(inheritedEventCount), inheritedEventCount)
    if (cacheable) cache.set(id, revision, state)
    scanned += 1
    return state
  })

  const { fromDay, toDay } = window
  const byProvider = new Map()
  const byModel = new Map()
  const unpriced = new Set()
  /** 按自然日的长期序列（热力图用），升序；上限 53 周。 */
  const series = new Map()
  const heatmapFloor = dayKeyOf(Date.now() - HEATMAP_DAYS * 86_400_000)

  let sessions = 0
  let steps = 0
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY

  for (const state of states) {
    if (state === undefined) continue
    sessions += 1

    let contributed = false
    for (const route of Object.values(state.routes)) {
      const key = `${route.provider}/${route.model}`
      const priced = pricing.resolve(route.provider, route.model)
      if (!priced.model) unpriced.add(key)

      let window = null
      for (const [day, bucket] of Object.entries(route.days)) {
        // 金额与"天"无关，同一路由同价，所以可以对这一天的桶直接定价
        const dayCost = costOf(priced, toUsage(bucket))?.total ?? 0

        // 长期按天序列（热力图的数据源）：**刻意不随区间收窄**。
        // 否则选"近 7 天"时热力图只剩一列，而它存在的意义就是看长期形状。
        // 上限 53 周，避免状态无限增长。
        if (day >= heatmapFloor) {
          const entry =
            series.get(day) ?? { day, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
          entry.calls += bucket.calls
          entry.input += bucket.input
          entry.output += bucket.output
          entry.cacheRead += bucket.cacheRead
          entry.cacheWrite += bucket.cacheWrite
          entry.cost += dayCost
          series.set(day, entry)
        }

        // 区间桶（卡片与表格用）：字符串比较即可，YYYY-MM-DD 的字典序与时间序一致
        if (fromDay !== undefined && day < fromDay) continue
        if (toDay !== undefined && day > toDay) continue
        window = window ?? emptyBucket()
        addBucket(window, bucket)
      }
      if (window === null) continue
      contributed = true
      steps += window.calls

      const cost = costOf(priced, toUsage(window))?.total ?? 0

      if (!byProvider.has(route.provider)) byProvider.set(route.provider, emptyBucket())
      addBucket(byProvider.get(route.provider), window)
      byProvider.get(route.provider).cost += cost

      if (!byModel.has(key)) byModel.set(key, emptyBucket())
      addBucket(byModel.get(key), window)
      byModel.get(key).cost += cost
    }

    if (contributed) {
      if (state.first !== null) first = Math.min(first, state.first)
      if (state.last !== null) last = Math.max(last, state.last)
    }
  }

  const total = emptyBucket()
  for (const bucket of byProvider.values()) {
    total.calls += bucket.calls
    total.input += bucket.input
    total.output += bucket.output
    total.cacheRead += bucket.cacheRead
    total.cacheWrite += bucket.cacheWrite
    total.cost += bucket.cost
  }

  // 一次聚合只落盘一次（冷扫描期间会 set 很多次）
  cache?.flush()

  return {
    byProvider,
    byModel,
    total,
    unpriced,
    series: [...series.values()].sort((a, b) => a.day.localeCompare(b.day)),
    sessions,
    unreadable,
    steps,
    days: window.days,
    from: window.from,
    to: window.to,
    windowMode: 'calendar-day',
    first: Number.isFinite(first) ? first : undefined,
    last: Number.isFinite(last) ? last : undefined,
    pricingProvider: pricing.provider,
    currency: 'USD',
    unit: '每百万 token',
    projected,
    scanned,
    reused,
    elapsedMs: Date.now() - startedAt,
    cachedSessions: cache?.size ?? 0,
  }
}

/**
 * 把聚合结果转成可 JSON 序列化的形状（Map → 数组）。
 * HTTP 路由与渲染层共用，保证两边数据一致。
 */
export function toReportJson(report, money) {
  const bucket = (b) => ({
    calls: b.calls,
    input: b.input,
    output: b.output,
    cacheRead: b.cacheRead,
    cacheWrite: b.cacheWrite,
    // cost 是展示币种金额；costUsd 保留原始 USD（官方价的单位），便于逐项核对
    cost: money.fromUsd(b.cost),
    costUsd: b.cost,
  })
  return {
    range: {
      days: report.days ?? null,
      from: report.from ?? null,
      to: report.to ?? null,
      windowMode: report.windowMode ?? 'calendar-day',
      first: report.first ?? null,
      last: report.last ?? null,
    },
    money: {
      currency: money.currency,
      symbol: money.symbol,
      cnyPerUsd: money.cnyPerUsd,
      converts: money.converts,
      fellBack: money.fellBack,
      label: money.label,
    },
    total: bucket(report.total),
    providers: [...report.byProvider]
      .map(([provider, b]) => ({ provider, ...bucket(b) }))
      .sort((a, b) => b.cost - a.cost),
    models: [...report.byModel]
      .map(([key, b]) => {
        const slash = key.indexOf('/')
        return { provider: key.slice(0, slash), model: key.slice(slash + 1), ...bucket(b) }
      })
      .sort((a, b) => b.cost - a.cost),
    unpriced: [...report.unpriced],
    // 按天序列：cost 用展示币种，costUsd 保留原始美元
    series: (report.series ?? []).map((entry) => ({
      ...entry,
      cost: money.fromUsd(entry.cost),
      costUsd: entry.cost,
    })),
    sessions: report.sessions,
    unreadable: report.unreadable,
    steps: report.steps,
    currency: report.currency,
    unit: report.unit,
    scan: {
      projected: report.projected ?? 0,
      scanned: report.scanned ?? 0,
      reused: report.reused ?? 0,
      elapsedMs: report.elapsedMs ?? 0,
      cachedSessions: report.cachedSessions ?? 0,
    },
  }
}
