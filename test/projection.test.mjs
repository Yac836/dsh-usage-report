/**
 * 投影单元的单元测试。
 *
 * 重点覆盖那些「错了也不会立刻报错」的地方：同引用契约、完整性判据的三种关系、
 * 继承前缀导致的重复计费、以及 stateVersion 的纪律。
 *
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  USAGE_PROJECTION_KEY,
  USAGE_PROJECTION_VERSION,
  applyUsageEvent,
  dayKeyOf,
  foldUsageEvents,
  initUsageState,
  isUsageStateComplete,
  usageProjectionDefinition,
  usageStateSchema,
} from '../lib/projection.js'

const billable = ({ seq, time = 1_700_000_000_000, provider = 'gateway-a', model = 'deepseek-flash', input = 100, output = 10, cacheRead = 0, cacheWrite = 0 } = {}) => ({
  type: 'assistant/message',
  seq,
  time,
  data: {
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    message: { source: { provider, model } },
  },
})

test('无关事件返回同一引用（宿主用 Object.is 做变更闸门）', () => {
  // 先"预热" headSeq：每个会话的第一个事件必然产生新状态（要记录折叠起点），
  // 此后所有无关事件都必须回到同引用。
  const primed = applyUsageEvent(initUsageState(), { type: 'step/start', seq: 99 })
  for (const event of [
    { type: 'step/start', seq: 0 },
    { type: 'assistant/attempt', seq: 1, data: {} },
    { type: 'tool/call', seq: 2, data: { callId: 'a' } },
    // assistant/message 但没带 usage：不可计费，同样必须同引用
    { type: 'assistant/message', seq: 3, data: {} },
  ]) {
    assert.equal(applyUsageEvent(primed, event), primed)
  }
})

test('首次见到事件时记录 headSeq —— 每会话只发生一次', () => {
  const start = initUsageState()
  const once = applyUsageEvent(start, { type: 'step/start', seq: 7 })
  assert.notEqual(once, start, '首次记录 headSeq 必须产生新状态')
  assert.equal(once.headSeq, 7)
  // 第二次起回到同引用
  assert.equal(applyUsageEvent(once, { type: 'step/start', seq: 8 }), once)
  assert.equal(once.headSeq, 7, 'headSeq 一旦记录就不再变化')
})

test('按 provider/model 与本地自然日分桶累加', () => {
  const day1 = new Date(2026, 0, 10, 9, 0, 0).getTime()
  const day2 = new Date(2026, 0, 11, 9, 0, 0).getTime()
  let state = initUsageState()
  state = applyUsageEvent(state, billable({ seq: 0, time: day1, input: 100, output: 10 }))
  state = applyUsageEvent(state, billable({ seq: 1, time: day1, input: 200, output: 20 }))
  state = applyUsageEvent(state, billable({ seq: 2, time: day2, input: 300, output: 30, model: 'other' }))

  assert.equal(state.steps, 3)
  assert.equal(dayKeyOf(day1), '2026-01-10')
  assert.equal(dayKeyOf(day2), '2026-01-11')

  const routes = Object.values(state.routes)
  assert.equal(routes.length, 2, '两个模型应分成两条路由')
  const flash = routes.find((route) => route.model === 'deepseek-flash')
  const other = routes.find((route) => route.model === 'other')
  assert.deepEqual(flash.days['2026-01-10'], { calls: 2, input: 300, output: 30, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(other.days['2026-01-11'], { calls: 1, input: 300, output: 30, cacheRead: 0, cacheWrite: 0 })
  assert.equal(flash.provider, 'gateway-a')
})

test('provider 里含斜杠也不会被拆歧义（键与值分离）', () => {
  const state = applyUsageEvent(initUsageState(), billable({ seq: 0, provider: 'a/b', model: 'c/d' }))
  const [route] = Object.values(state.routes)
  assert.equal(route.provider, 'a/b')
  assert.equal(route.model, 'c/d')
})

test('状态可通过 stateSchema 校验（会被写进磁盘缓存）', () => {
  const state = applyUsageEvent(initUsageState(), billable({ seq: 0 }))
  const parsed = usageStateSchema.safeParse(state)
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state, '状态必须是可 JSON 往返的纯数据')
})

test('stateVersion 是正整数，key 与定义一致', () => {
  assert.equal(usageProjectionDefinition.key, USAGE_PROJECTION_KEY)
  assert.equal(usageProjectionDefinition.stateVersion, USAGE_PROJECTION_VERSION)
  assert.ok(Number.isSafeInteger(USAGE_PROJECTION_VERSION) && USAGE_PROJECTION_VERSION > 0)
})

test('init 记下 fork 继承前缀长度', () => {
  assert.equal(usageProjectionDefinition.init({}, 4).inherited, 4)
  assert.equal(usageProjectionDefinition.init({}, undefined).inherited, null)
})

test('完整性判据：headSeq 与 inherited 的三种关系', () => {
  const forked = (inherited, firstOwnSeq) => {
    const state = foldUsageEvents([billable({ seq: firstOwnSeq })], inherited)
    return state
  }
  // 恰好从第一个自有事件开始 —— 唯一可信任的情形
  assert.equal(isUsageStateComplete(forked(4, 4), 4), true)
  // 头部缺失（注册晚于会话）—— 不可信任
  assert.equal(isUsageStateComplete(forked(4, 9), 4), false)
  // 折进了继承前缀（会与父会话重复计费）—— 不可信任
  assert.equal(isUsageStateComplete(forked(4, 0), 4), false)
  // 非 fork 会话
  assert.equal(isUsageStateComplete(forked(0, 0), 0), true)
  // 没有任何自有事件：空状态无法与"单元从未跑过"区分，一律不信任
  assert.equal(isUsageStateComplete(initUsageState(), 3), false)
  // 但"见过事件、只是都不计费"是可信的
  const onlyIrrelevant = applyUsageEvent({ ...initUsageState(), inherited: 3 }, { type: 'step/start', seq: 3 })
  assert.equal(isUsageStateComplete(onlyIrrelevant, 3), true)
  // 读不到状态
  assert.equal(isUsageStateComplete(undefined, 0), false)
})

test('本地折叠与逐事件折叠等价（两条路径必须同语义）', () => {
  const events = [billable({ seq: 0, input: 1 }), { type: 'step/start', seq: 1 }, billable({ seq: 2, input: 2 })]
  let stepwise = { ...initUsageState(), inherited: 0 }
  for (const event of events) stepwise = applyUsageEvent(stepwise, event)
  assert.deepEqual(foldUsageEvents(events, 0), stepwise)
})
