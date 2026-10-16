/**
 * 接线测试：验证 `apply()` 真的把该注册的东西注册了。
 *
 * 这三处接线（投影单元、斜杠命令、HTTP 路由）任何一处错了，
 * 现象都是"插件静默不工作"——没有报错、没有日志，只有功能缺失。
 * 因此用假 ctx 把它们钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, REPORT_ROUTE, apply, inject, name } from '../lib/index.js'
import { USAGE_PROJECTION_KEY, USAGE_PROJECTION_VERSION } from '../lib/projection.js'

/** 假 ctx：记录所有注册动作。 */
function makeContext({ withProjections = true, withConnection = true } = {}) {
  const captured = { effects: [], injects: [] }
  const run = (fn) => {
    if (typeof fn !== 'function') return
    const result = fn()
    // apply() 里用的是 generator effect：把 yield 出来的东西跑完
    if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
      let step = result.next()
      while (step.done !== true) step = result.next(step.value)
    }
  }
  const available = (dep) =>
    dep === 'connection' ? withConnection : dep === 'sessionProjections' ? withProjections : true

  const ctx = {
    effect: (fn, label) => { captured.effects.push(label); run(fn) },
    inject: (deps, callback) => {
      captured.injects.push([...deps])
      // 真实 Cordis 的 inject 在依赖缺失时**不会**调用回调（而是等它出现），
      // 这里必须复刻这一点，否则测不出"缺服务时优雅退化"。
      if (!deps.every(available)) return
      const child = {
        effect: (fn, label) => { captured.effects.push(label); run(fn) },
        connection: withConnection
          ? { fetch: { register: (route) => { captured.route = route; return () => {} } } }
          : undefined,
        sessionProjections: withProjections
          ? { register: (definition) => { captured.projection = definition; return () => {} } }
          : undefined,
      }
      callback(child)
    },
    commands: { register: (definition) => { captured.command = definition; return () => {} } },
    get: () => undefined,
  }
  return { ctx, captured }
}

test('插件身份与硬依赖', () => {
  assert.equal(name, 'usage-report')
  assert.deepEqual(inject, ['commands', 'sessionQuery'], '投影/持久化等一律软依赖，缺失时仍能加载')
  assert.equal(REPORT_ROUTE, '/api/usage.report')
})

test('Config 默认美元且不含任何内置汇率', () => {
  const parsed = Config({})
  assert.equal(parsed.currency, 'USD')
  assert.equal(parsed.cnyPerUsd, undefined, '不提供默认汇率')
})

test('apply() 注册投影单元、/usage 命令与 JSON 路由', () => {
  const { ctx, captured } = makeContext()
  apply(ctx, { currency: 'USD' })

  // 投影单元
  assert.ok(captured.projection, '必须注册投影单元')
  assert.equal(captured.projection.key, USAGE_PROJECTION_KEY)
  assert.equal(captured.projection.stateVersion, USAGE_PROJECTION_VERSION)
  assert.equal(typeof captured.projection.init, 'function')
  assert.equal(typeof captured.projection.apply, 'function')
  assert.ok(captured.projection.stateSchema, '必须带 stateSchema（磁盘缓存行要校验）')
  // wire 不是可选项：只有带 wire 的单元才能用 cachedSnapshot 从 durable 缓存读回，
  // 那是"重启后不重扫日志"唯一可用的路径。
  assert.ok(captured.projection.wire, '必须声明 wire')
  assert.equal(typeof captured.projection.wire.view, 'function')
  assert.ok(captured.projection.wire.viewSchema, 'wire 必须带 viewSchema')

  // 命令
  assert.equal(captured.command.name, 'usage')
  assert.equal(typeof captured.command.handler, 'function')
  assert.match(captured.effects.join('|'), /usage-report: \/usage/)

  // 路由
  assert.equal(captured.route.path, REPORT_ROUTE)
  assert.deepEqual(captured.route.methods, ['GET'])
  assert.equal(captured.route.requestBody, 'buffered')
  assert.equal(typeof captured.route.fetch, 'function')
})

test('缺少 sessionProjections 服务时仍能加载（退化而非崩溃）', () => {
  const { ctx, captured } = makeContext({ withProjections: false })
  apply(ctx, {})
  assert.equal(captured.projection, undefined)
  assert.equal(captured.command.name, 'usage', '命令照常注册')
})

test('缺少 connection 时仍能加载（无 Web 的 profile）', () => {
  const { ctx, captured } = makeContext({ withConnection: false })
  apply(ctx, {})
  assert.equal(captured.route, undefined)
  assert.equal(captured.command.name, 'usage')
})

test('HTTP 路由：参数校验 + 无快照时先回 refreshing，刷新完成后给完整 JSON', async () => {
  const { ctx, captured } = makeContext()
  ctx.sessionQuery = {
    async listSessions() { return [] },
    async readSession() { throw new Error('不应被调用') },
  }
  apply(ctx, { currency: 'USD', warmup: false })

  const bad = await captured.route.fetch(new Request('http://localhost/api/usage.report?days=abc'))
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /days/)

  const badRange = await captured.route.fetch(
    new Request('http://localhost/api/usage.report?from=2026-10-05&to=2026-10-01'),
  )
  assert.equal(badRange.status, 400, 'from 晚于 to 应当报错')

  // 第一次请求时还没有快照：立刻返回 refreshing，不阻塞面板
  const pending = await captured.route.fetch(new Request('http://localhost/api/usage.report?days=7'))
  assert.equal(pending.status, 200)
  const pendingBody = await pending.json()
  assert.equal(pendingBody.refreshing, true)
  assert.equal(pendingBody.total, undefined, '算好之前不应给出半个报告')

  // 后台刷新完成后（桩上下文立刻完成），第二次请求就拿到完整报告
  await new Promise((resolve) => setTimeout(resolve, 20))
  const ready = await captured.route.fetch(new Request('http://localhost/api/usage.report?days=7'))
  const payload = await ready.json()
  assert.equal(payload.range.days, 7)
  assert.equal(payload.range.windowMode, 'calendar-day')
  assert.equal(payload.money.currency, 'USD')
  assert.equal(payload.steps, 0)
  assert.equal(payload.refreshing, false)
  assert.ok(typeof payload.asOf === 'number', '应带上数据截至时间')
  assert.ok(payload.scan, '应带上观测字段')
})

test('自定义区间：from/to 直达响应，且非法组合被拒', async () => {
  const { ctx, captured } = makeContext()
  ctx.sessionQuery = { async listSessions() { return [] }, async readSession() { throw new Error('no') } }
  apply(ctx, { warmup: false })

  await captured.route.fetch(new Request('http://localhost/api/usage.report?from=2026-10-01&to=2026-10-15'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  const ready = await captured.route.fetch(
    new Request('http://localhost/api/usage.report?from=2026-10-01&to=2026-10-15'),
  )
  const payload = await ready.json()
  assert.equal(payload.range.from, '2026-10-01')
  assert.equal(payload.range.to, '2026-10-15')
  assert.equal(payload.range.days, null)
})

test('启动预热：配置的延迟之后，默认区间已经有快照可用（面板不必等待）', async () => {
  const { ctx, captured } = makeContext()
  ctx.sessionQuery = { async listSessions() { return [] }, async readSession() { throw new Error('no') } }
  apply(ctx, { warmup: true, warmupDelayMs: 0 })

  // 预热是异步的：给它一个 tick，然后第一次请求就应当直接拿到报告而不是 refreshing
  await new Promise((resolve) => setTimeout(resolve, 30))
  const response = await captured.route.fetch(new Request('http://localhost/api/usage.report'))
  const payload = await response.json()
  assert.equal(payload.refreshing, false, '预热之后第一次打开就该有数据')
  assert.equal(payload.steps, 0)
})

test('force=1：绝不等待 —— 立刻返回旧快照（或 refreshing）并在后台刷新', async () => {
  const { ctx, captured } = makeContext()
  let listed = 0
  ctx.sessionQuery = {
    async listSessions() { listed += 1; return [] },
    async readSession() { throw new Error('no') },
  }
  apply(ctx, { warmup: false })

  const cold = await captured.route.fetch(new Request('http://localhost/api/usage.report?force=1'))
  assert.equal(cold.status, 200)
  assert.equal((await cold.json()).refreshing, true, '没有快照时也不等待')

  await new Promise((resolve) => setTimeout(resolve, 20))
  const warm = await captured.route.fetch(new Request('http://localhost/api/usage.report?force=1'))
  const body = await warm.json()
  assert.equal(body.refreshing, true, '强制刷新：旧快照立刻返回并标记 refreshing')
  assert.equal(typeof body.asOf, 'number')
  assert.equal(body.steps, 0)
  assert.ok(listed >= 2, '强制刷新确实启动了一次新的聚合')
})
