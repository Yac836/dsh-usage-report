/**
 * 币种换算（纯逻辑，只在展示层使用）。
 *
 * 为什么需要它：pi-ai 内置目录里的价格单位是 **USD / 每百万 token**
 * （`TokenCost` 的 JSDoc 明写 "Price per million prompt tokens (USD)"），
 * 而国内控制台/账单按 **CNY** 出账。两者是同一套单价的两种表示，只差币种。
 *
 * 设计边界：
 *  - **聚合层始终以 USD 为规范量**（那才是价格目录的单位），只有展示层调用本模块换算；
 *  - **不内置任何汇率**。汇率是使用者自己的账务口径（结汇价、平台折算价各不相同），
 *    代码猜一个数字既不准也不该——想显示 CNY 就必须显式给出 `cnyPerUsd`，
 *    否则回退为 USD 显示并在提示行说明。
 */

const SYMBOLS = { CNY: '¥', USD: '$' }
const DECIMALS = { CNY: 4, USD: 4 }

/**
 * 构造一个换算器。
 *
 * @param config - `{ currency?: 'CNY'|'USD', cnyPerUsd?: number }`。
 *   省略 `currency` 时用 USD；`currency: 'CNY'` 但没给合法汇率时同样回退为 USD。
 * @returns 换算器；`fellBack` 为 true 表示请求了 CNY 但缺汇率、已回退。
 */
export function createMoney(config = {}) {
  const requested = config.currency === 'CNY' ? 'CNY' : 'USD'
  const rate = Number.isFinite(config.cnyPerUsd) && config.cnyPerUsd > 0 ? config.cnyPerUsd : undefined
  const fellBack = requested === 'CNY' && rate === undefined
  const currency = fellBack ? 'USD' : requested
  const factor = currency === 'CNY' ? rate : 1

  return {
    currency,
    symbol: SYMBOLS[currency],
    cnyPerUsd: rate,
    /** 是否真的在做 USD→CNY 换算（用于在界面上如实标注，不做无声换算）。 */
    converts: currency === 'CNY',
    /** 请求了 CNY 但缺汇率而回退。 */
    fellBack,
    /** USD 金额 → 展示币种金额。 */
    fromUsd: (usd) => usd * factor,
    /** USD 金额 → 带符号的展示字符串。 */
    format: (usd) => `${SYMBOLS[currency]}${(usd * factor).toFixed(DECIMALS[currency])}`,
    /** 币种的中文说明，供提示行使用。 */
    label: currency === 'CNY' ? '人民币' : '美元',
  }
}
