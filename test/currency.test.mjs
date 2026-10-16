/**
 * 币种换算的单元测试。
 *
 * 这里守的是一条开源纪律：**代码不内置任何汇率**。
 * 想要人民币就必须显式给 cnyPerUsd，否则如实回退为美元并置 fellBack。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMoney } from '../lib/currency.js'

test('默认是美元，且不做任何换算', () => {
  const money = createMoney()
  assert.equal(money.currency, 'USD')
  assert.equal(money.symbol, '$')
  assert.equal(money.converts, false)
  assert.equal(money.fellBack, false)
  assert.equal(money.format(1.5), '$1.5000')
})

test('给了汇率才换算成人民币', () => {
  const money = createMoney({ currency: 'CNY', cnyPerUsd: 7.2 })
  assert.equal(money.currency, 'CNY')
  assert.equal(money.symbol, '¥')
  assert.equal(money.converts, true)
  assert.equal(money.fromUsd(1), 7.2)
  assert.equal(money.format(1), '¥7.2000')
})

test('请求 CNY 但没给汇率 → 如实回退为美元，不猜数字', () => {
  for (const bad of [undefined, 0, -1, Number.NaN, '7.2']) {
    const money = createMoney({ currency: 'CNY', cnyPerUsd: bad })
    assert.equal(money.currency, 'USD', `cnyPerUsd=${String(bad)}`)
    assert.equal(money.fellBack, true)
    assert.equal(money.converts, false)
    assert.equal(money.format(1), '$1.0000')
  }
})

test('未知币种按美元处理', () => {
  const money = createMoney({ currency: 'EUR' })
  assert.equal(money.currency, 'USD')
  assert.equal(money.fellBack, false)
})
