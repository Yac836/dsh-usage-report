window.__ModuleLoader__.load({
	id: "dsh-usage-report",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * 用量设置面板的浏览器半。
		 *
		 * 这是构建产物的形态（`window.__ModuleLoader__.load({id, factory})`）：宿主原样服务
		 * 本文件，因此包装必须手写。工厂是懒执行的 —— 模块体在首次 import 时才运行。
		 *
		 * 只 require 平台静态表里的模块（react），其余一律自己实现，避免依赖未验证的
		 * 组件 props 契约。数据来自 host 半注册的 `GET api/usage.report`。
		 */
		const React = require("react");
		const h = React.createElement;

		const NS = "usageReport";
		/** 简体中文字典（键集的事实源）。 */
		const zh = {
			nav: "用量",
			title: "Token 用量与估算费用",
			subtitle: "按 provider 汇总全部会话的模型调用",
			"range.all": "全部",
			"range.today": "今天",
			"range.7": "近 7 天",
			"range.14": "近 14 天",
			"range.30": "近 30 天",
			"range.custom": "自定义",
			"range.from": "起始日期",
			"range.to": "结束日期",
			"note.asOf": "数据截至 {time}",
			"note.refreshing": "正在后台更新…",
			"note.refreshFailed": "刷新失败，当前显示上次成功的数据。点击刷新重试。",
			"error.refreshFailed": "刷新失败，请点击重试。",
			"card.cost": "估算总费用",
			"card.calls": "总调用",
			"card.tokens": "实际消耗 Tokens",
			"card.hitRate": "缓存命中率",
			"card.sessions": "{count} 个会话",
			"heatmap.title": "用量热力图",
			"heatmap.subtitle": "最近 {weeks} 周每日用量",
			"heatmap.less": "少",
			"heatmap.more": "多",
			"metric.tokens": "Tokens",
			"metric.calls": "请求",
			"metric.cost": "估算费用",
			"tab.providers": "供应商",
			"tab.models": "模型",
			refresh: "刷新",
			updated: "{time} 更新",
			"col.provider": "Provider",
			"col.calls": "调用",
			"col.input": "输入",
			"col.cacheRead": "缓存命中",
			"col.cacheWrite": "缓存写入",
			"col.output": "输出",
			"col.cost": "估算费用",
			total: "总计",
			byModel: "按 model 明细",
			"note.pricing": "估算：按当前 pi-ai 目录中的 DeepSeek 官方价，不等于实际账单；目录升级可能改变历史估算金额。",
			"note.conversion": "已按 1 USD = {rate} CNY 折算为人民币；未折算金额 ${usd}",
			"note.scan": "数据来源：投影 {projected} 个会话 · 扫描 {scanned} 个（复用缓存 {reused}）· 耗时 {ms} ms",
			"note.currencyFallback": "⚠️ 配置了 CNY 但未提供 cnyPerUsd，已回退为美元显示",
			"note.stats": "统计 {steps} 步 · {sessions} 个会话",
			"note.unpriced": "未定价模型费用未计入合计，并非免费，估算总额可能偏低：{models}",
			"note.unreadable": "{count} 个会话读取失败，已跳过",
			loading: "正在统计…",
			error: "统计失败：{message}",
			retry: "重试",
			empty: "该范围内没有已上报用量的模型调用。",
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			nav: "Usage",
			title: "Token usage & estimated cost",
			subtitle: "Per-provider totals across every session",
			"range.all": "All",
			"range.today": "Today",
			"range.7": "Last 7 days",
			"range.14": "Last 14 days",
			"range.30": "Last 30 days",
			"range.custom": "Custom",
			"range.from": "Start date",
			"range.to": "End date",
			"note.asOf": "Data as of {time}",
			"note.refreshing": "Refreshing in the background…",
			"note.refreshFailed": "Refresh failed. Showing the last successful report; click Refresh to retry.",
			"error.refreshFailed": "Refresh failed. Please retry.",
			"card.cost": "Estimated total cost",
			"card.calls": "Requests",
			"card.tokens": "Tokens consumed",
			"card.hitRate": "Cache hit rate",
			"card.sessions": "{count} sessions",
			"heatmap.title": "Usage heatmap",
			"heatmap.subtitle": "Daily usage over the last {weeks} weeks",
			"heatmap.less": "Less",
			"heatmap.more": "More",
			"metric.tokens": "Tokens",
			"metric.calls": "Requests",
			"metric.cost": "Estimated cost",
			"tab.providers": "Providers",
			"tab.models": "Models",
			refresh: "Refresh",
			updated: "Updated {time}",
			"col.provider": "Provider",
			"col.calls": "Calls",
			"col.input": "Input",
			"col.cacheRead": "Cache read",
			"col.cacheWrite": "Cache write",
			"col.output": "Output",
			"col.cost": "Estimated cost",
			total: "Total",
			byModel: "By model",
			"note.pricing": "Estimate using DeepSeek rates in the current pi-ai catalog, not your invoice. Catalog upgrades may change historical estimates.",
			"note.conversion": "Converted to CNY at 1 USD = {rate}; unconverted amount ${usd}",
			"note.scan": "Source: {projected} session(s) from projections · {scanned} scanned ({reused} cached) · {ms} ms",
			"note.currencyFallback": "⚠️ CNY requested without cnyPerUsd; showing USD instead",
			"note.stats": "{steps} steps · {sessions} sessions",
			"note.unpriced": "Unpriced model costs are excluded, not free; the estimated total may be understated: {models}",
			"note.unreadable": "{count} sessions could not be read and were skipped",
			loading: "Crunching…",
			error: "Failed: {message}",
			retry: "Retry",
			empty: "No reported model usage in this range.",
		};

		/** 预设区间。`days: 1` 即"今天"（窗口按本地自然日，含今天）。 */
		const PRESETS = [
			{ key: "range.all", range: { kind: "all" } },
			{ key: "range.today", range: { kind: "days", days: 1 } },
			{ key: "range.7", range: { kind: "days", days: 7 } },
			{ key: "range.14", range: { kind: "days", days: 14 } },
			{ key: "range.30", range: { kind: "days", days: 30 } },
		];

		/** 区间 → 查询串。自定义区间用 from/to（YYYY-MM-DD）。 */
		function rangeQuery(range) {
			if (range.kind === "days") return `?days=${range.days}`;
			if (range.kind === "custom") {
				const parts = [];
				if (range.from) parts.push(`from=${range.from}`);
				if (range.to) parts.push(`to=${range.to}`);
				return parts.length > 0 ? `?${parts.join("&")}` : "";
			}
			return "";
		}

		/** 区间是否等价（用于高亮当前预设）。 */
		const sameRange = (left, right) =>
			left.kind === right.kind &&
			left.days === right.days &&
			left.from === right.from &&
			left.to === right.to;

		const num = (value) => Number(value ?? 0).toLocaleString("en-US");
		const money = (value, symbol) => `${symbol || "$"}${Number(value ?? 0).toFixed(4)}`;

		/** 紧凑计数：32.5B / 1.2M / 343K。卡片与表格都用它，避免长数字撑破列宽。 */
		const compact = (value) => {
			const n = Number(value ?? 0);
			if (!Number.isFinite(n)) return "0";
			const abs = Math.abs(n);
			if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
			if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
			if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
			return String(Math.round(n));
		};

		/** 金额：卡片/表格用 2 位，悬浮 title 再给 6 位精确值。 */
		const amount = (value, symbol) => `${symbol || "$"}${Number(value ?? 0).toFixed(2)}`;
		const amountExact = (value, symbol) => `${symbol || "$"}${Number(value ?? 0).toFixed(6)}`;

		/**
		 * 缓存命中率 = 缓存命中 ÷（新增输入 + 缓存写入 + 缓存命中）。
		 * 分母为 0（没有上报任何输入）时返回 null，界面上显示"—"而不是硬凑一个 0%。
		 */
		const cacheHitRate = (bucket) => {
			const denominator =
				Number(bucket?.input ?? 0) + Number(bucket?.cacheWrite ?? 0) + Number(bucket?.cacheRead ?? 0);
			return denominator > 0 ? Number(bucket.cacheRead ?? 0) / denominator : null;
		};

		const pct = (ratio) => (ratio === null || ratio === undefined ? "—" : `${(ratio * 100).toFixed(1)}%`);

		const date = (ms) =>
			ms === null || ms === undefined ? "—" : new Date(ms).toLocaleDateString();

		const styles = {
			root: { maxWidth: "760px", display: "flex", flexDirection: "column", gap: "14px" },
			title: { margin: 0, fontSize: "15px", fontWeight: 600 },
			subtitle: { margin: "4px 0 0", fontSize: "12px", opacity: 0.65 },
			ranges: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center", flex: "1 1 auto" },
			// 区间行：刷新按钮与"数据截至"和区间同一行、靠右（cc-switch 的立即同步也是这个位置）
			rangeRow: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" },
			refreshSide: { marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" },
			custom: { display: "flex", gap: "6px", alignItems: "center" },
			dateInput: {
				font: "inherit",
				fontSize: "12px",
				padding: "4px 6px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
				background: "transparent",
				color: "inherit",
			},
			// 汇总卡片：大数字，一眼可读（对齐 cc-switch 用量页的布局）
			// 一行四张、每张自带分项。grid + border-box：窄面板下也不会参差换行
			// （之前 flex-wrap 之所以 3+1，是 content-box 下 140px 基宽还要再加 22px 内边距）。
			cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(126px, 1fr))", gap: "8px" },
			card: {
				boxSizing: "border-box",
				minWidth: 0,
				padding: "8px 10px",
				borderRadius: "10px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))",
				display: "flex",
				flexDirection: "column",
				gap: "2px",
			},
			cardLabel: {
				fontSize: "11px",
				opacity: 0.65,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
			},
			cardValue: { fontSize: "17px", fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" },
			cardSub: {
				fontSize: "10.5px",
				opacity: 0.6,
				fontVariantNumeric: "tabular-nums",
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
			},
			// 四个原始桶已并进各自的卡片，这里不再需要单独的明细行
			// 热力图：一格一天，颜色深浅表示用量；用 currentColor 保证跟随主题
			heatWrap: { overflowX: "auto", paddingBottom: "4px" },
			heatMonths: { display: "flex", fontSize: "10px", opacity: 0.6, marginBottom: "3px" },
			heatRow: { display: "flex", gap: "6px", alignItems: "center" },
			heatGrid: { display: "flex", gap: "3px" },
			heatColumn: { display: "flex", flexDirection: "column", gap: "3px" },
			heatCell: { width: "10px", height: "10px", borderRadius: "2px" },
			heatWeekday: { fontSize: "10px", opacity: 0.6, width: "18px", textAlign: "right" },
			legend: { display: "flex", gap: "4px", alignItems: "center", justifyContent: "flex-end", fontSize: "10px", opacity: 0.65 },
			tabs: { display: "flex", gap: "14px", borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))" },
			tab: {
				padding: "6px 2px",
				fontSize: "13px",
				cursor: "pointer",
				background: "transparent",
				border: "none",
				borderBottom: "2px solid transparent",
				color: "inherit",
				opacity: 0.6,
			},
			tabActive: { opacity: 1, borderBottomColor: "currentColor", fontWeight: 600 },
			toolbar: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
			notes: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", opacity: 0.65 },
			muted: { fontSize: "12px", opacity: 0.65 },
			cell: { padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" },
			cellLeft: { padding: "6px 10px", textAlign: "left", whiteSpace: "nowrap" },
			head: { padding: "6px 10px", textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" },
			headLeft: { padding: "6px 10px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" },
			totalRow: { borderTop: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))", fontWeight: 600 },
		};

		/** 范围切换按钮；只依赖最基础的样式，避免猜错组件契约。 */
		function RangeButton({ active, children, onClick }) {
			return h(
				"button",
				{
					type: "button",
					onClick,
					style: {
						padding: "4px 10px",
						fontSize: "12px",
						cursor: "pointer",
						borderRadius: "6px",
						border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
						background: active ? "var(--dsw-alias-bg-l2, rgba(128,128,128,.18))" : "transparent",
						color: "inherit",
						fontWeight: active ? 600 : 400,
					},
				},
				children,
			);
		}

		function UsageTable({ report, t }) {
			const symbol = (report.money && report.money.symbol) || "$";
			const head = [
				{ label: t("col.provider"), left: true },
				{ label: t("col.calls") },
				{ label: t("col.input") },
				{ label: t("col.cacheRead") },
				{ label: t("col.output") },
				{ label: t("col.cost") },
			];
			const row = (cells, key, isTotal) =>
				h(
					"tr",
					{ key, style: isTotal ? styles.totalRow : undefined },
					cells.map((cell, index) =>
						h(
							"td",
							{ key: index, style: index === 0 ? styles.cellLeft : styles.cell },
							cell,
						),
					),
				);
			return h(
				"table",
				{
					style: {
						borderCollapse: "collapse",
						fontSize: "13px",
						fontVariantNumeric: "tabular-nums",
						width: "100%",
					},
				},
				h(
					"thead",
					null,
					h(
						"tr",
						null,
						head.map((column) =>
							h(
								"th",
								{ key: column.label, style: column.left ? styles.headLeft : styles.head },
								column.label,
							),
						),
					),
				),
				h(
					"tbody",
					null,
					[
						...report.providers.map((provider) =>
							row(
								[
									provider.provider,
									num(provider.calls),
									num(provider.input),
									num(provider.cacheRead),
									num(provider.output),
									money(provider.cost, symbol),
								],
								provider.provider,
								false,
							),
						),
						row(
							[
								t("total"),
								num(report.total.calls),
								num(report.total.input),
								num(report.total.cacheRead),
								num(report.total.output),
								money(report.total.cost, symbol),
							],
							"__total",
							true,
						),
					],
				),
			);
		}

		function ModelTable({ report, t }) {
			const symbol = (report.money && report.money.symbol) || "$";
			return h(
				"table",
				{
					style: {
						borderCollapse: "collapse",
						fontSize: "12px",
						fontVariantNumeric: "tabular-nums",
						width: "100%",
					},
				},
				h(
					"tbody",
					null,
					report.models.map((model) =>
						h(
							"tr",
							{ key: `${model.provider}/${model.model}` },
							h("td", { style: styles.cellLeft }, `${model.provider}/${model.model}`),
							h("td", { style: styles.cell }, num(model.calls)),
							h("td", { style: styles.cell }, money(model.cost, symbol)),
						),
					),
				),
			);
		}

		/** 设置页的「用量」面板：自己拉数据、自己渲染。 */
		/** 热力图可切换的三张指标。 */
		const HEAT_METRICS = {
			tokens: (entry) => entry.input + entry.output + entry.cacheRead + entry.cacheWrite,
			calls: (entry) => entry.calls,
			cost: (entry) => entry.costUsd,
		};

		/** 顶部汇总卡片：一行四张，每张自带分项（不再单独占一行）。 */
		function SummaryCards({ t, report, symbol }) {
			const total = report.total ?? {};
			const actual =
				Number(total.input ?? 0) +
				Number(total.output ?? 0) +
				Number(total.cacheRead ?? 0) +
				Number(total.cacheWrite ?? 0);
			const cards = [
				{
					key: "cost",
					label: t("card.cost"),
					value: amount(total.cost, symbol),
					// 只有展示币种不是美元时才补一行原值，免得在美元下啰嗦
					sub: symbol === "$" ? undefined : `≈ $${Number(total.costUsd ?? 0).toFixed(2)}`,
					title: amountExact(total.cost, symbol),
				},
				{
					key: "calls",
					label: t("card.calls"),
					value: num(total.calls),
					sub: t("card.sessions", { count: num(report.sessions) }),
				},
				{
					key: "tokens",
					label: t("card.tokens"),
					value: compact(actual),
					sub: `${t("col.input")} ${compact(total.input)} · ${t("col.output")} ${compact(total.output)}`,
					title: num(actual),
				},
				{
					key: "hit",
					label: t("card.hitRate"),
					value: pct(cacheHitRate(total)),
					sub: `${t("col.cacheRead")} ${compact(total.cacheRead)} · ${t("col.cacheWrite")} ${compact(total.cacheWrite)}`,
				},
			];
			return h(
				"div",
				{ style: styles.cards },
				cards.map((card) =>
					h(
						"div",
						{ key: card.key, style: styles.card, title: card.title },
						h("span", { style: styles.cardLabel }, card.label),
						h("span", { style: styles.cardValue }, card.value),
						card.sub ? h("span", { style: styles.cardSub }, card.sub) : null,
					),
				),
			);
		}

		/**
		 * 用量热力图：每周一列、每天一格，颜色深浅表示用量
		 * （对齐 cc-switch 用量页的信息层级）。周数按数据量自适应，最少 4 周、最多 53 周。
		 * 纯 div 手写，不引入图表库。
		 */
		function Heatmap({ t, series, symbol, metric, onMetric }) {
			const [expanded, setExpanded] = React.useState(true);
			const model = React.useMemo(() => {
				const byDay = new Map((series ?? []).map((entry) => [entry.day, entry]));
				const pick = HEAT_METRICS[metric] ?? HEAT_METRICS.tokens;
				const now = new Date();
				const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
				// 以"本周一"为最后一列的起点
				const lastMonday = new Date(end.getTime() - ((end.getDay() + 6) % 7) * 86_400_000);
				// 周数自适应：从最早有数据的那一周算起，最少 4 周、最多 53 周。
				// 固定铺满 53 周会在只有几天数据时留下一屏空格子（序列是按天升序的）。
				const firstDay = (series ?? [])[0]?.day;
				let span = 53;
				if (firstDay) {
					const [year, month, date] = firstDay.split("-").map(Number);
					const firstAt = new Date(year, month - 1, date);
					const firstMonday = new Date(firstAt.getTime() - ((firstAt.getDay() + 6) % 7) * 86_400_000);
					span = Math.round((lastMonday.getTime() - firstMonday.getTime()) / (7 * 86_400_000)) + 1;
				}
				const weeks = Math.min(53, Math.max(4, span));
				const columns = [];
				let peak = 0;
				for (let back = weeks - 1; back >= 0; back -= 1) {
					const days = [];
					for (let row = 0; row < 7; row += 1) {
						const at = new Date(lastMonday.getTime() + (row - back * 7) * 86_400_000);
						if (at.getTime() > end.getTime()) {
							days.push(null);
							continue;
						}
						const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
						const entry = byDay.get(key);
						const value = entry ? pick(entry) : 0;
						if (value > peak) peak = value;
						// 悬浮数字必须在这里就把值算好：格子对象上没有 input/output，
						// 直接对格子调 HEAT_METRICS.tokens 会得到 NaN（曾经就错在这里）。
						days.push({
							key,
							value,
							at,
							calls: entry?.calls ?? 0,
							tokens: entry ? HEAT_METRICS.tokens(entry) : 0,
							cost: entry?.cost ?? 0,
							costUsd: entry?.costUsd ?? 0,
						});
					}
					columns.push(days);
				}
				return { columns, peak, weeks };
			}, [series, metric]);

			const levelOf = (value) => {
				if (!(value > 0) || !(model.peak > 0)) return 0;
				return Math.min(5, Math.max(1, Math.ceil((value / model.peak) * 5)));
			};
			const LEVEL_OPACITY = [0, 0.25, 0.45, 0.65, 0.82, 1];
			const cellStyle = (level) => ({
				...styles.heatCell,
				background:
					level === 0 ? "var(--dsw-alias-fill-l2, rgba(128,128,128,.13))" : "currentColor",
				opacity: level === 0 ? 1 : LEVEL_OPACITY[level],
			});
			// 金额用展示币种的 cost（costUsd 是美元原值，配 ¥ 符号会张冠李戴）
			const labelOf = (day) =>
				metric === "cost"
					? amount(day.cost, symbol)
					: metric === "calls"
						? num(day.calls)
						: compact(day.tokens);

			const summary = h(
				"div",
				{ style: styles.toolbar },
				h(
					"button",
					{ type: "button", style: { ...styles.tab, opacity: 1 }, onClick: () => setExpanded(!expanded) },
					`${t("heatmap.title")} ${expanded ? "▾" : "▸"}`,
				),
				h("span", { style: styles.muted }, t("heatmap.subtitle", { weeks: model.weeks })),
				...["tokens", "calls", "cost"].map((key) =>
					h(
						RangeButton,
						{ key, active: metric === key, onClick: () => onMetric(key) },
						t(`metric.${key}`),
					),
				),
			);
			if (!expanded) return h("div", null, summary);

			return h(
				"div",
				null,
				summary,
				h(
					"div",
					{ style: styles.heatWrap },
					h(
						"div",
						{ style: { ...styles.heatMonths, marginLeft: "24px" } },
						model.columns.map((days, index) => {
							const first = days.find((day) => day !== null);
							const before = index > 0 ? model.columns[index - 1].find((day) => day !== null) : null;
							const label =
								first && (!before || first.at.getMonth() !== before.at.getMonth())
									? `${first.at.getMonth() + 1}月`
									: "";
							return h("div", { key: index, style: { flex: "0 0 13px", width: "13px" } }, label);
						}),
					),
					h(
						"div",
						{ style: styles.heatRow },
						h(
							"div",
							{ style: styles.heatColumn },
							["一", "", "三", "", "五", "", "日"].map((label, index) =>
								h("div", { key: index, style: styles.heatWeekday }, label),
							),
						),
						h(
							"div",
							{ style: styles.heatGrid },
							model.columns.map((days, index) =>
								h(
									"div",
									{ key: index, style: styles.heatColumn },
									days.map((day, row) =>
										day === null
											? h("div", { key: row, style: { ...styles.heatCell, background: "transparent" } })
											: h("div", {
													key: row,
													style: cellStyle(levelOf(day.value)),
													title: `${day.key} · ${labelOf(day)}`,
												}),
									),
								),
							),
						),
					),
					h(
						"div",
						{ style: styles.legend },
						h("span", null, t("heatmap.less")),
						...[1, 2, 3, 4, 5].map((level) => h("span", { key: level, style: cellStyle(level) })),
						h("span", null, t("heatmap.more")),
					),
				),
			);
		}

		function UsageSection({ t }) {
			const [range, setRange] = React.useState({ kind: "all" });
			const [custom, setCustom] = React.useState({ from: "", to: "" });
			const [state, setState] = React.useState({ status: "loading" });
			const [nonce, setNonce] = React.useState(0);
			const [tab, setTab] = React.useState("providers");
			const [metric, setMetric] = React.useState("tokens");
			// 手动刷新用 ref 而不是 state：它只影响"本次请求"，
			// 不参与依赖数组，避免"刷新 → query 变化 → 再刷新"的自激循环。
			const forceRef = React.useRef(false);
			const query = rangeQuery(range);

			React.useEffect(() => {
				let cancelled = false;
				let timer;
				let requesting = false;
				const controller = new AbortController();
				const visible = () => document.visibilityState !== "hidden";
				const schedule = (delay, pollOnly) => {
					if (!cancelled && visible()) timer = setTimeout(() => void load(pollOnly), delay);
				};

				// 面板**不等**计算：后端有快照就直接给（可能略旧，带 asOf 时间戳），
				// 没有就先回 refreshing —— 冷启动那几秒因此不阻塞界面，稍后自动补上。
				const load = async (pollOnly = false) => {
					if (cancelled || requesting || !visible()) return;
					requesting = true;
					clearTimeout(timer);
					try {
						// 手动刷新时带 force=1：后端会立刻启动一次刷新（并把旧快照先返回），
						// 面板随后轮询拿到新结果 —— 而不是在这里干等几秒。
						const force = forceRef.current;
						forceRef.current = false;
						const search = new URLSearchParams(query);
						if (force) search.set("force", "1");
						else if (pollOnly) search.set("poll", "1");
						const suffix = search.toString() === "" ? "" : `?${search}`;
						// 应用自带路由是文档相对形式，因此这里用相对 URL。
						const response = await fetch(`api/usage.report${suffix}`, { signal: controller.signal });
						const body = await response.json().catch(() => null);
						if (!response.ok) throw new Error("Refresh failed");
						if (cancelled) return;
						if (!body || body.total === undefined) {
							if (!body || body.refreshing !== true) throw new Error("Invalid report");
							schedule(1500, true);
							return;
						}
						setState({ status: "ready", report: body, query, refreshError: Boolean(body.refreshError) });
						if (body.refreshError) return;
						if (body.refreshing === true) schedule(1500, true);
						else {
							const delay = Number.isFinite(body.refreshAfterMs) ? body.refreshAfterMs : 30_000;
							schedule(Math.min(3_600_000, Math.max(30_000, delay)), false);
						}
					} catch (error) {
						if (cancelled || (error && error.name === "AbortError")) return;
						setState((previous) => previous.status === "ready" && previous.query === query
							? { ...previous, report: { ...previous.report, refreshing: false }, refreshError: true }
							: { status: "error", query, message: t("error.refreshFailed") });
					} finally {
						requesting = false;
					}
				};

				const onVisibilityChange = () => {
					clearTimeout(timer);
					if (visible()) void load();
				};
				document.addEventListener("visibilitychange", onVisibilityChange);
				setState((previous) => previous.status === "ready" && previous.query === query
					? { ...previous, refreshError: false }
					: { status: "loading", query });
				void load();
				return () => {
					cancelled = true;
					controller.abort();
					if (timer !== undefined) clearTimeout(timer);
					document.removeEventListener("visibilitychange", onVisibilityChange);
				};
			}, [query, nonce]);
			const requestRefresh = () => {
				forceRef.current = true;
				setNonce((value) => value + 1);
			};

			const header = h(
				"div",
				null,
				h("h3", { style: styles.title }, t("title")),
				h("p", { style: styles.subtitle }, t("subtitle")),
			);

			const pickCustom = (next) => {
				setCustom(next);
				setRange({ kind: "custom", from: next.from, to: next.to });
			};

			const ranges = h(
				"div",
				{ style: styles.ranges },
				PRESETS.map((preset) =>
					h(
						RangeButton,
						{
							key: preset.key,
							active: sameRange(range, preset.range),
							onClick: () => setRange(preset.range),
						},
						t(preset.key),
					),
				),
				// 自定义区间：用原生日期选择器，零依赖、跨平台一致。
				// 只填起点＝从那天到今天；只填终点＝从最早到那天。
				h(
					"div",
					{ style: styles.custom },
					h(
						RangeButton,
						{
							active: range.kind === "custom",
							onClick: () => pickCustom(custom),
						},
						t("range.custom"),
					),
					// 日期框只在选中「自定义」时才出现。原来它常驻，永远占掉一整行，
					// 把区间按钮挤成两行参差 —— 这就是这块"不好看"的根源。
					range.kind === "custom"
						? [
								h("input", {
									key: "from",
									type: "date",
									value: custom.from,
									style: styles.dateInput,
									"aria-label": t("range.from"),
									onChange: (event) => pickCustom({ ...custom, from: event.target.value }),
								}),
								h("span", { key: "arrow", style: styles.muted }, "→"),
								h("input", {
									key: "to",
									type: "date",
									value: custom.to,
									style: styles.dateInput,
									"aria-label": t("range.to"),
									onChange: (event) => pickCustom({ ...custom, to: event.target.value }),
								}),
							]
						: null,
				),
			);

			if (state.status === "loading" || state.query !== query) {
				return h("div", { style: styles.root }, header, ranges, h("div", { style: styles.muted }, t("loading")));
			}
			if (state.status === "error") {
				return h(
					"div",
					{ style: styles.root },
					header,
					ranges,
					h("div", { style: styles.muted }, t("error", { message: state.message })),
					h(RangeButton, { active: false, onClick: requestRefresh }, t("retry")),
				);
			}

			const report = state.report;
			const refreshNode = h(
				"div",
				{ style: styles.refreshSide },
				h(RangeButton, { active: false, onClick: requestRefresh }, t("refresh")),
				report && report.asOf
					? h("span", { style: styles.muted }, report.refreshing
						? t("note.refreshing")
						: t("updated", { time: new Date(report.asOf).toLocaleTimeString() }))
					: null,
			);
			const refreshFailure = state.refreshError
				? h("div", { role: "alert", style: styles.notes }, t("note.refreshFailed"))
				: null;
			if (!report || report.steps === 0) {
				return h("div", { style: styles.root }, header, ranges, refreshNode, refreshFailure,
					h("div", { style: styles.muted }, t("empty")),
					report && report.unreadable > 0
						? h("div", { role: "alert", style: styles.notes }, t("note.unreadable", { count: num(report.unreadable) }))
						: null);
			}

			const reportRange = report.range ?? {};
			const span = `${date(reportRange.first)} → ${date(reportRange.last)}`;
			const notes = [];
			if (report.money && report.money.converts) {
				notes.push(
					t("note.conversion", {
						rate: report.money.cnyPerUsd,
						usd: Number(report.total.costUsd ?? 0).toFixed(4),
					}),
				);
			}
			notes.push(t("note.pricing"));
			if (report.asOf) {
				const time = new Date(report.asOf).toLocaleTimeString();
				notes.push(
					report.refreshing
						? `${t("note.asOf", { time })} · ${t("note.refreshing")}`
						: t("note.asOf", { time }),
				);
			}
			notes.push(
				`${t("note.stats", { steps: num(report.steps), sessions: num(report.sessions) })} · ${span}`,
			);
			if (report.scan) {
				notes.push(
					t("note.scan", {
						projected: num(report.scan.projected),
						scanned: num(report.scan.scanned),
						reused: num(report.scan.reused),
						ms: num(report.scan.elapsedMs),
					}),
				);
			}
			if (report.money && report.money.fellBack) notes.push(t("note.currencyFallback"));
			if (report.unreadable > 0) notes.push(t("note.unreadable", { count: num(report.unreadable) }));
			if (report.unpriced && report.unpriced.length > 0) {
				notes.push(t("note.unpriced", { models: report.unpriced.join(", ") }));
			}

			const symbol = (report.money && report.money.symbol) || "$";

			const tabs = h(
				"div",
				{ style: styles.tabs },
				[
					["providers", "tab.providers"],
					["models", "tab.models"],
				].map(([key, label]) =>
					h(
						"button",
						{
							key,
							type: "button",
							style: { ...styles.tab, ...(tab === key ? styles.tabActive : {}) },
							onClick: () => setTab(key),
						},
						t(label),
					),
				),
			);

			// 自上而下：区间/刷新 → 表格 → 汇总卡片 → 热力图 → 提示行。
			// 表格放最上是刻意的：日常最常看的是"哪个 provider 花了多少"，
			// 卡片与热力图更像"结论"和"长期形状"，放在明细之后更好读。
			return h(
				"div",
				{ style: styles.root },
				// 刷新与"数据截至"跟标题同一行、靠右（cc-switch 的立即同步也在标题右侧）。
				// 放在区间行里会挤到换行，孤零零另一行反而更难看。
				h("div", { style: styles.rangeRow }, header, refreshNode),
				ranges,
				refreshFailure,
				tabs,
				tab === "models" ? h(ModelTable, { report, t }) : h(UsageTable, { report, t }),
				h(SummaryCards, { t, report, symbol }),
				h(Heatmap, { t, series: report.series, symbol, metric, onMetric: setMetric }),
				h(
					"div",
					{ style: styles.notes },
					notes.map((note, index) => h("div", { key: index }, note)),
				),
			);
		}

		/** 需要的 Cordis 服务：slot 注册表与本地化。 */
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "usage-report: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "usage-report",
						order: 40,
						label: () => t("nav"),
						locale: NS,
					},
					UsageSection,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
