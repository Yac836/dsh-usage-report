# dsh-usage-report

一个 DSH 插件：**跨会话**汇总 token 用量与花费，按 provider 与 model 拆开，并通过三个出口呈现 ——
`/usage` 斜杠命令、`GET /api/usage.report` JSON 路由、设置页的「用量」面板。

[English](README.md) · [维护、部署与恢复](docs/MAINTENANCE.md)
· [脱敏配置样例](examples/cordis.patch.example.yml)

这是运行在 DSH 进程中的插件，没有独立启动命令或构建步骤。供应商鉴权由宿主负责，
本插件不接收 API Key，也不会自动读取 `.env`；[`.env.example`](.env.example)
只说明可选的 `DSH_HOME` 环境变量。

## 效果

面板长这样 —— 它读宿主维护的会话投影，而不是重扫日志：

![用量面板](docs/panel.png)

![用量热力图](docs/heatmap.png)

## 为什么要它

DSH 原生统计都是**单会话**口径：`dsh-session-stats` 暴露 `sessionStats` 投影，
`dsh-token-meter` 暴露 `totalTokens` 投影，两者都只覆盖一个会话；而且整条链路里没有任何消费方
上报花费（`dsh-llm-pi-ai` 的源码写明 "the harness never reads pi-ai's cost metadata … and no
consumer reports spend"）。因此「我总共花了多少」在原生的 DSH 里没有答案，本插件补的就是这个空缺。

## 特性

- **跨会话汇总**：按 provider 与 model 给出调用数、输入、缓存命中、输出与花费。
- **投影优先、扫描兜底**：活跃会话从宿主增量维护的投影读取（零 IO），冷会话从宿主的 durable
  投影缓存读取（同样零日志 IO，重启后不必重扫）；只有投影读不到或不可信时才回退读日志。
- **两条路径、同一个 fold**：投影路径与兜底路径复用同一个 fold 函数，因此结果逐位一致
  （有测试断言）。
- **价格现算**：单价在调用时从已安装的 pi-ai 目录读取，本仓库里没有任何价格表。
- **不内置汇率**：默认 USD；只有显式给出 `cnyPerUsd` 才会显示人民币。
- **自然日窗口**：`/usage 7` 表示「最近 7 个自然日（含今天）」；面板还提供「今天」「近 30 天」，
  以及**任意起止日期**。
- **绝不为冷扫描等待**：启动后台预热默认区间；请求立即返回最近一次快照并标注「数据截至」时间。
- **诚实呈现**：匹配不到价格的模型会被明确列出（绝不静默按 $0 计），读取失败的会话只做计数，
  不会被藏起来。
- **零构建**：浏览器半是手写的 bundle，项目没有构建链。

## 安装

### 方式 A —— 路径 insert（不需要 pnpm）· 推荐

1. 把插件目录放进 profile 内，例如 `~/.dsh/profiles/web/plugins/dsh-usage-report/`。
2. 在 profile 的 patch 文件 `~/.dsh/profiles/web/cordis.patch.yml` 里加一条 `insert`：

   ```yaml
   - insert:
       - id: usage-report
         name: ./plugins/dsh-usage-report/lib/index.js
   ```

3. 重启 DSH。

关于路径形式：

- **`insert`** 行里，看起来像路径的 `name` 会被 patch 解析自动转成 `file://` URL；
  **`id` 定向行不做这个转换**，因此「用路径加载」只能走 `insert`。
- 相对路径以**该 patch 文件所在目录**为基准。
- `@deepseek-ai/*`、`@earendil-works/pi-ai` 与 `zod` 会向上解析到共享的
  `~/.dsh/profiles/node_modules` 树，因此无需安装任何依赖。
- 新增 `insert` 行**不像**修改已有条目的 `config` 那样被热应用，加完要重启 DSH。

### 方式 B —— 已核验来源的 npm 包

仅在确认 npm 包的所有者、来源和版本后使用。GitHub 私有仓库不代表同名 npm 包归自己所有，
也不能证明该包已发布；本私有 checkout 优先使用上面的路径安装流程。

```sh
dsh plugin add dsh-usage-report
```

这条路径需要机器上有 `pnpm`。

### 兼容性闸门

安装前，DSH 会把 manifest 里每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 范围拿去和
**当前运行时版本**比对（预发布版本也参与范围判断）。范围不匹配就判定插件不兼容并拒绝安装 ——
钉死一个较旧的 DSH 精确版本，正是让插件「直接消失」的原因。这些范围要保持宽松。

| peer | 范围 | 是否被闸门检查 |
|---|---|---|
| `@deepseek-ai/dsh-commands` | `>=0.2.0-rc.2` | 是 |
| `@deepseek-ai/dsh-session-query` | `>=0.2.0-rc.2` | 是 |
| `@deepseek-ai/dsh-client-ui-settings` | `>=0.2.0-rc.2` | 是 |
| `@deepseek-ai/dsh-client-locale` | `>=0.2.0-rc.2` | 是 |
| `@deepseek-ai/dsh-home-paths` | `>=0.2.0-rc.2` | 是 |
| `@deepseek-ai/cordis` | `~4.0.4` | 否 —— 不在 `dsh` 命名空间内 |
| `@deepseek-ai/schemastery` | `~3.18.4` | 否 —— 不在 `dsh` 命名空间内 |

五个 DSH peer 刻意用开放下界（`>=0.2.0-rc.2`）而不是钉死版本：这是本插件开发所依据的最老运行时，
任何更新的运行时仍然满足它。闸门只检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 命名空间内的名字，
因此 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 只是被声明、不会被检查。在 DSH workspace 内
开发的贡献者也可以用 `workspace:^`、`workspace:~`、`workspace:*` 三种写法通过闸门 —— DSH 把它们
读作「当前运行时版本」。

`@earendil-works/pi-ai`（用于目录价格与 `calculateCost`）与 `zod`（用于投影 `stateSchema`）是在
`peerDependenciesMeta` 里标为 **optional** 的 peer，因为两者都由 DSH 宿主提供。插件不打包任何依赖，
也没有需要安装的运行时 `dependencies`。

### 可选：改显示币种

```yaml
- insert:
    - id: usage-report
      name: ./plugins/dsh-usage-report/lib/index.js
      config:
        currency: CNY      # USD（默认）| CNY
        cnyPerUsd: 7.20    # 仅为示例 —— 请填你自己的账务汇率
```

## 用法

### 斜杠命令

任何有命令注册表的 profile 都可用：

```
/usage                              # 全部历史
/usage 7                            # 最近 7 个自然日（含今天）
/usage 2026-10-01..2026-10-15       # 显式日期区间（含首尾两天）
/usage 2026-10-01..                 # 从那天到今天
```

参数可以是正整数、`起..止`（`YYYY-MM-DD`），或省略。其它输入（`/usage 0`、`/usage x`、起止倒置）
不会给出报告，而是返回用法提示。

### 设置页面板

设置 →「用量」。自上而下：区间控件 → 明细表格 → 汇总卡片 → 热力图 → 提示行。信息层级参考
[cc-switch](https://github.com/farion1231/cc-switch) 的用量页，但把明细表格提到了最上面 ——
日常最常看的就是"哪个 provider 花了多少"。

1. **Tab + 表格** —— 按供应商或按模型切换。计数与 token 用紧凑格式（`32.5B`、`343K`）；
   金额显示 2 位，悬浮给出 6 位精确值。
2. **汇总卡片** —— 总花费、总调用、实际消耗 Tokens（新增输入 + 输出 + 缓存读 + 缓存写）、
   **缓存命中率** = `缓存读 / (新增输入 + 缓存写 + 缓存读)`。每张卡自带分项行（美元原值、会话数、
   输入/输出、缓存读/写），四个原始桶无需点击即可见。
3. **用量热力图** —— 每天一格，跨度按你的数据自适应（4–53 周），颜色越深用量越大；可在
   **Tokens / 请求 / 成本** 之间切换，悬浮某格给出那天的精确数字。跨度刻意不随区间收窄，
   否则选 `days=7` 时会缩成一列，失去"看长期形状"的意义。
4. **提示行** —— 计价、币种换算、**数据截至时间**、扫描统计、未定价模型、读取失败的会话。

卡片上方的区间按钮：全部 / **今天** / 近 7 天 / 近 14 天 / 近 30 天，以及**自定义**（两个原生
日期选择器；只填一侧表示"从最早"或"到今天"），改动即刻生效。工具栏旁的**刷新**按钮会强制在后台
重算而不是等待，旁边的文字写明数据是何时算出来的。

所有图表都是纯 DOM/SVG —— 不引入任何图表依赖，与"零构建"的设计保持一致。

### JSON 路由

```
GET /api/usage.report          # 全部历史
GET /api/usage.report?days=7   # 最近 7 个自然日
```

响应形如
`{ range, money, total, providers, models, unpriced, sessions, unreadable, steps, currency, unit,
scan, series, asOf, refreshing }`；`providers` 与 `models` 按花费降序排列，每个桶同时带 `cost`
（展示币种）与 `costUsd`（未折算）。`range` 里按用法给出 `days` 或 `from`/`to`。

`series` 是按天的明细（`[{ day, calls, input, output, cacheRead, cacheWrite, cost, costUsd }]`，
按 `day` 升序），热力图就是用它画的。**它刻意不随区间收窄**（上限最近 53 周）：热力图存在的意义
就是看长期形状，若跟着区间走，选 `days=7` 时它只会剩一列。把 `series` 按窗口切一刀，其和**精确
等于**卡片上的总计 —— 测试里断言了这一点：图表和卡片对不上是 bug，不是舍入误差。

`days` 必须是正整数，`from`/`to` 必须是 `YYYY-MM-DD`（且 `from <= to`），否则路由返回 `400`。
该路由只在挂了 Web 连接的 profile 里注册 —— 没有 Web 连接时斜杠命令照常可用。

**路由绝不为冷扫描等待。** 还没有快照时它立刻返回 `{ refreshing: true }`（不给半个报告），面板会
重试；已有快照则直接返回，并带 `asOf`（毫秒时间戳）与 `refreshing` 告知是否有更新的正在计算。
加 **`force=1`** 可立刻启动一次重算 —— 返回的仍是当前快照并标记 `refreshing: true`，所以点击不会
卡住。详见下面的「快照与预热」。

## 工作原理

### 投影优先

插件向宿主的 `ctx.sessionProjections` 注册一个名为 `usageReport` 的会话投影单元。宿主对每个
**新提交**的事件只调一次 `apply(prev, event)` —— 真增量、不重算 —— 并把结果状态落盘到
`~/.dsh/storages/session_projcache/`。这与官方 `dsh-token-meter`、`dsh-session-stats` 用的是
同款机制。

本单元遵守宿主对投影的三条约束：

1. 不含可计费用量的事件必须返回**同一个 state 引用** —— 宿主用 `Object.is` 作为变更闸门。
2. state 必须是可 JSON 序列化的纯数据：它会被写入磁盘并由 `stateSchema` 校验。
3. `apply` 必须是纯函数，因为宿主可能在任意水位重放它。

两条本单元特有的设计：

- **只 fold 原始 token，不 fold 金额。** pi-ai 目录调过价（flash 每百万输入 token 从 $0.14 调到
  $0.30）。金额若固化进投影，旧价会永远留在磁盘上；因此金额一律在读取时按当前目录现算。
- **state 自带完整性水位**，见下一节。

### 判断一个投影是否可信

宿主对投影单元是**懒折**的 —— 在单元注册**之后**、会话第一次被触碰时才折。对一个「安装插件之前
就存在」的会话，这可能朝两个方向出错：折叠可能从索引 0 开始、把 fork 继承前缀一起折进去
（与父会话重复计费），也可能只覆盖注册之后提交的事件（漏算）。

因此 state 记录两个水位：`inherited`（`init` 收到的继承前缀长度）与 `headSeq`（本单元**见到的
第一个事件**的 `seq` —— 每会话只记录一次，即使那个事件本身不带用量）。

| 关系 | 含义 | 可否信任 |
|---|---|---|
| `headSeq === inherited` | 恰好从本会话第一个自有事件开始折叠 | ✅ |
| `headSeq > inherited` | 头部缺失（注册晚于会话，或懒折只覆盖了一部分） | ❌ 走兜底扫描 |
| `headSeq < inherited` | 折进了继承前缀，会重复计费 | ❌ 走兜底扫描 |
| `headSeq === null` | 本单元一个事件都没见过 | ❌ 走兜底扫描 |

最后一行最要紧：空状态既可能是「这个会话确实没有计费事件」，也可能是「单元从未跑过」，二者无法
从状态区分。本插件宁可多读一次日志，也不静默少算。反过来，「有自有事件、只是都不计费」是可信的 ——
那些事件同样会记录 `headSeq`。

### 兜底扫描及其缓存

只有在投影**读不到或不可信**时才改读日志并在本地折叠 —— 也就是安装后第一次聚合，或宿主还没有为
该会话留下 durable checkpoint 时。

冷会话（未挂载到本进程）读的是宿主的 durable 投影缓存：因为本单元声明了 `wire` 视图，
`sessionProjectionCache.cachedSnapshot()` 能以**零日志 IO** 取回它的状态，所以**重启不会重扫历史**。
声明 `wire` 在这里不是为了浏览器，而是因为那是唯一能把单元的持久化状态暴露给跨会话读取的公开路径。
状态很小（实测：15 个会话、日志合计 13.3 MB，状态合计 5.8 KB），因此额外载荷可忽略。
宿主在 `session/created`、`turn/end`、`session/disposed` 三个点写 checkpoint。

兜底路径按持久化层从 `stat` 派生的 `revision`（`dev:ino:size:mtimeNs:ctimeNs`）缓存每个会话的结果 ——
一次 `stat` 就足以识别任何内容变化。缓存的内容是 fold 出来的**状态**（按 provider/model/自然日分桶的
原始 token），刻意不含价格；它相对被替代的日志非常小：实测 15 个会话 / 13.3 MB 日志，全部状态合计
5.8 KB（约 0.04%）。缓存是有界 LRU（默认 2048 条），命中即刷新位置，并清掉已不存在的会话。如果持久化层
不可用、或某个会话还没有 revision，那这个会话就只是**不可缓存**而已：缺一个 revision 绝不能让整份统计
失败。

缓存还会**跨进程重启存活**：每次聚合结束时写一次（先写临时文件再原子 rename），位置是
`<dsh home>/cache/dsh-usage-report/fallback-cache.json`，通过宿主的 `dshCachePath` 解析。这一点很关键 ——
你**再也不会打开**的那些会话永远不会有宿主 checkpoint，没有这个文件的话每次重启都要重扫它们，而且
开销随历史增长。文件里记着投影的 `stateVersion`，所以折叠语义一变就整体作废，而不是拿旧形状的数据
去算新数字；文件缺失、损坏或读不出来，都只当作空缓存。

冷读并发上限为 4 个会话，避免与前台 agent 抢 IO。两条路径共用同一个 fold，测试通过把同一批合成会话
分别喂给投影路径与兜底路径，断言两者输出完全一致。

### 为什么缓存不是可选项

`sessionQuery.readSession` 会读取并**重放校验**整个会话日志，而 DSH 自身的缓存只覆盖「相邻两步之间在飞的
会话」：JSONL 持久化层只 memo 最近 2 条已解析日志（`COLD_LOG_MEMO_MAX_ENTRIES = 2`），
`dsh-session-query` 的 prepared-session 缓存为 5 条
（`SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5`）。会话数一超过这个量级就完全抖动失效，
每次统计都退化为 O(全部历史) —— 在开发机上实测 11 个会话 / 11.4 MB 日志约 710 ms，而这还是**下界**，
未计重放校验与逐事件克隆。

实际成本不靠猜：命令输出与面板都会打印 `projected / scanned / reused / elapsedMs`。

### 快照与预热

缓存消掉了重复的工作，但消不掉第一次：重启之后，凡是"上次运行后变过"的会话都必须读一次。这一次
很贵 —— `readSession` 会重放校验整个日志并逐事件克隆，实测**约 1.6 秒/会话**（开发机上 4 个变更
会话 ⇒ 6.3 秒，而总共只有 13 个会话 / 13 MB）。

所以插件用**快照**，并且绝不为冷扫描阻塞：

- 启动后（延迟 `warmupDelayMs`，用 `warmup: false` 可关闭）在后台算好默认区间，于是面板第一次
  打开就已经有数据；
- 请求立刻返回该区间最新的快照，并带上 `asOf`（毫秒时间戳）与 `refreshing`；若还没有快照，路由返回
  `{ refreshing: true }`，面板每 1.5 秒重试一次；
- 超过 `ttlMs` 的快照仍然立刻返回，同时在后台刷新（stale-while-revalidate）；同一区间的并发请求
  共用一次刷新；
- 面板与命令都会打印"数据截至"时间，所以旧数字不会被误当成新数字。`/usage` 命令则会等待结果 ——
  命令等得起。

这个取舍是显式的、可配置的：**用新鲜度换延迟**，上界由 `ttlMs` 和后台读取耗时决定。

## 配置

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `currency` | `'USD' \| 'CNY'` | `'USD'` | 展示币种。聚合层内部始终是 USD。 |
| `cnyPerUsd` | 数字 ≥ 0.01 | — | 1 USD 折合多少 CNY。仅在 `currency: CNY` 时读取。 |
| `warmup` | 布尔 | `true` | 启动后在后台计算默认区间（全部历史），使面板第一次打开不必等冷扫描。 |
| `warmupDelayMs` | 数字 ≥ 0 | `2000` | 预热延迟，避开启动最忙的那一段。 |
| `ttlMs` | 数字 ≥ 0 | `30000` | 快照多久算"新鲜"。更旧的快照仍会立刻返回，并在后台刷新。 |

**代码不内置任何汇率。** 汇率是使用者的账务口径（结汇价、平台折算价各不相同），猜一个数字既不准也不该。
配置 `currency: CNY` 但没给合法 `cnyPerUsd` 时，会如实回退为美元：命令会打印一行回退警告，JSON 里
`money.fellBack: true`。插件的 `Config` schema 只接受 `USD` 或 `CNY`（其它取值在插件加载时即被拒绝）；
展示层的换算器则把无法识别的币种按 USD 处理。

聚合层始终以 USD 为规范量（那正是价格目录的单位），只有展示层做换算。这样物理量与呈现彼此分离，
也让 JSON 能同时给出 `cost` 与 `costUsd`，便于逐项与目录核对。

## 定价

价格**不硬编码**。一律在调用时通过 `getBuiltinModels('deepseek')` 从 pi-ai 内置目录读取，并用 pi-ai
自己的 `calculateCost` 计算，单位是 **USD / 每百万 token**。目录升级即价格更新，无需改代码。

解析顺序：显式覆盖 → model id 原样命中 → 归一化后命中 → 未定价。其中「显式覆盖」属于
`pricing.js` / `aggregate.js` 的模块 API（`resolve(provider, model)`），并没有暴露成插件配置，
因此实际使用时是从「原样命中」这一步开始的。

归一化会去掉路由前缀（`x/`）、末尾 6–8 位日期、版本号（`v4`、`v4.1`）以及所有非字母数字字符。若两个
目录条目归一化后冲突，该键会被刻意置为不匹配，而不是猜一个。

| 日志里的 model id | 归一化键 | 匹配到的目录条目 | 命中方式 |
|---|---|---|---|
| `deepseek-flash` | `deepseekflash` | `deepseek-flash` | 原样命中 |
| `deepseek-v4-pro` | `deepseekpro` | `deepseek-v4-pro` | 原样命中 |
| `deepseek-v4-flash` | `deepseekflash` | `deepseek-flash` | 归一化 |
| `deepseek/deepseek-flash` | `deepseekflash` | `deepseek-flash` | 归一化 |
| `deepseek-v4-pro-202606` | `deepseekpro` | `deepseek-v4-pro` | 归一化 |

解析不到价格的模型会被列进「未定价」—— 命令输出里与 JSON 的 `unpriced` 字段里都有 —— 并按 $0 计入。
它绝不会被静默丢弃，因为丢弃会让总额被低估。

## 正确性要点

有两处特别容易算错，都做了刻意处理：

1. **fork 继承事件必须整段跳过。** `readSession` 返回的日志开头 `inheritedEventCount` 条是从父会话
   继承来的，已经计入父会话。兜底路径在折叠前把这段切掉；投影路径由上面的水位判据守住。把继承段
   计入两次，等于重复计费。
2. **`inputTokens` 不含缓存命中。** 宿主把四个**互斥**的桶相加 ——
   `inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens` —— 即 `dsh-token-meter` 的
   `usageTokens`，其注释为 "sum disjoint provider usage buckets without double-counting reasoning
   output"。因此把「输入」当作提示总量，误差恰好等于缓存部分的量，而缓存通常是其中最大的一项。
   缓存命中与缓存写入各按目录里各自的单价计费，与输入单价相差若干个数量级。

其它不变量：

- `days` 窗口按**本地自然日**：`days: 7` 覆盖最近 7 个本地自然日（含今天），不是滚动 168 小时。
  投影状态按本地自然日分桶，这样状态最小，也与面板的日粒度语义一致。
- 金额按**当前**目录价折算历史用量，因此报告回答的是「这些用量按今天的价格值多少」，不是「当时账单是多少」。
- `provider` 与 `model` 取自 `event.data.message.source`；任一缺失时该事件归入 `(未知)`。
- 路由键用 NUL 字节分隔 provider 与 model，并把真值存在值里，因此含 `/` 的 provider 或 model 不会被
  拆歧义。JSON 展示时按第一个 `/` 拆分，对真实 model id 可无损往返。
- 缓存写入会被折叠、计价并序列化（JSON 每个桶里都有 `cacheWrite`），但命令表格与面板都没有为它单独
  开一列；需要看它就直接读 JSON。

## 已知限制

- **durable checkpoint 可能落后于崩溃的那一轮。** 宿主只在轮次边界写 checkpoint，所以进程在某一轮
  中途被杀时，缓存里可能少几个事件。该会话下次被打开时会自愈（宿主从 checkpoint 继续折尾部）。
  水位判据看不到这种情况，因为头部是完整的。
- **安装插件之前就存在的会话，其投影可能永远不可信。** 它们可能被判为不完整（见水位判据），从而持续
  走兜底路径。
- **面板可能显示略旧的数据。** 它返回最新快照而不是为冷扫描阻塞，所以数字最多可能旧 `ttlMs`
  （默认 30 秒）加一次后台读取的时间。「数据截至」那行始终写明计算时刻；`/usage` 命令则是等待计算，
  永远是最新的。
- **花费是按 DeepSeek 官方价折算的。** 第三方网关的实际计价可能不同（套餐、折扣、峰谷价）。这个数字是
  「官方价等值」，不等于你的账单金额。
- **未定价模型会让花费被低估**，低估量恰好等于它们的用量；它们会被列出，好让这个差额可见。
- **host 半的用户可见文案是中文**：`/usage` 的输出、路由错误信息、JSON 的 `unit` 字段。只有 Web 面板
  做了中英双语。
- **投影状态版本是磁盘契约的一部分。** 任何折叠语义的改动都必须抬升 `USAGE_PROJECTION_VERSION`，
  否则磁盘上的旧行会被当作有效数据读入。
- **可缓存性依赖持久化层。** 没有 `sessionPersistence`、或某个会话取不到 revision 时，兜底路径每次都会
  重读该会话 —— 结果正确，只是更慢。

## 开发

先按锁文件安装开发和测试依赖。测试使用假宿主和合成事件，不要求运行 DSH；
接线测试会创建独立的临时 DSH home，不读取或裁剪用户真实缓存。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify -- --version 0.2.0-rc.2
npm test       # → node --test，来自 manifest 的 `test` 脚本
node --test    # 等价，直接在 checkout 里跑
```

需要 Node ≥ 20（声明在 `engines` 里），无需构建。`verify` 检查模块语法、manifest、
客户端 bundle id 和给定版本的 DSH peer 下界；无 `--version` 时尝试探测本机宿主，
找不到则明确跳过闸门。它不能代替实际部署宿主上的端到端验收。

测试专挑那些「错了也不会立刻报错」的地方：

- 无关事件必须返回同一引用；`headSeq` 每会话只记录一次；
- 全部四种水位关系，包括会导致重复计费的继承前缀情形；
- 投影路径与兜底路径输出逐位一致；
- `days` 窗口按自然日；
- revision 未变时兜底结果被复用；
- 未定价模型会被列出，且单个会话读取失败不会让整份报告失败；
- `apply()` 确实把三个出口（投影单元、命令、路由）都注册了，且缺少 `sessionProjections` 或
  `connection` 服务时是优雅退化而不是崩溃；
- 路由对非法的 `days` 返回 `400`，合法时返回 JSON；
- `Config` 默认美元且不含任何内置汇率；
- client bundle 以正确的 id 注册、导出 `apply`/`inject`、注册设置页 slot，且中英字典键集一致、
  没有未替换的死占位符。

### 文件

| 文件 | 半 | 职责 |
|---|---|---|
| `lib/index.js` | host | Cordis 插件：注册 `/usage` 与 JSON 路由（唯一接线层） |
| `lib/aggregate.js` | host | 跨会话聚合 + JSON 序列化 |
| `lib/projection.js` | host | `usageReport` 投影单元、共用的 fold、完整性判据 |
| `lib/cache.js` | host | 会话级兜底缓存（按 `revision` 失效，LRU 有界） |
| `lib/pricing.js` | host | 目录查价与 model id 归一化 |
| `lib/currency.js` | host | 展示币种换算（仅展示层） |
| `lib/render.js` | host | 命令输出的 Markdown 渲染 |
| `lib/client.js` | client | 设置页面板 |
| `test/`、`scripts/verify.mjs` | 开发 | 合成数据测试和插件自检 |
| `examples/`、`.env.example` | 配置 | 脱敏 profile 片段和宿主环境变量说明 |
| `docs/MAINTENANCE.md` | 维护 | 数据边界、部署、回滚、恢复和秘密检查流程 |

浏览器半是**手写的零构建 bundle**，形态为 `window.__ModuleLoader__.load({ id, factory })` ——
因为宿主原样服务该文件，没有东西会自动生成这层包装。工厂是懒执行的，模块体在首次 import 时才运行。
它只从平台的静态模块表里 require `react`，其余全部自己实现，从而不依赖任何未经验证的组件 props 契约。
这也是它看起来比原生面板朴素的原因。

## 维护与恢复

[维护手册](docs/MAINTENANCE.md) 说明依赖、宿主会话数据、可重建缓存、部署检查及恢复边界。
真实 profile、供应商凭据、会话日志、备份和用量导出保存在源码目录外；`.gitignore`
只防止误提交，不代表可以删除这些文件。`lib/client.js` 是手写源码，两张 PNG 是有引用的文档素材。
GitHub Actions 只安装依赖、自检并测试，不执行部署。

提交前扫描所有已获取 Git 历史及工作区，再复核暂存区并重新确认 GitHub 为 Private。
发现真实凭据入历史、仓库不再私有，或需要凭据轮换、历史重写时立即停止并报告。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
