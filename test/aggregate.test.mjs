/**
 * 聚合层的测试。
 *
 * 最重要的一条：**投影路径与兜底扫描路径必须给出逐位一致的结果** ——
 * 否则「快」就是拿正确性换来的。这里用同一批合成事件走两条路对比。
 *
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { aggregateUsage, parseWindow } from '../lib/aggregate.js'
import { createUsageCache } from '../lib/cache.js'
import { USAGE_PROJECTION_KEY, dayKeyOf, foldUsageEvents } from '../lib/projection.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const billable = ({ seq, time, provider = 'gateway-a', model = 'deepseek-v4-flash', input = 1000, output = 100, cacheRead = 0, cacheWrite = 0 }) => ({
  type: 'assistant/message',
  seq,
  time,
  data: {
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    message: { source: { provider, model } },
  },
})

/**
 * 造一个桩上下文。
 * @param sessions - `[{ id, events, inheritedEventCount?, revision?, live?, projection? }]`。
 *   `projection: 'complete' | 'head-missing' | 'over-inclusive' | undefined` 控制投影状态。
 */
function makeContext(sessions) {
  const reads = { count: 0 }
  /** 调用计数：用来钉住"清单只枚举一遍"这条性能约束。 */
  const calls = { persistenceList: 0, listSessions: 0 }
  const byId = new Map(sessions.map((session) => [session.id, session]))
  /** 冷会话的 durable 投影缓存（模拟重启后磁盘上已有的行）。 */
  const coldRows = new Map()

  const ctx = {
    sessionQuery: {
      async listSessions() {
        calls.listSessions += 1
        return sessions.map((session) => ({
          header: { id: session.id, inheritedEventCount: session.inheritedEventCount ?? 0 },
          live: session.live === true,
          persisted: true,
        }))
      },
      async readSession(id) {
        reads.count += 1
        const session = byId.get(id)
        return {
          inheritedEventCount: session.inheritedEventCount ?? 0,
          events: session.events,
        }
      },
    },
    get(name) {
      if (name === 'sessionPersistence') {
        return {
          async list() {
            calls.persistenceList += 1
            return sessions.map((session) => ({ header: { id: session.id }, revision: session.revision ?? 'r1' }))
          },
        }
      }
      // 只有标了 projection 的会话才"挂载"到本进程（内存里有 cell，读投影零 IO）。
      // 注意：真实的持久化 header 并不带 inheritedEventCount —— 完整性判据靠状态自己
      // 记下的 state.inherited，这里刻意不补，以免测试掩盖该设计。
      const attached = (session) =>
        session.projection === undefined
          ? undefined
          : { id: session.id, header: { id: session.id }, inheritedEventCount: session.inheritedEventCount ?? 0 }

      if (name === 'sessions') {
        return {
          get(id) {
            const session = byId.get(id)
            return session === undefined ? undefined : attached(session)
          },
          list() {
            return sessions.filter((session) => session.deleted !== true).map(attached).filter(Boolean)
          },
        }
      }
      // 活动会话的状态与冷会话的 durable 缓存是同一份东西，这里抽成一个函数两侧复用。
      const projectState = (session) => {
        const inherited = session.inheritedEventCount ?? 0
        const own = session.events.slice(inherited)
        switch (session.projection) {
          case 'complete':
            return foldUsageEvents(own, inherited)
          case 'head-missing':
            // 模拟"注册晚于会话"：只折了后一半
            return foldUsageEvents(own.slice(Math.ceil(own.length / 2)), inherited)
          case 'over-inclusive':
            // 模拟"折进了继承前缀"：连继承段一起折
            return foldUsageEvents(session.events, inherited)
          default:
            return undefined
        }
      }
      const asSnapshot = (state) =>
        state === undefined ? undefined : { asOfSeq: 0, values: { [USAGE_PROJECTION_KEY]: state } }

      if (name === 'sessionProjections') {
        return { snapshot: (session) => asSnapshot(projectState(byId.get(session.id))) }
      }
      if (name === 'sessionProjectionCache') {
        return { cachedSnapshot: (header) => asSnapshot(coldRows.get(header.id)) }
      }
      return undefined
    },
  }
  return { ctx, reads, calls, coldRows }
}

/** 两个会话：一个普通会话、一个带 fork 继承前缀的会话。 */
const scenario = (now) => [
  {
    id: 's1',
    revision: 'r1',
    events: [
      { type: 'step/start', seq: 0 },
      billable({ seq: 1, time: now - 2 * HOUR, input: 1000, output: 100 }),
      { type: 'step/start', seq: 2 },
      billable({ seq: 3, time: now - 40 * DAY, input: 500, output: 50, cacheRead: 200, cacheWrite: 0 }),
    ],
  },
  {
    id: 's2',
    revision: 'r1',
    inheritedEventCount: 2,
    events: [
      // 继承段：已计入父会话，任何路径都不能重复计
      billable({ seq: 0, time: now - 100 * DAY, input: 999_999, output: 999_999 }),
      { type: 'step/start', seq: 1 },
      // 自有段
      billable({ seq: 2, time: now - 1 * HOUR, provider: 'gateway-b', model: 'deepseek/deepseek-flash', input: 2000, output: 200 }),
    ],
  },
]

const fingerprint = (report) => ({
  steps: report.steps,
  sessions: report.sessions,
  total: report.total,
  providers: [...report.byProvider.entries()].map(([k, v]) => [k, v]).sort(),
  models: [...report.byModel.entries()].map(([k, v]) => [k, v]).sort(),
})

test('兜底扫描：正确跳过 fork 继承段，并按当前目录定价', async () => {
  const now = Date.now()
  const { ctx, reads } = makeContext(scenario(now))
  const report = await aggregateUsage(ctx, {})

  assert.equal(report.sessions, 2)
  assert.equal(report.steps, 3, '继承段里那一条不能计入')
  assert.equal(reads.count, 2)
  assert.equal(report.total.input, 1000 + 500 + 2000)
  assert.ok(report.total.cost > 0, '应当按 pi-ai 目录算出金额')
  assert.equal(report.projected, 0)
  assert.equal(report.scanned, 2)
})

test('投影路径与兜底路径结果逐位一致', async () => {
  const now = Date.now()
  const fallback = await aggregateUsage(makeContext(scenario(now)).ctx, {})

  const projected = scenario(now)
  for (const session of projected) session.projection = 'complete'
  const viaProjection = await aggregateUsage(makeContext(projected).ctx, {})

  assert.deepEqual(fingerprint(viaProjection), fingerprint(fallback))
  assert.equal(viaProjection.projected, 2)
  assert.equal(viaProjection.scanned, 0, '投影可用时不应再读日志')
})

test('投影头部缺失（注册晚于会话）→ 退化为兜底扫描，不静默少算', async () => {
  const now = Date.now()
  const fallback = await aggregateUsage(makeContext(scenario(now)).ctx, {})
  const sessions = scenario(now)
  for (const session of sessions) session.projection = 'head-missing'
  const { ctx, reads } = makeContext(sessions)
  const report = await aggregateUsage(ctx, {})

  assert.equal(report.projected, 0)
  assert.equal(report.scanned, 2)
  assert.equal(reads.count, 2)
  assert.deepEqual(fingerprint(report), fingerprint(fallback))
})

test('投影折进了继承前缀（会重复计费）→ 同样退化，绝不双计', async () => {
  const now = Date.now()
  const fallback = await aggregateUsage(makeContext(scenario(now)).ctx, {})
  const sessions = scenario(now)
  for (const session of sessions) session.projection = 'over-inclusive'
  const report = await aggregateUsage(makeContext(sessions).ctx, {})

  // s1 没有 fork 继承前缀，所以"折进前缀"对它不成立 —— 它照常走投影；
  // s2 真的带了继承段，必须退化到兜底扫描。
  assert.equal(report.projected, 1)
  assert.equal(report.scanned, 1)
  assert.deepEqual(fingerprint(report), fingerprint(fallback))
  assert.ok(report.total.input < 999_999, '继承段那 999,999 绝不能被计入')
})

test('自然日窗口：days=1 只含今天，days=7 含最近 7 个自然日', async () => {
  const now = Date.now()
  const { ctx } = makeContext(scenario(now))

  const today = await aggregateUsage(ctx, { days: 1 })
  const week = await aggregateUsage(ctx, { days: 7 })
  const all = await aggregateUsage(ctx, {})

  // s1 有一条 40 天前的、s2 有一条 1 小时前的（可能是昨天）
  assert.ok(today.steps <= week.steps, '窗口越大步数不可能更少')
  assert.ok(week.steps <= all.steps)
  assert.equal(all.steps, 3)
  assert.ok(week.total.input < all.total.input, '40 天前那条不应进入 7 天窗口')
  assert.equal(all.total.input, 1000 + 500 + 2000)
  assert.equal(week.windowMode, 'calendar-day')
})

test('兜底结果按 revision 缓存：第二次调用不重读', async () => {
  const now = Date.now()
  const { ctx, reads } = makeContext(scenario(now))
  const cache = createUsageCache()

  const first = await aggregateUsage(ctx, { cache })
  assert.equal(reads.count, 2)
  const second = await aggregateUsage(ctx, { cache })

  assert.equal(reads.count, 2, '第二次不应再读日志')
  assert.equal(second.reused, 2)
  assert.equal(second.scanned, 0)
  assert.deepEqual(fingerprint(second), fingerprint(first))
})

test('会话清单只枚举一遍（固定开销不随调用次数翻倍）', async () => {
  const now = Date.now()
  const { ctx, calls } = makeContext(scenario(now))
  await aggregateUsage(ctx, {})

  // 刻意付两次列举：listSessions() 的 live 标记是权威的，持久化列表提供 revision。
  // 曾为省这一次列举自己拼注册表，导致活动会话被当冷会话整份重读（几秒的回归）。
  // 高层 listSessions 会再遍历一次目录并读每个 header，属于重复开销。
  assert.equal(calls.persistenceList, 1)
  assert.equal(calls.listSessions, 1, '必须走高层 listSessions 拿权威的 live 标记')
})

test('没有持久化服务时退回高层 listSessions（失去缓存但功能可用）', async () => {
  const now = Date.now()
  const { ctx, calls } = makeContext(scenario(now))
  ctx.get = (name) => (name === 'sessionPersistence' ? undefined : undefined)
  const report = await aggregateUsage(ctx, {})

  assert.equal(calls.listSessions, 1)
  assert.equal(report.sessions, 2, '仍然统计到全部会话')
  assert.equal(report.scanned, 2, '没有 revision → 无法缓存，只能每次扫描')
})

test('冷会话走 durable 投影缓存：重启后零日志读取', async () => {
  const now = Date.now()
  const baseline = await aggregateUsage(makeContext(scenario(now)).ctx, {})

  // 冷会话 = 没有挂载到本进程（sessions.get 返回 undefined）
  const sessions = scenario(now)
  const { ctx, reads, coldRows } = makeContext(sessions)

  // 情况一：durable 缓存里还没有这一行 → 只能兜底扫描（首次安装/首次运行）
  const before = await aggregateUsage(ctx, {})
  assert.equal(before.projected, 0)
  assert.equal(before.scanned, 2, '没有缓存行时必须读日志')
  assert.equal(reads.count, 2)

  // 情况二：上一次运行已经 checkpoint 过 → 重启后应当**一次日志都不读**
  for (const session of sessions) {
    const inherited = session.inheritedEventCount ?? 0
    coldRows.set(session.id, foldUsageEvents(session.events.slice(inherited), inherited))
  }
  reads.count = 0
  const after = await aggregateUsage(ctx, {})

  assert.equal(reads.count, 0, '重启后不应再读任何日志')
  assert.equal(after.projected, 2)
  assert.equal(after.scanned, 0)
  assert.deepEqual(fingerprint(after), fingerprint(baseline), '结果必须与逐条扫描一致')
})

test('parseWindow：三种形式与非法输入', () => {
  assert.deepEqual(parseWindow({}), { fromDay: undefined, toDay: undefined })
  assert.equal(parseWindow({ days: 7 }).days, 7)
  assert.equal(parseWindow({ days: 7 }).fromDay, dayKeyOf(Date.now() - 6 * DAY))
  assert.equal(parseWindow({ days: 1 }).fromDay, dayKeyOf(Date.now()), 'days=1 就是"今天"')
  assert.deepEqual(
    parseWindow({ from: '2026-10-01', to: '2026-10-15' }),
    { from: '2026-10-01', to: '2026-10-15', fromDay: '2026-10-01', toDay: '2026-10-15' },
  )
  assert.equal(parseWindow({ from: '2026-10-01' }).toDay, undefined, '只给起点＝到今天')
  for (const bad of [{ days: 0 }, { days: -1 }, { days: 1.5 }, { days: 'x' }]) {
    assert.equal(parseWindow(bad), null, JSON.stringify(bad))
  }
  assert.equal(parseWindow({ from: '2026/10/01' }), null)
  assert.equal(parseWindow({ to: 'nope' }), null)
  assert.equal(parseWindow({ from: '2026-10-05', to: '2026-10-01' }), null)
})

test('自定义区间：按自然日过滤，含首尾两天', async () => {
  const now = Date.now()
  const { ctx } = makeContext(scenario(now))
  const old = dayKeyOf(now - 40 * DAY)
  const today = dayKeyOf(now)

  const all = await aggregateUsage(ctx, {})
  const onlyOld = await aggregateUsage(ctx, { from: old, to: old })
  const onlyToday = await aggregateUsage(ctx, { from: today, to: today })

  assert.equal(onlyOld.steps, 1, '40 天前那一条')
  assert.equal(onlyOld.total.input, 500)
  assert.equal(onlyOld.from, old)
  assert.equal(onlyOld.to, old)
  assert.ok(onlyToday.steps >= 1)
  assert.ok(onlyOld.steps + onlyToday.steps <= all.steps, '自定义区间不能超出全部历史')
  assert.equal(all.steps, 3)
})

test('同一窗口两种写法结果一致（days=1 ⇔ from=to=今天）', async () => {
  const now = Date.now()
  const { ctx } = makeContext(scenario(now))
  const viaDays = await aggregateUsage(ctx, { days: 1 })
  const viaDates = await aggregateUsage(ctx, { from: dayKeyOf(now), to: dayKeyOf(now) })
  assert.equal(viaDays.steps, viaDates.steps)
  assert.equal(viaDays.total.input, viaDates.total.input)
})

test('窗口非法时抛出可读错误', async () => {
  const { ctx } = makeContext(scenario(Date.now()))
  await assert.rejects(() => aggregateUsage(ctx, { days: 0 }), /窗口非法/)
  await assert.rejects(() => aggregateUsage(ctx, { from: '2026-10-05', to: '2026-10-01' }), /窗口非法/)
})

test('按天序列：升序，且逐日求和必须等于总计（热力图与卡片必须对得上）', async () => {
  const now = Date.now()
  const { ctx } = makeContext(scenario(now))
  const report = await aggregateUsage(ctx, {})

  assert.ok(Array.isArray(report.series), '报告必须带按天序列')
  assert.ok(report.series.length >= 1)
  const days = report.series.map((entry) => entry.day)
  assert.deepEqual(days, [...days].sort(), '必须按自然日升序')
  for (const day of days) assert.match(day, /^\d{4}-\d{2}-\d{2}$/)

  const sum = report.series.reduce(
    (accumulator, entry) => ({
      calls: accumulator.calls + entry.calls,
      input: accumulator.input + entry.input,
      output: accumulator.output + entry.output,
      cacheRead: accumulator.cacheRead + entry.cacheRead,
      cacheWrite: accumulator.cacheWrite + entry.cacheWrite,
      cost: accumulator.cost + entry.cost,
    }),
    { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  )
  assert.equal(sum.calls, report.total.calls)
  assert.equal(sum.input, report.total.input)
  assert.equal(sum.output, report.total.output)
  assert.equal(sum.cacheRead, report.total.cacheRead)
  assert.equal(sum.cacheWrite, report.total.cacheWrite)
  assert.ok(Math.abs(sum.cost - report.total.cost) < 1e-9, '逐日金额之和必须等于总金额')
})

test('按天序列是长期视图：不随区间收窄，但按窗口切一刀必须等于该窗口总计', async () => {
  const now = Date.now()
  const { ctx } = makeContext(scenario(now))
  const all = await aggregateUsage(ctx, {})
  const week = await aggregateUsage(ctx, { days: 7 })
  const cutoff = dayKeyOf(now - 6 * DAY)

  // 热力图存在的意义是"看长期形状"：换区间不能让它缩水成一列。
  assert.deepEqual(
    week.series.map((entry) => entry.day),
    all.series.map((entry) => entry.day),
    '序列不随区间收窄（否则选"近 7 天"时热力图只剩一列）',
  )
  assert.ok(all.series.length <= 371, '上限 53 周，避免状态无限增长')

  // 但把序列按窗口切一刀，必须精确等于该窗口的卡片/表格数字。
  const windowed = week.series.filter((entry) => entry.day >= cutoff)
  assert.equal(windowed.reduce((total, entry) => total + entry.calls, 0), week.total.calls)
  assert.equal(windowed.reduce((total, entry) => total + entry.input, 0), week.total.input)
  assert.ok(
    Math.abs(windowed.reduce((total, entry) => total + entry.cost, 0) - week.total.cost) < 1e-9,
    '窗口内逐日金额之和必须等于卡片上的总金额',
  )
})

test('未定价的模型会被显式标记，而不是静默按 0 计', async () => {
  const now = Date.now()
  const sessions = [{
    id: 's1',
    events: [billable({ seq: 0, time: now, provider: 'mystery', model: 'no-such-model' })],
  }]
  const report = await aggregateUsage(makeContext(sessions).ctx, {})
  assert.deepEqual([...report.unpriced], ['mystery/no-such-model'])
})

test('单个会话读失败只计数，不影响整体', async () => {
  const now = Date.now()
  const sessions = scenario(now)
  const { ctx } = makeContext(sessions)
  ctx.sessionQuery.readSession = async (id) => {
    if (id === 's2') throw new Error('boom')
    return { inheritedEventCount: 0, events: sessions[0].events }
  }
  const report = await aggregateUsage(ctx, {})
  assert.equal(report.unreadable, 1)
  assert.equal(report.sessions, 1)
})
