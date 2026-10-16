/**
 * 兜底路径的会话级缓存：内存 LRU + 可选磁盘持久化。
 *
 * 为什么需要磁盘持久化：对「装上插件后再没被打开过」的旧会话，宿主永远不会有它们的投影行
 * （checkpoint 只在会话活跃时写），所以每次进程启动都要重扫一遍，而且随历史线性增长。
 * 按 revision 失效的结果落盘后，**第二次启动起未变更的会话一律跳过**。
 *
 * 为什么活跃会话不需要它：活跃会话直接读宿主的投影，根本不经过这里。
 *
 * 失效键是持久化层 stat 派生的 revision（`dev:ino:size:mtimeNs:ctimeNs`）：
 * 一次 stat 即可拿到，size + 两个时间戳足以识别任何内容变化。
 *
 * 缓存内容是 fold 出来的**状态**（原始 token，不含金额），因此：
 *  - 体积小：实测 15 个会话 / 13.3 MB 日志，状态合计 5.8 KB（0.04%）；
 *  - 与价格解耦：pi-ai 调价后不会沿用旧价（金额永远在聚合时按当前目录现算）。
 *
 * 磁盘文件带 `stateVersion`：折叠语义一变（见 projection.js），旧文件自动失效，
 * 避免用旧形状的数据算出错数字。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 磁盘格式自身的版本（与投影的 stateVersion 分开：前者是文件封装，后者是折叠语义）。 */
const FILE_VERSION = 1

/**
 * @param options.maxEntries - 内存中最多保留多少个会话的状态（LRU）。
 * @param options.file - 磁盘缓存文件路径；省略则纯内存（测试或无法定位缓存目录时）。
 * @param options.stateVersion - 期望的折叠语义版本；与文件里的不一致就丢弃整个文件。
 */
export function createUsageCache({ maxEntries = 2048, file, stateVersion } = {}) {
  const entries = new Map()
  let loaded = false
  let dirty = false

  /** 首次访问时惰性读盘；任何异常都当作空缓存（首次运行、文件损坏、权限、半个文件）。 */
  const load = () => {
    if (loaded) return
    loaded = true
    if (file === undefined) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed?.version !== FILE_VERSION) return
      if (stateVersion !== undefined && parsed.stateVersion !== stateVersion) return
      for (const [id, entry] of Object.entries(parsed.entries ?? {})) {
        if (typeof entry?.revision !== 'string' || entry.state === undefined) continue
        entries.set(id, { revision: entry.revision, state: entry.state })
      }
    } catch {
      // 读不回来只是失去优化，不能让统计失败
    }
  }

  return {
    /**
     * 命中则返回上次的结果。
     * @param sessionId - 会话 id。
     * @param revision - 持久化层的变更令牌；不一致即视为未命中。
     */
    get(sessionId, revision) {
      load()
      const entry = entries.get(sessionId)
      if (entry === undefined || entry.revision !== revision) return undefined
      // 命中即刷新 LRU 位置（Map 保持插入顺序，最早的是最久未用）
      entries.delete(sessionId)
      entries.set(sessionId, entry)
      return entry.state
    },

    /**
     * 记录一次结果。
     * @param sessionId - 会话 id。
     * @param revision - 本次结果依据的变更令牌。
     * @param state - fold 出来的状态。
     */
    set(sessionId, revision, state) {
      load()
      entries.delete(sessionId)
      entries.set(sessionId, { revision, state })
      dirty = true
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value)
        dirty = true
      }
    },

    /** 丢弃已不存在的会话，避免缓存随历史无限增长。 */
    retain(sessionIds) {
      load()
      for (const id of entries.keys()) {
        if (!sessionIds.has(id)) {
          entries.delete(id)
          dirty = true
        }
      }
    },

    /**
     * 把缓存写到磁盘（先写临时文件再原子替换，避免留下半个文件）。
     * 由调用方在**一次聚合结束时**调用，而不是每次 `set` —— 冷扫描会 set 很多次。
     * 写失败（只读磁盘、配额）只失去优化，绝不让统计失败。
     */
    flush() {
      if (file === undefined || dirty !== true) return
      dirty = false
      try {
        mkdirSync(dirname(file), { recursive: true })
        const body = JSON.stringify({
          version: FILE_VERSION,
          ...(stateVersion === undefined ? {} : { stateVersion }),
          entries: Object.fromEntries(entries),
        })
        const temporary = `${file}.tmp`
        writeFileSync(temporary, body)
        renameSync(temporary, file)
      } catch {
        // 见上：磁盘问题不是统计失败的理由
      }
    },

    get size() {
      load()
      return entries.size
    },
  }
}
