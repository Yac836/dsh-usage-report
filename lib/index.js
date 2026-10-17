/**
 * `/usage` —— 按 provider / model 汇总 token 用量与花费。
 *
 * 这是一个 host 侧的 Cordis 函数插件（DSH 插件的最小形态）：导出
 * `name` / `inject` / `Config` / `apply`，注册动作放进 `ctx.effect` 以便卸载时自动撤销。
 *
 * 两个出口，同一份聚合逻辑：
 *   1. `/usage [天数]` 斜杠命令 —— 在任何有命令注册表的 profile 里可用。
 *   2. `GET /api/usage.report` —— 供 Web 设置页的「用量」面板读取 JSON。
 *      路由注册嵌在 `ctx.inject(['connection'])` 里，因此没有 Web 连接的
 *      profile 不会因子依赖缺失而整体挂起，命令照常可用。
 *
 * 币种：聚合层始终以 USD 为规范量（官方价的单位），只在展示层换算。
 */
import z from '@deepseek-ai/schemastery'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import { aggregateUsage, parseWindow, toReportJson } from './aggregate.js'
import { createUsageCache } from './cache.js'
import { createMoney } from './currency.js'
import { USAGE_PROJECTION_VERSION, usageProjectionDefinition } from './projection.js'
import { renderUsage } from './render.js'

/**
 * 兜底缓存的文件位置。用官方的 `dshCachePath` 解析（尊重 `$DSH_HOME`），
 * 落在 Harness home 的 `cache/` 下 —— 那是可重建数据该待的地方。
 * 解析失败就退化为纯内存缓存，不影响功能。
 */
function resolveCacheFile() {
  try {
    return dshCachePath('dsh-usage-report', 'fallback-cache.json')
  } catch {
    return undefined
  }
}

/** Cordis 插件名。 */
export const name = 'usage-report'

/**
 * 硬依赖只有两个：命令注册表与跨会话读。
 * `sessions` / `sessionProjections` / `sessionPersistence` 一律用 `ctx.get()` / 嵌套 `ctx.inject`
 * 软访问 —— 缺了它们只是退化为「兜底扫描 + 无缓存」，而不是插件加载失败。
 */
export const inject = ['commands', 'sessionQuery']

/**
 * 展示币种。
 *
 * 默认 **USD**：pi-ai 目录里的价格单位就是美元，开源版本不内置任何人为汇率。
 * 想让面板与国内控制台一致（人民币）时设 `currency: CNY` 并给出 `cnyPerUsd`——
 * 汇率是个人/账务口径，必须由使用者提供，不能由代码猜。
 */
export const Config = z.object({
  currency: z.union([z.const('CNY'), z.const('USD')]).default('USD'),
  /** 1 USD 折合多少 CNY，仅在 `currency: CNY` 时使用；省略则回退为 USD 显示。 */
  cnyPerUsd: z.number().min(0.01),
  /**
   * 启动后在后台预热默认区间（全部历史）。冷启动要重读"变过的会话"，
   * 实测 4 个会话 6.3 秒；预热把这段时间挪出请求路径，面板因此不必等待。
   * 设为 false 可关闭（例如只在需要时才算）。
   */
  warmup: z.boolean().default(true),
  /** 预热延迟（毫秒）。默认 2 秒，避开启动本身最忙的那一段。 */
  warmupDelayMs: z.number().min(0).default(2_000),
  /** 快照多久算"新鲜"。超过就立刻返回旧快照并在后台刷新（stale-while-revalidate）。 */
  ttlMs: z.number().min(0).default(30_000),
})

/** 设置页面板读取的 JSON 路由（Connection 拥有 `/api` 前缀）。 */
export const REPORT_ROUTE = '/api/usage.report'

const USAGE_HINT = '用法：`/usage`（全部历史）、`/usage 7`（最近 7 天）、`/usage 2026-10-01..2026-10-15`（自定义区间）。'
const REFRESH_ERROR = '用量刷新失败，请重试。'

/**
 * 解析命令参数。三种形式：空 → 全部历史；`N` → 最近 N 天；`起..止` → 自定义区间。
 * @returns 窗口参数；非法返回 `null`。
 */
function parseRangeArgument(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return {}
  if (/^\d+$/.test(text)) {
    const days = Number(text)
    return days > 0 ? { days } : null
  }
  const separator = text.indexOf('..')
  if (separator === -1) return null
  const from = text.slice(0, separator).trim()
  const to = text.slice(separator + 2).trim()
  return parseWindow({ from: from === '' ? undefined : from, to: to === '' ? undefined : to })
}

/** 把窗口参数压成快照缓存的键。 */
const windowKey = (range) =>
  range.days !== undefined
    ? `days:${range.days}`
    : range.from !== undefined || range.to !== undefined
      ? `range:${range.from ?? ''}:${range.to ?? ''}`
      : 'all'

export function apply(ctx, config) {
  const money = createMoney(config)
  // 兜底路径（投影读不到/不可信的会话）的会话级缓存：
  // 内存 LRU + 磁盘持久化，按持久化层 stat 派生 revision 失效。详见 cache.js。
  const cache = createUsageCache({
    file: resolveCacheFile(),
    stateVersion: USAGE_PROJECTION_VERSION,
  })

  // 注册投影单元：宿主据此**增量**维护每个会话的按 provider/model 用量
  // （每个新提交事件只调一次 fold），并把状态落盘。
  // 用嵌套 inject 保持可选性（DSH 架构文档推荐的写法）：缺该服务时命令照常可用。
  ctx.inject(['sessionProjections'], (child) => {
    child.sessionProjections.register(usageProjectionDefinition)
  })

  // ---- 快照缓存（stale-while-revalidate）--------------------------------
  // 冷启动时"哪些会话变了"必须整份重读，实测 4 个会话就要 6.3 秒（DSH 的 readSession
  // 要做重放校验 + 逐事件克隆，比裸解析慢 4–5 倍）。把这段时间挪出请求路径：
  // 有旧快照就立刻返回它（并后台刷新），没有就返回 refreshing 让面板稍后重试。
  const snapshots = new Map()
  const inflight = new Map()
  const failedRefreshes = new Set()
  const ttlMs = Number.isFinite(config?.ttlMs) && config.ttlMs >= 0 ? config.ttlMs : 30_000
  const refreshAfterMs = Math.min(3_600_000, Math.max(30_000, ttlMs))

  const refresh = (key, range) => {
    const existing = inflight.get(key)
    if (existing !== undefined) return existing
    failedRefreshes.delete(key)
    const promise = aggregateUsage(ctx, { ...range, cache })
      .then((report) => {
        const snapshot = { report, asOf: Date.now() }
        snapshots.set(key, snapshot)
        return snapshot
      })
      .catch(() => {
        failedRefreshes.add(key)
        // 宿主异常可能带路径或敏感上下文，用户界面只返回固定提示。
        throw new Error(REFRESH_ERROR)
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }

  /**
   * 取一份报告。
   * @param wait - 命令始终等待本次聚合（同区间共享正在运行的任务）。
   * @param pollOnly - 面板等任务结束时不对已有快照再次触发聚合，ttlMs=0 也能结束轮询。
   */
  const readSnapshot = async (range, { wait, pollOnly = false }) => {
    const key = windowKey(range)
    if (wait) return { ...await refresh(key, range), refreshing: false }
    const cached = snapshots.get(key)
    if (cached !== undefined) {
      const fresh = Date.now() - cached.asOf < ttlMs
      if (!pollOnly && !fresh && !failedRefreshes.has(key)) void refresh(key, range).catch(() => {})
      return {
        ...cached,
        refreshing: inflight.has(key),
        refreshError: failedRefreshes.has(key) ? REFRESH_ERROR : undefined,
      }
    }
    if (failedRefreshes.has(key)) {
      return { report: undefined, asOf: undefined, refreshing: false, refreshError: REFRESH_ERROR }
    }
    void refresh(key, range).catch(() => {})
    return { report: undefined, asOf: undefined, refreshing: true }
  }

  // 启动预热：把默认区间（全部历史）先在后台算好，用户打开面板时就有快照可用。
  // 延迟一点再跑，避免与启动本身抢 IO。可用 config.warmup=false 关闭。
  if (config?.warmup !== false) {
    const delay = Number.isFinite(config?.warmupDelayMs) ? config.warmupDelayMs : 2_000
    const timer = setTimeout(() => {
      void readSnapshot({}, { wait: true }).catch(() => {})
    }, delay)
    timer.unref?.()
    ctx.effect(() => () => clearTimeout(timer), 'usage-report: warm-up')
  }

  const handler = async ({ rawInput, signal }) => {
    const range = parseRangeArgument(rawInput)
    if (range === null) return { kind: 'error', text: USAGE_HINT }
    try {
      const { report, asOf, refreshing } = await readSnapshot(range, { wait: true })
      void signal
      return { kind: 'success', text: renderUsage({ ...report, asOf, refreshing }, money) }
    } catch {
      return { kind: 'error', text: REFRESH_ERROR }
    }
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'usage',
      description: '按 provider 汇总 token 用量与估算费用（DeepSeek 官方价）',
      input: { hint: '[天数 | 起..止]' },
      handler,
    })
  }, 'usage-report: /usage')

  // 只有挂了 Web 连接的 profile 才注册 HTTP 路由。
  ctx.inject(['connection'], (child) => {
    child.effect(() => child.connection.fetch.register({
      path: REPORT_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const params = new URL(request.url).searchParams
        const rawDays = params.get('days')
        const range = parseWindow({
          days: rawDays === null ? undefined : Number(rawDays),
          from: params.get('from') ?? undefined,
          to: params.get('to') ?? undefined,
        })
        if (range === null) {
          return Response.json({ error: 'days 必须是正整数；from/to 必须是 YYYY-MM-DD' }, { status: 400 })
        }
        try {
          // ?force=1：面板点「刷新」时立刻启动一次刷新（旧快照先返回，它随后轮询），
          // 而不是让请求干等一次冷扫描。
          if (params.get('force') !== null) void refresh(windowKey(range), range).catch(() => {})
          // 面板不等计算：有快照就给（可能略旧），没有就让它稍后重试
          const { report, asOf, refreshing, refreshError } = await readSnapshot(range, {
            wait: false,
            pollOnly: params.get('poll') === '1',
          })
          if (report === undefined) {
            if (refreshError !== undefined) {
              return Response.json({ error: refreshError, refreshing: false, asOf: null }, { status: 503 })
            }
            return Response.json({
              refreshing: true,
              asOf: null,
              range: { days: range.days ?? null, from: range.from ?? null, to: range.to ?? null },
            })
          }
          return Response.json({ ...toReportJson(report, money), asOf, refreshing, refreshError, refreshAfterMs })
        } catch {
          return Response.json({ error: REFRESH_ERROR }, { status: 500 })
        }
      },
    }), 'usage-report: /api/usage.report')
  })
}
