/**
 * 客户端半的测试 —— 不需要浏览器，也不需要 DSH。
 *
 * 手法：装一个假的 `window.__ModuleLoader__` 捕获注册，再用假 React / 假 ctx
 * 真正执行一遍 `apply()`，从而验证那些"错了要到浏览器里才会发现"的东西：
 * bundle 包装格式、注册 id、slot 注册形状、以及中英字典键集是否一致
 * （字典键不一致会在注册时直接抛错）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** 执行 bundle 并返回被捕获的注册 + 导出。 */
function loadBundle() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let registration
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  try {
    new Function(source)()
  } finally {
    globalThis.window = previous
  }
  assert.ok(registration !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load')

  const reactStub = {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const exports = registration.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`未预期的 require("${name}") —— 该模块不在平台的静态白名单里`)
  })
  return { registration, exports }
}

test('bundle 包装：注册 id 与包名一致，factory 可用', () => {
  const { registration, exports } = loadBundle()
  assert.equal(registration.id, 'dsh-usage-report')
  assert.equal(typeof registration.factory, 'function')
  assert.deepEqual(Object.keys(exports).sort(), ['apply', 'inject'])
  assert.deepEqual(exports.inject, ['slots', 'locale'])
})

test('apply() 注册字典与设置页 slot，且不抛错', () => {
  const { exports } = loadBundle()
  const captured = {}
  const ctx = {
    effect: (fn, label) => { captured.effectLabel = label; fn() },
    locale: {
      register: (namespace, dictionaries) => {
        captured.namespace = namespace
        captured.dictionaries = dictionaries
        return () => {}
      },
      bind: (namespace) => {
        captured.boundNamespace = namespace
        return (key, params) => {
          let text = captured.dictionaries.zh[key] ?? key
          if (params) for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value))
          return text
        }
      },
    },
    slots: {
      inject: (name, register) => { captured.injectedInto = name; register() },
      register: (options, component) => { captured.slotOptions = options; captured.component = component; return () => {} },
    },
  }
  exports.apply(ctx)

  assert.equal(captured.namespace, 'usageReport')
  assert.equal(captured.injectedInto, 'settings.section')
  assert.equal(captured.slotOptions.name, 'settings.section')
  assert.equal(captured.slotOptions.id, 'usage-report')
  assert.equal(typeof captured.slotOptions.label, 'function', 'label 必须是 thunk（延迟取当前语言）')
  assert.equal(typeof captured.component, 'function')
})

test('中英字典键集完全一致（不一致会在注册时抛错）', () => {
  const { exports } = loadBundle()
  let dictionaries
  exports.apply({
    effect: (fn) => fn(),
    locale: { register: (_namespace, value) => { dictionaries = value; return () => {} }, bind: () => () => '' },
    slots: { inject: (_name, register) => register(), register: () => () => {} },
  })
  const zh = Object.keys(dictionaries.zh).sort()
  const en = Object.keys(dictionaries.en).sort()
  assert.deepEqual(zh, en)
  assert.ok(zh.length > 10, '字典不应是空壳')
})

test('字典里不留未替换的占位符（如 {projected}）', () => {
  const { exports } = loadBundle()
  let dictionaries
  exports.apply({
    effect: (fn) => fn(),
    locale: { register: (_namespace, value) => { dictionaries = value; return () => {} }, bind: () => () => '' },
    slots: { inject: (_name, register) => register(), register: () => () => {} },
  })
  const source = readFileSync(CLIENT_PATH, 'utf8')
  for (const [locale, table] of Object.entries(dictionaries)) {
    for (const [key, text] of Object.entries(table)) {
      const placeholders = [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1])
      for (const name of placeholders) {
        assert.ok(
          // 占位符必须在该 bundle 的调用点有对应传参（`{ name: … }` 或简写 `{ name }`）
          new RegExp(`\\b${name}\\s*[,:}]`).test(source),
          `${locale}.${key} 的占位符 {${name}} 没有对应的传参`,
        )
      }
    }
  }
})
