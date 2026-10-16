/**
 * `usageReport` 会话投影单元 —— 本插件的性能基石。
 *
 * 为什么用投影而不是自己扫日志：`sessionQuery.readSession` 会重放校验整个日志，
 * 而 DSH 自身的缓存只覆盖「相邻两步之间在飞的会话」（持久化层 2 条、sessionQuery 5 条）。
 * 改用投影后，宿主对每个**新提交**的事件只调一次 `apply(prev, event)`（真增量），
 * 把结果落盘到 `~/.dsh/storages/session_projcache/`，跨会话读取零 IO。
 * 官方的 `dsh-token-meter` / `dsh-session-stats` 就是这么实现的。
 *
 * 三条不能破的约束（抄自官方单元的实现）：
 *  1. **不关心的事件必须返回同一个 state 引用** —— 宿主用 `Object.is` 作为变更闸门。
 *  2. **state 必须是可 JSON 序列化的纯数据** —— 它会被写入磁盘缓存并被 `stateSchema` 校验。
 *  3. **`apply` 必须是纯函数** —— 宿主可能在任意水位重放它。
 *
 * 另外三点本单元特有的设计：
 *  - **只 fold 原始 token，不 fold 金额**。pi-ai 目录调过价（flash 从 $0.14 到 $0.30），
 *    金额若固化进投影，旧价会永远留在磁盘上。金额一律在读取时按当前目录现算。
 *  - **完整性水位是 `headSeq`**（本单元见到的第一个事件的 seq，不限于计费事件）。
 *    宿主对新注册的单元是在会话**下一次提交事件**时才 `init()` 的，因此对「安装插件之前
 *    就存在的会话」，投影可能只覆盖注册之后的事件，也可能在懒折时连 fork 继承前缀一起折进去。
 *    判据见 {@link isUsageStateComplete}：只有 `headSeq === inherited` 才可信。
 *    注意 `firstSeq` / `lastSeq` 只是**诊断用途**（第一/最后一个计费事件的 seq），
 *    不是判据 —— 因为第一个自有事件往往不计费，用 `firstSeq` 会误判。
 *  - **四个 token 桶彼此不相交**：`inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`
 *    才是完整提示+输出量（这是宿主自己的口径，见 `dsh-token-meter` 的 `usageTokens`：
 *    "Sum disjoint provider usage buckets without double-counting reasoning output"）。
 *    所以桶必须分列存储，不能在 fold 时先求和 —— 求和会丢掉按各自单价计费的能力。
 *    另外 `outputTokens` **已包含** reasoning token（适配器不另设 `reasoningTokens`，
 *    且实测输出数与官方账单逐位相等），不能重复计。
 *
 * 窗口口径：state 按**本地自然日**分桶，因此 `days` 是「最近 N 个自然日（含今天）」，
 * 而不是滚动的 N×24 小时。这是为了把投影状态压到最小（跨会话遍历才可能零成本），
 * 也与用量面板的日粒度语义一致。
 */
import { z } from 'zod'

/** 投影单元的键。刻意不在 `SessionProjectionMap` 里 —— 这是只有 host 半用的单元（无 `wire`）。 */
export const USAGE_PROJECTION_KEY = 'usageReport'

/** 折叠语义的版本。**任何**语义改动都必须 +1，否则磁盘上的旧行会被当作有效数据。 */
export const USAGE_PROJECTION_VERSION = 2

const UNKNOWN = '(未知)'

const bucketSchema = z.object({
  calls: z.number().int().nonnegative(),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
}).strict()

const routeSchema = z.object({
  provider: z.string(),
  model: z.string(),
  /** 本地自然日（YYYY-MM-DD）→ 该日的计费桶。 */
  days: z.record(z.string(), bucketSchema),
}).strict()

/**
 * 折叠状态。完整性靠两个水位自描述：
 *  - `inherited`：`init` 收到的 fork 继承前缀长度；
 *  - `headSeq`：本单元**见到的第一个事件**的 seq（不限于计费事件）。
 * 判据见 {@link isUsageStateComplete}。
 */
export const usageStateSchema = z.object({
  steps: z.number().int().nonnegative(),
  inherited: z.number().int().nonnegative().nullable(),
  headSeq: z.number().int().nonnegative().nullable(),
  firstSeq: z.number().int().nonnegative().nullable(),
  lastSeq: z.number().int().nonnegative().nullable(),
  first: z.number().nonnegative().nullable(),
  last: z.number().nonnegative().nullable(),
  routes: z.record(z.string(), routeSchema),
}).strict()

const EMPTY_BUCKET = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** 空状态（`apply` 的起点）。 */
export const initUsageState = () => ({
  steps: 0,
  inherited: null,
  headSeq: null,
  firstSeq: null,
  lastSeq: null,
  first: null,
  last: null,
  routes: {},
})

/** 本地自然日键。用本地时区，与用户看到的「今天」一致。 */
export function dayKeyOf(time) {
  const date = new Date(time)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 路由键：仅作为 map 键，真值存在值里，避免 provider 含 `/` 时的拆分歧义。 */
export const routeKeyOf = (provider, model) => `${provider}\u0000${model}`

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)

/** 这个事件是否携带可计费用量。 */
const isBillable = (event) =>
  event?.type === 'assistant/message' &&
  event.data?.usage !== undefined &&
  typeof event.data.usage.inputTokens === 'number'

/**
 * 折叠一个事件。
 *
 * 除「首次记录 headSeq」外，无关事件一律返回**同一引用**（宿主的 `Object.is` 闸门依赖这一点）；
 * 记录 headSeq 每会话至多发生一次，代价可忽略，却让完整性判据变成精确等式。
 *
 * @param state - 上一状态。
 * @param event - 会话事件。
 * @returns 新状态，或原状态引用。
 */
export function applyUsageEvent(state, event) {
  const seq = Number.isInteger(event?.seq) ? event.seq : null
  const headSeq = state.headSeq === null && seq !== null ? seq : state.headSeq

  if (!isBillable(event)) {
    return headSeq === state.headSeq ? state : { ...state, headSeq }
  }

  const usage = event.data.usage
  const source = event.data?.message?.source ?? {}
  const provider = typeof source.provider === 'string' && source.provider !== '' ? source.provider : UNKNOWN
  const model = typeof source.model === 'string' && source.model !== '' ? source.model : UNKNOWN
  const time = finite(event.time)
  const day = dayKeyOf(time)
  const routeKey = routeKeyOf(provider, model)

  const previousRoute = state.routes[routeKey]
  const previous = previousRoute?.days?.[day] ?? EMPTY_BUCKET
  const bucket = {
    calls: previous.calls + 1,
    input: previous.input + finite(usage.inputTokens),
    output: previous.output + finite(usage.outputTokens),
    cacheRead: previous.cacheRead + finite(usage.cacheReadTokens),
    cacheWrite: previous.cacheWrite + finite(usage.cacheWriteTokens),
  }

  return {
    steps: state.steps + 1,
    inherited: state.inherited,
    headSeq,
    firstSeq: state.firstSeq === null ? seq : state.firstSeq,
    lastSeq: seq === null ? state.lastSeq : seq,
    first: state.first === null ? time : Math.min(state.first, time),
    last: state.last === null ? time : Math.max(state.last, time),
    routes: {
      ...state.routes,
      [routeKey]: {
        provider,
        model,
        days: { ...(previousRoute?.days ?? {}), [day]: bucket },
      },
    },
  }
}

/**
 * 宿主注册用的定义。
 *
 * `wire` 的视图就是状态本身。**声明 wire 不是为了让客户端看，而是必需的**：
 * 只有带 `wire` 的单元才能通过 `sessionProjectionCache.cachedSnapshot()` 从 durable
 * 投影缓存里读回来 —— 而这正是「重启之后不必重扫日志」唯一可用的路径
 * （host-only 单元没有对外的磁盘读取入口，只能由调用方自己喂事件冷折）。
 * 代价可忽略：状态很小（实测 15 个会话合计 5.8 KB）。
 */
export const usageProjectionDefinition = {
  key: USAGE_PROJECTION_KEY,
  stateVersion: USAGE_PROJECTION_VERSION,
  stateSchema: usageStateSchema,
  init: (_header, inheritedEventCount) => ({
    ...initUsageState(),
    inherited: Number.isInteger(inheritedEventCount) ? inheritedEventCount : null,
  }),
  apply: applyUsageEvent,
  wire: {
    viewSchema: usageStateSchema,
    view: (state) => state,
  },
}

/**
 * 本地折叠（兜底路径复用同一个 fold，保证两条路径语义完全一致）。
 *
 * @param events - 已剔除 fork 继承段的事件。
 * @param inheritedEventCount - 该会话继承前缀长度；写进状态以便自描述完整性。
 * @returns 与投影同形状的状态。
 */
export function foldUsageEvents(events, inheritedEventCount = null) {
  let state = {
    ...initUsageState(),
    inherited: Number.isInteger(inheritedEventCount) ? inheritedEventCount : null,
  }
  for (const event of events) state = applyUsageEvent(state, event)
  return state
}

/**
 * 投影状态是否是这个会话的**完整且口径正确**的真值。
 *
 * 为什么需要：宿主对后注册的单元是在会话首次触碰时懒折的，而索引式折叠
 * 既可能从头折进 fork 继承前缀（→ 与父会话重复计费），也可能只覆盖注册之后的事件
 * （→ 漏算）。两种偏差都能由 `headSeq` 与 `inherited` 精确识别：
 *
 * | 关系 | 含义 | 可否信任 |
 * |---|---|---|
 * | `headSeq === inherited` | 恰好从本会话第一个自有事件开始 | ✅ |
 * | `headSeq > inherited` | 头部缺失（注册晚于会话、或懒折只覆盖了一部分） | ❌ 走兜底扫描 |
 * | `headSeq < inherited` | 折进了继承前缀，会与父会话重复计费 | ❌ 走兜底扫描 |
 * | `headSeq === null` | 本单元**一个事件都没见过** | ❌ 走兜底扫描 |
 *
 * 最后一行尤其重要：空状态既可能是"这个会话确实没有计费事件"，也可能是"单元从未跑过"。
 * 二者无法从状态区分，因此一律不信任 —— 宁可多读一次日志，也不能静默少算。
 * 反过来，"有自有事件但都不计费"是安全的：那也会记录 headSeq。
 *
 * @param state - 读取到的投影状态（可为 undefined）。
 * @param inheritedEventCount - 该会话 fork 继承的前缀长度。
 * @returns 是否可以安全地把它当作该会话的全量真值。
 */
export function isUsageStateComplete(state, inheritedEventCount) {
  if (state === undefined || state === null) return false
  if (state.headSeq === null) return false
  const expected = Number.isInteger(state.inherited) ? state.inherited : inheritedEventCount
  return state.headSeq === expected
}
