import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const readyReport = (cost = 1, extra = {}) => ({
  total: { calls: 1, input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost, costUsd: cost },
  steps: 1, sessions: 1, unreadable: 0, providers: [], models: [], series: [], unpriced: [],
  range: { first: 1_700_000_000_000, last: 1_700_000_000_000 }, money: { symbol: '$' },
  asOf: 1_700_000_000_000, refreshing: false, refreshAfterMs: 30_000, ...extra,
})

// Exercise the actual component/effect with controlled requests, visibility and
// timers. All objects stay in the same JS realm; no browser or host is started.
function mountPanel(responses) {
  const hooks = []
  const timers = new Map()
  const listeners = new Set()
  const requests = []
  let registration, component, dictionaries, tree, cursor, pendingEffects
  let dirty = true
  let disposed = false
  let lateUpdates = 0
  let nextTimer = 0
  const document = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => { assert.equal(name, 'visibilitychange'); listeners.add(fn) },
    removeEventListener: (_name, fn) => listeners.delete(fn),
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (update) => {
        if (disposed) { lateUpdates += 1; return }
        const next = typeof update === 'function' ? update(hooks[index]) : update
        if (!Object.is(next, hooks[index])) { hooks[index] = next; dirty = true }
      }]
    },
    useRef(initial) {
      const index = cursor++
      return hooks[index] ?? (hooks[index] = { current: initial })
    },
    useEffect(fn, dependencies) {
      const index = cursor++
      if (!hooks[index] || dependencies.some((value, at) => !Object.is(value, hooks[index].dependencies[at]))) {
        pendingEffects.push({ index, fn, dependencies })
      }
    },
  }
  const fetch = async (url, options) => {
    requests.push({ url, signal: options.signal })
    assert.ok(responses.length > 0, 'Unexpected request')
    const response = responses.shift()
    return typeof response === 'function' ? response() : response
  }
  new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', source)(
    { __ModuleLoader__: { load: (value) => { registration = value } } }, document, fetch,
    (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    (id) => timers.delete(id),
  )
  const exports = registration.factory((name) => { assert.equal(name, 'react'); return React })
  const t = (key, params = {}) => dictionaries.zh[key].replace(/\{(\w+)\}/g, (_match, name) => params[name])
  exports.apply({
    effect: (fn) => fn(),
    locale: { register: (_namespace, value) => { dictionaries = value }, bind: () => t },
    slots: { inject: (_name, fn) => fn(), register: (_options, value) => { component = value } },
  })
  const render = () => {
    if (disposed) return
    let passes = 0
    while (dirty) {
      assert.ok(++passes < 10, 'Unexpected render loop')
      dirty = false
      cursor = 0
      pendingEffects = []
      tree = component({ t })
      for (const { index, fn, dependencies } of pendingEffects) {
        hooks[index]?.cleanup?.()
        hooks[index] = { dependencies, cleanup: fn() }
      }
    }
  }
  const flush = async () => {
    for (let i = 0; i < 12; i += 1) { await Promise.resolve(); render() }
  }
  const nodes = () => {
    const all = []
    const visit = (value) => {
      if (!value || typeof value !== 'object') return
      all.push(value)
      for (const child of value.children ?? []) visit(child)
    }
    visit(tree)
    return all
  }
  render()
  return {
    requests, timers, listeners, flush,
    get lateUpdates() { return lateUpdates },
    get report() { return nodes().find((node) => node.props.report)?.props.report },
    get text() { return nodes().flatMap((node) => node.children.filter((child) => typeof child === 'string')).join(' ') },
    get alerts() { return nodes().filter((node) => node.props.role === 'alert') },
    async click(label) {
      const node = nodes().find((item) => item.props.onClick && item.children.includes(label))
      assert.ok(node, `Missing control: ${label}`)
      node.props.onClick()
      render()
      await flush()
    },
    async fireTimer() {
      assert.equal(timers.size, 1)
      const [id, timer] = timers.entries().next().value
      timers.delete(id)
      timer.callback()
      await flush()
    },
    async setVisibility(value) {
      document.visibilityState = value
      for (const listener of listeners) listener()
      await flush()
    },
    unmount() {
      disposed = true
      for (const value of hooks) value?.cleanup?.()
    },
  }
}

test('面板等待任务时轮询状态，成功后低频检查，隐藏暂停，卸载清理', async (t) => {
  const panel = mountPanel([
    Response.json({ refreshing: true }),
    Response.json(readyReport(1, { refreshAfterMs: 0 })),
    Response.json(readyReport(2)),
  ])
  t.after(() => panel.unmount())
  await panel.flush()
  assert.equal([...panel.timers.values()][0].delay, 1500)
  await panel.fireTimer()
  assert.equal(panel.requests[1].url, 'api/usage.report?poll=1')
  assert.equal([...panel.timers.values()][0].delay, 30_000)
  await panel.setVisibility('hidden')
  assert.equal(panel.timers.size, 0)
  assert.equal(panel.requests.length, 2)
  await panel.setVisibility('visible')
  assert.equal(panel.requests[2].url, 'api/usage.report')
  assert.equal(panel.report.total.cost, 2)
  panel.unmount()
  assert.equal(panel.timers.size, 0)
  assert.equal(panel.listeners.size, 0)
  assert.ok(panel.requests.every((request) => request.signal.aborted))
})

test('刷新失败保留同区间旧数据并停止重试，手动刷新携带 force=1', async (t) => {
  const panel = mountPanel([
    Response.json(readyReport(1, { refreshing: true })),
    Response.json({ error: 'synthetic host detail' }, { status: 503 }),
    Response.json(readyReport(2)),
  ])
  t.after(() => panel.unmount())
  await panel.flush()
  assert.equal([...panel.timers.values()][0].delay, 1500)
  await panel.fireTimer()
  assert.equal(panel.requests[1].url, 'api/usage.report?poll=1')
  assert.equal(panel.report.total.cost, 1)
  assert.equal(panel.report.refreshing, false)
  assert.match(panel.text, /上次成功的数据/)
  assert.doesNotMatch(panel.text, /synthetic/)
  assert.equal(panel.alerts.length, 1)
  assert.equal(panel.timers.size, 0)
  await panel.click('刷新')
  assert.equal(panel.requests[2].url, 'api/usage.report?force=1')
  assert.equal(panel.report.total.cost, 2)
  assert.equal(panel.alerts.length, 0)
})

test('冷启动失败给出可用的重试按钮，不无限轮询', async (t) => {
  const panel = mountPanel([
    Response.json({ error: 'synthetic detail' }, { status: 503 }),
    Response.json(readyReport()),
  ])
  t.after(() => panel.unmount())
  await panel.flush()
  assert.match(panel.text, /刷新失败/)
  assert.equal(panel.timers.size, 0)
  await panel.click('重试')
  assert.equal(panel.requests[1].url, 'api/usage.report?force=1')
  assert.ok(panel.report)
})

test('切换区间后请求失败，不把前一区间的报告当成当前数据', async (t) => {
  const panel = mountPanel([
    Response.json(readyReport()),
    Response.json({}, { status: 503 }),
  ])
  t.after(() => panel.unmount())
  await panel.flush()
  await panel.click('近 7 天')
  assert.equal(panel.requests[1].url, 'api/usage.report?days=7')
  assert.equal(panel.report, undefined)
  assert.match(panel.text, /刷新失败/)
})

test('服务端报告后台失败时保留空报告的警告和手动刷新入口', async (t) => {
  const panel = mountPanel([Response.json(readyReport(0, {
    steps: 0, unreadable: 1, refreshError: 'refresh failed',
  }))])
  t.after(() => panel.unmount())
  await panel.flush()
  assert.equal(panel.alerts.length, 2)
  assert.match(panel.text, /上次成功的数据/)
  assert.match(panel.text, /1 个会话读取失败/)
  assert.match(panel.text, /刷新/)
  assert.equal(panel.timers.size, 0)
})

test('卸载后的迟到响应不再更新组件或创建计时器', async () => {
  let finish
  const response = new Promise((resolve) => { finish = resolve })
  const panel = mountPanel([() => response])
  panel.unmount()
  finish(Response.json(readyReport()))
  await panel.flush()
  assert.equal(panel.lateUpdates, 0)
  assert.equal(panel.timers.size, 0)
})

test('无效响应给出失败提示，不持续进行无效轮询', async (t) => {
  const panel = mountPanel([Response.json({ unexpected: true })])
  t.after(() => panel.unmount())
  await panel.flush()
  assert.match(panel.text, /刷新失败/)
  assert.equal(panel.timers.size, 0)
})
