# 维护、部署与恢复

本项目是 DSH 的进程内用量统计插件，不是独立服务。它提供 `/usage` 命令、
`GET /api/usage.report` 和设置页用量面板。没有独立启动命令、监听端口、数据库、
Docker 部署或编译步骤；运行需要 DSH 宿主及其服务。

## 结构与依赖

| 路径 | 用途 | 是否应保留 |
|---|---|---|
| `lib/index.js` | 配置、命令、HTTP 路由和预热接线 | 源码 |
| `lib/aggregate.js`、`lib/projection.js` | 会话聚合、按自然日折叠和完整性校验 | 源码 |
| `lib/cache.js` | 按 revision 失效的 LRU 和磁盘兜底缓存 | 源码 |
| `lib/pricing.js`、`lib/currency.js`、`lib/render.js` | 目录定价、币种和命令展示 | 源码 |
| `lib/client.js` | 手写浏览器 bundle，宿主直接加载 | 源码，不能作为构建产物删除 |
| `test/` | 使用合成事件和假宿主的 Node 测试 | 测试源码 |
| `scripts/verify.mjs` | 语法、插件导出、manifest 和 DSH 版本检查 | 维护工具 |
| `examples/`、`.env.example` | 不含凭据的配置样例 | 文档 |
| `docs/*.png` | 两份 README 引用的面板和热力图 | 文档素材 |
| `package-lock.json` | 可复现的开发与测试依赖 | 必须提交 |
| `node_modules/` | `npm ci` 安装的本地依赖 | 可重建，忽略 |

Node 要求为 `>=20`，CI 覆盖 20、22、24。`package.json` 没有运行时 `dependencies`：

- DSH 提供 Cordis、Schemastery、commands、session-query、home-paths 和客户端服务等 peers；
  五个 `@deepseek-ai/dsh-*` peer 的下界均为 `0.2.0-rc.2`。
- `@earendil-works/pi-ai` 和 `zod` 同时是宿主提供的可选 peer 和本地测试 devDependency。
  实际价格来自宿主所安装 pi-ai 的内置目录，插件不会联网查询汇率或供应商账单。
- 浏览器从宿主取得 React，不另外打包前端依赖。
- 具体安装版本由 `package-lock.json` 固定。升级 peer 范围或目录版本后要重新验收，
  版本下界检查通过不能证明所有未来 DSH 版本的运行兼容性。

## 配置与私密数据边界

使用 [patch 样例](../examples/cordis.patch.example.yml) 合并一条插件配置。
配置 schema 声明 `currency`、`cnyPerUsd`、`warmup`、`warmupDelayMs`、`ttlMs`，
本插件不接收密码、API Key、Cookie 或 Token。

[`.env.example`](../.env.example) 仅说明可选的 `DSH_HOME`，**不会被插件自动加载**。
需要自定义数据根目录时，在启动宿主前设置进程环境变量；不要假设 YAML 中的
`${VARIABLE}` 会被替换，也不要把 DSH home 指向源码 checkout。

供应商鉴权属于 DSH 宿主，按宿主实际支持的方式读取环境变量、系统凭据或项目外的私密文件；
Bitwarden 可保存真实凭据，项目内最多记录条目名称，不导出保险库、不提交真实配置。
本项目没有实现读取凭据文件或从 Bitwarden 自动取密的功能，不能只填一个路径就宣称迁移完成。
私密文件和备份应限制为运行账号可访问，权限须在真实主机上确认。

| 数据 | 位置 / 性质 | 处理原则 |
|---|---|---|
| DSH profile patch 与供应商配置 | DSH home 下，可能包含其他插件的凭据 | 留在项目外，单独保护，不整份复制到 Git |
| 原始会话与宿主持久化数据 | DSH 管理，可能有对话、身份信息和敏感日志 | 业务数据，备份与恢复由宿主负责 |
| 宿主投影 | `<DSH_HOME>/storages/session_projcache/` | 宿主维护，禁止用清理源码的理由删除 |
| 插件兜底缓存 | `<DSH_HOME>/cache/dsh-usage-report/fallback-cache.json` | 含会话标识、provider/model、日期和用量，可从会话重建 |
| 内存快照 | DSH 进程内 | 重启后重新计算，可能先返回 `refreshing: true` |

未设置 `DSH_HOME` 时，宿主辅助库默认使用 `~/.dsh`。兜底缓存不保存原始对话或凭据，
但用量、费用和 provider 名称仍应按私密业务信息保护；不要把报告、真实截图或缓存当作公开样例。
现有文档图片仅作界面参考，不用于证明当前生产统计正确；新增样例应使用合成数据。

`/api/usage.report` 的访问边界由 DSH Web 宿主控制，本插件不增加独立鉴权或公网监听。
不要单独将该路由映射到公网。源码中的前端请求使用相对路径；依赖锁文件中的 registry、
上游仓库和资助链接属于依赖元数据，不是插件的业务外联配置。

## 本地开发与验证

在源码 checkout 内执行，Windows PowerShell 使用 `npm.cmd` 亦可：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify -- --version 0.2.0-rc.2
npm test
npm audit
```

`--ignore-scripts` 跳过第三方安装脚本，现有测试不依赖这些脚本；不要改用会漂移 lockfile 的
`npm install` 作为日常或 CI 安装步骤。`npm audit` 需要访问 registry，失败时不能算作无漏洞。
测试使用合成数据，接线测试会为自己创建独立的临时 DSH home，避免接触运行中的缓存。
临时文件根目录由系统 `TEMP`/`TMP` 决定，维护时可将它们设置为项目外的一次性工作目录。

`npm run verify` 无参数时会尝试读取 `DSH_HOME` 或 `~/.dsh` 下的宿主包版本。
若没有找到宿主，会明确跳过兼容性检查；`--version` 仅检查给定版本的 peer 下界。
部署前应使用实际安装包：

```sh
npm run verify -- --dsh "<DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh"
```

这不是端到端验收。最终还需在获准操作的宿主上确认面板加载、命令输出、路由访问权限、
缓存持久化和重启后统计。当前 CI 只做 Node 版本矩阵的锁定安装、自检及单元测试，**不会部署**。

## 费用口径与刷新验收

- 面板和命令中的金额均为按当前安装的 pi-ai DeepSeek 目录计算的估算，不能当作实际账单。
  目录升级会改变历史估算；未定价模型保留 Token 统计，未知费用不计入合计，不代表免费。
- `/usage` 每次等待本次聚合，或共享同区间已经运行的任务。它仍复用会话缓存，
  并不能补足宿主尚未写入或尚未恢复的事件。命令可能需要等待一次冷读取。
- HTTP 普通请求沿用快照和后台刷新。面板等待结果时用 `poll=1`，避免已有快照
  因 `ttlMs=0` 被反复重新计算。稳定状态的检查间隔按 `ttlMs` 限制在 30 秒至 1 小时，
  只在页面可见时运行；重新可见时检查，卸载时停止请求、计时器和监听器。
- 无旧报告的后台失败返回 503；有旧报告时保留其 `asOf`，返回 `refreshError` 和
  `refreshing: false`。界面提示失败并停止自动重试，刷新/重试按钮使用 `force=1`。
  用户可见异常采用固定文案，不回显宿主路径、原始异常或敏感上下文。
- 在隔离测试宿主中验收首次加载、同区间并发请求、旧快照更新、冷/热失败与重试、
  `ttlMs=0`、页面隐藏/恢复、切换日期和卸载；测试不能指向实际 DSH 数据目录。
  合成测试通过不等于真实 DSH 已完成端到端验收。

## 部署与升级

以下是维护流程，不表示本次审核已部署或授权重启线上宿主。

1. 记录当前插件提交、DSH 和 pi-ai 版本、安装位置、profile 中插件条目及验收基准。
   确认真实主机、数据根目录、维护窗口和恢复人；不能仅凭隔离 shell 的同名目录判断真实文件。
2. 在项目外受保护的位置保留当前插件版本、实际 profile patch 和依赖版本信息。
   原始会话由宿主的完整备份流程保护；一致性备份前按宿主要求停写或停机。
   不覆盖既有备份，也不把凭据、会话或备份打进 npm 包。
3. 在独立 checkout 检出已审核提交，完成上述验证；需要检查包内容时运行
   `npm pack --dry-run --ignore-scripts`。私有 GitHub 仓库不等于同名 npm 包归自己所有，
   不执行 `npm publish`，也不盲装公共 registry 的同名包。
4. 获准部署后，将审核过的插件文件放到目标 profile 的 `plugins/dsh-usage-report/`，
   确保 peer 能向上解析到宿主的共享 `node_modules`。不要直接覆盖整个 profile 或在运行目录执行 `git pull`。
5. 按样例仅合并所需的 `insert` 条目，保留其他配置；已有相同 `id` 时检查原条目，不重复插入。
   新增插件条目需要在获准的维护窗口重启 DSH，代码更新也应通过重启确认实际加载版本。
6. 验收 `/usage`、`/usage 7`、设置页面板，以及已认证的当前宿主上的相对路由
   `/api/usage.report?days=7`。冷启动允许先 `refreshing: true`，随后应有 `asOf`、`total`、
   `scan`；非法 `days` 应返回 400。检查未定价模型、读取失败计数和币种提示，
   不把真实响应或对话日志附到提交、issue 或报告。
7. 验证缓存位于项目外；在获准重启后比较同一自然日窗口和原始 token 桶。
   价格来自当前目录，升级 pi-ai 后金额可能变化，应区分 token 正确性与价格变化。

### Windows 一键同步脚本

本机已安装路径副本的更新入口为根目录 `update.cmd`，或：

```powershell
pwsh -NoProfile -File .\scripts\sync-deploy.ps1
```

要求 Windows、PowerShell 7.2+、Node 20+、Git 和 npm；不要求安装或登录 GitHub CLI。
本机代码回滚不联网查询 GitHub，也不要求源码工作区干净，以便断网或开发途中仍可恢复。
脚本只接受本仓库的无凭据 origin 地址，不查询 GitHub 可见性或调用 GitHub API。
公开仓库可用 HTTPS 匿名拉取；使用 SSH 时仍需正常配置 Git 的 SSH 认证。
Git 拉取失败会停止更新。维护者在发布代码前仍须单独核实可见性与发布意图。
源码必须干净，当前分支必须跟踪 origin；拉取只允许快进，默认要求与上游提交一致，未推送的本地提交
要先审核推送，或明确使用 `-NoPull`。绝不自动切分支、stash、reset 或合并冲突。
没有自动选择“最新发布版”：所部署的就是当前跟踪分支拉取后的提交，分支本身应由维护者审核。

更新前会运行锁定依赖安装、自检和全部测试。测试的 `DSH_HOME`、`TEMP`、`TMP` 放进项目外新建的
一次性目录，结束后还原环境并清理该目录，不指向真实缓存。安装位置由 `DSH_HOME` 或用户的 `.dsh`
目录与 `-Profile web` 决定；必须先有完整 `.deployment.json`，旧安装无此记录时人工核验并登记，
不要伪造记录来跳过保护。

仅替换明确列出的 12 个插件文件与版本记录，不同步整个 checkout、`.git`、`node_modules`、配置、
日志、会话或凭据。不写 profile patch，也不做首次安装。发现额外文件、被改过的插件、链接目录、
新增但尚未纳入部署清单的运行文件时停止；不能把安装目录当作可随意删除的构建产物。

每次部署在项目外创建仅当前 Windows 用户可访问的版本目录，候选文件先逐项校验，再通过目录
重命名替换。备份保留完整上一版插件与哈希记录，不包含 profile 配置、凭据、会话或数据缓存；
不会自动清理旧备份。备份目录必须与 DSH 安装在同一卷，且不得位于源码或 DSH 数据目录内。
`-BackupRoot` 可指定其他受保护位置；脚本拒绝已有或带链接的备份路径。
导入检查失败会恢复上一版；启动失败会尝试恢复代码并启动原来的 Web 命令，无法确认恢复时明确报错，
保留两个版本供人工处理。用户应记录每次输出的部署编号及其回滚命令。

默认仅重启当前用户通常运行的 `node <已存在的 @deepseek-ai/dsh/lib/bin.js> web` 实例，
要求指定端口（默认 3080）由当前 Windows 用户的一个进程仅在回环地址监听，命令不带额外参数，
且 home/profile 为默认值。
脚本复查进程创建时间和完整命令后才停止该进程；后台启动同一 Node、同一 DSH 入口，工作目录为
源码 checkout，不下载或升级宿主。先结束活动任务再更新，不对桌面版、自定义启动参数或公网服务
尝试猜测重启方式。宿主输出被丢弃，避免把浏览器登录链接和原始诊断写入日志；原来的持久签名凭据
和浏览器 Cookie 保留，启动探测接受根页面 200 或未认证的 401，这只证明 HTTP 已启动，
不等于用量路由已完成端到端验收。最后仍应在已登录浏览器检查用量面板及刷新。

常用参数：

```powershell
# 只核验源码状态和当前安装文件；不拉取、不安装依赖、不替换、不重启
pwsh -NoProfile -File .\scripts\sync-deploy.ps1 -CheckOnly

# 已手动拉取并审核的本地提交；仍运行测试和部署检查
pwsh -NoProfile -File .\scripts\sync-deploy.ps1 -NoPull

# DSH 已完全退出时只更新文件，随后自行按原方式启动
pwsh -NoProfile -File .\scripts\sync-deploy.ps1 -NoRestart

# 恢复某次部署前的插件；将编号替换为实际输出，配置继续保留当前内容
pwsh -NoProfile -File .\scripts\sync-deploy.ps1 -Rollback 20261017T010000-00000000
```

`-Profile`、`-DshHome` 可指向自定义安装，但需先退出宿主并加 `-NoRestart`。
`-Port` 仅用于识别和探测已有监听者，不改宿主端口。源码已有提交但文件与安装完全一致时直接结束，
不会重复备份或重启。回滚只接受与当前安装版本匹配的备份；不跨过后续部署强行覆盖，也不恢复旧配置。

## 回滚与恢复

- **代码回滚：**在新的 checkout 检出已记录的上一可用提交，运行锁定安装和验证，
  再在获准维护窗口恢复上一插件版本与其配置条目、重启宿主并重复验收。
  不对有未提交修改的目录使用 `reset --hard`，不重写 Git 历史。
- **配置恢复：**从项目外受保护备份中核对并恢复目标插件条目；不要用旧的整份 profile
  覆盖后来更新的其他插件、凭据或业务配置。恢复权限后再验证宿主实际加载的文件。
- **缓存故障：**先核实精确的插件缓存路径、停用相关写入，并保留原文件的受保护副本。
  只有在明确允许时才隔离该单个缓存文件，再由原始会话重建；禁止删除整个 `cache/`、
  `storages/` 或 DSH home。文件损坏或版本不匹配时，插件本身会按空缓存处理。
- **原始数据丢失：**插件缓存、图片和 Git 源码都不能恢复完整会话。停止清理，
  交由宿主数据备份流程恢复；恢复前先验证备份时间、完整性、版本和权限。

没有完成真实主机上的恢复演练前，只能称为恢复流程说明，不能称为已验证可恢复。

## 清理与提交前检查

只清理能明确重建、已确认属于本项目的临时文件和构建产物。项目没有 build 输出，
`lib/client.js` 与两张被 README 引用的 PNG 均有用途。`.gitignore` 是防误提交规则，
不授权删除已忽略的数据；对用途不明的文件、备份、数据库或生产配置停止处理并报告。

提交前先更新本地远端分支、标签和可访问的 PR refs，确认不是 shallow clone，再扫描：

```sh
gitleaks git . --log-opts="--all --full-history --reflog" --redact=100
gitleaks dir . --redact=100
gitleaks git . --pre-commit --staged --redact=100
git diff --check
git diff --cached --stat
git diff --cached --name-status
gh repo view Yac836/dsh-usage-report --json isPrivate,visibility,url
```

在秘密扫描通过前，不直接打印完整 diff、配置或匹配内容。扫描报告只能保留规则、文件、
行号、提交标识和脱敏结果；扫描器结果还要补充检查提交消息、个人信息、日志、公网地址、
文档图片和二进制附件。正常 Git 作者身份属于提交元数据，不能据此宣称历史完全没有个人信息。

`gitleaks git` 只覆盖已获取的 Git 对象；已删除且远端不再提供的 refs、GitHub Actions
日志/产物、release 附件、其他机器的工作目录和线上数据不在该证明范围内。
扫描通过也不能证明不存在任何未知形式的秘密。

本仓库有意公开。若确认真实凭据曾进入历史、可见性出现非预期变化、需要重写历史或轮换生产凭据，
立即停止整理、提交和推送，报告位置与类别并由所有者决定后续。不得通过删掉当前文件、
只更新 `.gitignore` 或添加扫描忽略规则来掩盖历史暴露。没有这些阻断项时，逐项复核暂存区，
再次确认 GitHub 可见性与发布意图后才提交及推送，并记录提交与远端 SHA。

删除当前文件、对当前截图打码，都不会清除 Git 历史中的原始版本；提交者姓名及邮箱也属于
公开历史的一部分。发布前应单独复核文档、截图、提交元数据的公开范围。需要清理历史时先报告
给所有者并取得明确批准，不自动重写或强推；已经被克隆或缓存的副本也不会随历史重写自动消失。
