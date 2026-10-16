/**
 * 价格解析：把任意 provider 的 model 映射到 DeepSeek 官方价。
 *
 * 设计原则：
 *  1. 价格**不硬编码**在本文件 —— 一律从 pi-ai 内置目录读取（USD / 每百万 token）。
 *     目录升级即价格更新，无需改代码。
 *  2. 解析顺序：显式映射 → model id 原样命中 → 归一化后命中 → 未定价。
 *     未定价的模型会被上层明确报出，绝不静默按 0 计（否则花费会被低估）。
 *  3. 归一化用于自定义 provider 的别名，例如
 *     `deepseek/deepseek-flash`、`deepseek-v4-pro-202606` 都要归到官方型号。
 */
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { calculateCost } from '@earendil-works/pi-ai'

/** 官方定价所属的目录 provider。 */
const PRICING_PROVIDER = 'deepseek'

/**
 * 归一化 model id：去路由前缀、去日期后缀、去版本号、去非字母数字。
 * 例：`deepseek/deepseek-flash` → `deepseekflash`
 *     `deepseek-v4-pro-202606` → `deepseekpro`
 *     `deepseek-v4-flash`      → `deepseekflash`
 */
export function normalizeModelKey(id) {
  return String(id)
    .toLowerCase()
    .replace(/^[a-z0-9_.-]+\//, '')
    .replace(/[-_]?\d{6,8}$/, '')
    .replace(/[-_]?v\d+(?:[._]\d+)*/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * 建立价格索引。
 * @param overrides - 显式映射 `{ "provider/model": "目录里的 model id" }`，
 *   仅在自动匹配失败或不希望自动匹配时使用。
 */
export function createPricing(overrides = {}) {
  const catalog = getBuiltinModels(PRICING_PROVIDER)
  const byId = new Map(catalog.map((model) => [model.id, model]))
  const byNormalized = new Map()
  for (const model of catalog) {
    const key = normalizeModelKey(model.id)
    // 归一化键冲突时不猜：置为 null，要求显式映射。
    byNormalized.set(key, byNormalized.has(key) ? null : model)
  }

  /** @returns { model, rates, matchedBy, key }；model 为 null 表示未定价。 */
  const resolve = (provider, modelId) => {
    const explicit = overrides[`${provider}/${modelId}`] ?? overrides[modelId]
    if (explicit !== undefined) {
      const model = byId.get(explicit)
      return model
        ? { model, rates: model.cost, matchedBy: 'explicit', key: explicit }
        : { model: null, rates: null, matchedBy: 'explicit-miss', key: explicit }
    }
    const exact = byId.get(modelId)
    if (exact) return { model: exact, rates: exact.cost, matchedBy: 'exact-id', key: modelId }
    const normalized = byNormalized.get(normalizeModelKey(modelId))
    if (normalized) {
      return { model: normalized, rates: normalized.cost, matchedBy: 'normalized', key: normalized.id }
    }
    return { model: null, rates: null, matchedBy: 'unpriced', key: modelId }
  }

  return { resolve, provider: PRICING_PROVIDER }
}

/**
 * 按官方价计算一条 usage 的花费。
 *
 * 注意两处契约：pi-ai 的 `calculateCost` 用的是
 * `input/output/cacheRead/cacheWrite`（不是日志里的 `...Tokens` 命名），
 * 且它会**原地填充** `usage.cost`，因此必须传一个可变对象。
 *
 * @returns { input, output, cacheRead, cacheWrite, total }，未定价时返回 null。
 */
export function costOf(priced, usage) {
  if (!priced?.model) return null
  return calculateCost(priced.model, {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    cost: {},
  })
}
