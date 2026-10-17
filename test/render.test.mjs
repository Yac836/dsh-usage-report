import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMoney } from '../lib/currency.js'
import { renderUsage } from '../lib/render.js'

const report = (overrides = {}) => {
  const bucket = { calls: 1, input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.1 }
  return {
    steps: 1, sessions: 1, unreadable: 0, unpriced: new Set(),
    first: 1_700_000_000_000, last: 1_700_000_000_000,
    byProvider: new Map([['gateway-a', bucket]]), byModel: new Map(), total: bucket,
    ...overrides,
  }
}

test('命令把费用标为当前目录估算，明确账单与历史价格边界', () => {
  const text = renderUsage(report(), createMoney())
  assert.match(text, /估算费用/)
  assert.match(text, /当前 pi-ai 目录/)
  assert.match(text, /不等于实际账单/)
  assert.match(text, /历史用量的估算金额也可能变化/)
})

test('未定价模型明确为费用未计入，而非免费', () => {
  const text = renderUsage(report({ unpriced: new Set(['gateway-a/other-model']) }), createMoney())
  assert.match(text, /费用未计入合计，并非免费/)
  assert.match(text, /gateway-a\/other-model/)
})

test('全部读取失败时，空统计仍给出不完整警告', () => {
  const text = renderUsage(report({ steps: 0, unreadable: 2 }), createMoney())
  assert.match(text, /2 个会话读取失败，统计可能不完整/)
})
