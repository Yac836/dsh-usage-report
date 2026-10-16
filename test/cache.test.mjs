/**
 * 兜底缓存的测试，重点是**磁盘持久化**：这是"第二次启动起不必重扫旧会话"的关键。
 *
 * 用临时目录里的真实文件测，覆盖原子写、版本失效、损坏容错与 LRU 上限。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createUsageCache } from '../lib/cache.js'

const withTempFile = (run) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-cache-'))
  try {
    return run(join(dir, 'nested', 'cache.json'), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const state = (input) => ({ steps: 1, input })

test('纯内存模式：不传 file 也能正常工作', () => {
  const cache = createUsageCache()
  assert.equal(cache.get('s1', 'r1'), undefined)
  cache.set('s1', 'r1', state(10))
  assert.deepEqual(cache.get('s1', 'r1'), state(10))
  assert.equal(cache.get('s1', 'r2'), undefined, 'revision 变了就不命中')
  cache.flush() // 无文件时是空操作，不应抛错
})

test('落盘后新建实例仍能命中（重启场景）', () => {
  withTempFile((file) => {
    const first = createUsageCache({ file, stateVersion: 2 })
    first.set('s1', 'r1', state(10))
    first.set('s2', 'r1', state(20))
    first.flush()

    // 新进程：新实例，同文件
    const second = createUsageCache({ file, stateVersion: 2 })
    assert.deepEqual(second.get('s1', 'r1'), state(10), '重启后应当直接命中')
    assert.deepEqual(second.get('s2', 'r1'), state(20))
    assert.equal(second.size, 2)
  })
})

test('stateVersion 变化会让整个文件失效（避免用旧形状算错数字）', () => {
  withTempFile((file) => {
    const first = createUsageCache({ file, stateVersion: 2 })
    first.set('s1', 'r1', state(10))
    first.flush()

    const bumped = createUsageCache({ file, stateVersion: 3 })
    assert.equal(bumped.get('s1', 'r1'), undefined)
    assert.equal(bumped.size, 0)
  })
})

test('文件损坏 / 半个文件 / 缺字段都当作空缓存，不抛错', () => {
  withTempFile((file) => {
    mkdirSync(dirname(file), { recursive: true }) // 直接写文件（不走缓存），先建目录
    writeFileSync(file, '{ this is not json')
    assert.equal(createUsageCache({ file }).get('s1', 'r1'), undefined)

    writeFileSync(file, JSON.stringify({ version: 1, entries: { s1: { revision: 'r1' } } }))
    assert.equal(createUsageCache({ file }).get('s1', 'r1'), undefined, '缺 state 的条目要跳过')

    writeFileSync(file, JSON.stringify({ version: 999, entries: { s1: { revision: 'r1', state: state(1) } } }))
    assert.equal(createUsageCache({ file }).get('s1', 'r1'), undefined, '文件格式版本不符要丢弃')
  })
})

test('retain 清掉已消失的会话，并把清理结果落盘', () => {
  withTempFile((file) => {
    const cache = createUsageCache({ file })
    cache.set('s1', 'r1', state(1))
    cache.set('s2', 'r1', state(2))
    cache.retain(new Set(['s1']))
    assert.equal(cache.size, 1)
    cache.flush()

    const reloaded = createUsageCache({ file })
    assert.equal(reloaded.get('s1', 'r1').input, 1)
    assert.equal(reloaded.get('s2', 'r1'), undefined)
  })
})

test('maxEntries 是上限，超出后按最久未用淘汰', () => {
  withTempFile((file) => {
    const cache = createUsageCache({ file, maxEntries: 2 })
    cache.set('s1', 'r1', state(1))
    cache.set('s2', 'r1', state(2))
    cache.get('s1', 'r1') // 让 s1 变新
    cache.set('s3', 'r1', state(3))
    assert.equal(cache.size, 2)
    assert.equal(cache.get('s2', 'r1'), undefined, 's2 是最久未用的，应被淘汰')
    assert.deepEqual(cache.get('s1', 'r1'), state(1))
  })
})

test('目录不存在时会自动创建，写入是原子替换（不残留 .tmp）', () => {
  withTempFile((file, dir) => {
    const cache = createUsageCache({ file })
    cache.set('s1', 'r1', state(1))
    cache.flush()
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.entries.s1.revision, 'r1')
    assert.throws(() => readFileSync(`${file}.tmp`, 'utf8'), '临时文件必须已被 rename 掉')
    assert.ok(dir.length > 0)
  })
})
