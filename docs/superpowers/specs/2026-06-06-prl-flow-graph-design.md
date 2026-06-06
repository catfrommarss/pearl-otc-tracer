# PRL 资金流追溯图 + SafeTrade 自由金额筛选 · 设计 spec

日期：2026-06-06
项目：pearl-otc-tracer（catfrommarss.github.io/pearl-otc-tracer，纯静态 GitHub Pages + 每小时 collector）

## Context（为什么做）

看板已能追溯 OTC「谁买谁卖」并恢复改版后地址、识别巨鲸/实体。用户想要一个**纯粹追溯 PRL 代币流向**的可视化页面，类似 Arkham：从一个地址出发，看资金进出对手方，点节点层层往外追。另外把巨鲸页的 SafeTrade 资金流改成**可自由设置金额**筛选。

关键前置（已实测）：**prlscan API（api.prlscan.com）返回 `Access-Control-Allow-Origin: *`**，浏览器可直接调用 → 资金流图可做成**纯客户端、实时展开、无后端、无预计算**。

## 已确认的设计决策

- **交互模式**：地址追溯（ego 展开）—— 不做全局总览大图。
- **节点粒度**：实体级（已知身份合并命名：SafeTrade / 桥 / 矿池 / @OTC 用户名；未知按地址）。
- **气泡大小**：∝ 链上余额（sqrt 缩放）。
- **渲染**：必须精致（专业图谱库，非手绘）——Cytoscape.js + fcose 力导向，暗色主题，曲线边、节点光晕、hover/拖拽/缩放。
- **数据源**：浏览器实时直连 prlscan（接受其不可用时图为空，但其它页用静态 JSON 不受影响）。
- **SafeTrade 阈值**：collector 发射阈值 = **10000 PRL**（只保留极大额）；前端可在此基础上往上自由筛。

## 架构

新增「资金流」tab → `#view-flow`；逻辑独立成 **`docs/flow.js`**（app.js 已大，新功能单独成文件）。Cytoscape.js + cytoscape-fcose 经 CDN 引入。

### 数据流（flow.js，全部浏览器侧）

1. **种子**：搜索框输入 `prl1地址` / `@用户名` / `txid`，或从 `#flow/<addr>` 进入。`@用户名` 经本地 identities/entities 反查表解析到地址；`txid` 经 `/v1/txs/{txid}` 取其主输出地址作种子。
2. **节点信息**：`GET /v1/addresses/{addr}` → balance_grains、label、label_kind、tx_count。
3. **展开一跳**：`GET /v1/addresses/{addr}/txs?limit=50`（必要时翻 cursor，封顶约 2 页）→ 对扫描到的交易（封顶约 25 笔/节点）`GET /v1/txs/{txid}` 解析 vin/vout。
4. **方向判定（UTXO 感知）**：焦点地址出现在 **inputs**=该笔它**转出**，outputs 中非焦点地址=收款对手方（红色 out 边）；焦点地址只在 **outputs**=它**收到**，inputs 的 prev_address=付款对手方（绿色 in 边）。**排除**：找零/自转（对手方属于同一实体）、coinbase。
5. **聚合**：同一对手实体的多笔合并为一条有向边，金额=value_grains 求和（grains/1e8=PRL）；边粗细 ∝ 金额。
6. **广度上限**：每次展开取**前 12 大对手方**（按金额），其余折叠为「+N 更多」（可再点加载）。
7. **缓存/限速**：已取 `/v1/txs` 结果存内存 Map 去重；`/v1/txs` 并发设小上限（~4）礼貌限速。

### 实体合并 + 命名

flow.js 启动时 `fetch` `data/entities.json`（address→{label,kind}）+ `data/identities.json`（address→{username,…}），建：
- `addr → entityId`（label / @username / 否则地址本身）
- `username → [addresses]`（搜索 @用户名用）

对手方地址按 `addr→entityId` 归并；同一实体的多个地址折成一个气泡，余额取实体名下地址余额之和（实时各查或仅取命中地址，详见实现取舍：v1 取「该地址」余额，命名沿用实体名，避免过多请求）。

### 视觉 / 交互

- 颜色：交易所黄(system/exchange) / 桥蓝(bridge) / 矿池紫(pool) / OTC 用户绿(pearl_otc) / 未知灰 / 焦点高亮描边。
- 气泡大小 = sqrt(balance) 映射到半径区间（设下限/上限防止过大过小）。
- 边：in 绿 / out 红，箭头有向，粗细按金额，hover 显示金额。
- 节点交互：单击=展开一跳（再点=折叠其新增子节点，可选）；hover=tooltip（名称/余额/与焦点净流向）；双击=跳 `#address/<addr>` 详情页；拖拽/滚轮缩放/「重置视图」按钮。
- 顶部：搜索框 + 图例 + 当前焦点 + loading 指示。
- 入口按钮「在资金流图查看」：巨鲸榜行、地址详情页头部 → `location.hash = 'flow/' + addr`。
- 路由：`#flow`（空态：搜索引导）/ `#flow/<addr>`（带种子）。app.js `route()` 增加 `flow` 分支调用 `window.renderFlow()`（flow.js 暴露）。

### SafeTrade 自由金额筛选

- **后端**：`collect.py` 调 `chain.safetrade_flows` 的阈值由 `1000 * GRAINS` 改 **`10000 * GRAINS`**；`safetrade.json` 仍按条数封顶（flows[:200]）。
- **前端**（巨鲸 tab 的 SafeTrade feed，app.js `renderWhales`）：加一个**金额输入框**（默认 10000，单位 PRL）+ 进/出（全部/转入/提现）切换；客户端实时过滤已加载 flows；`localStorage` 记住上次输入值。低于 10000 的输入无意义（数据本身≥10000），输入框提示「≥10000」。

## 容错

- 任一 prlscan 请求失败：toast「prlscan 暂时不可用」，保留已加载图；不抛未捕获异常。
- 节点无对手方：标为叶子（不可再展开提示）。
- 搜索解析不到：提示「未找到该地址/用户名/交易」。

## 改动文件

- `docs/index.html`：新增「资金流」tab + `#view-flow` 容器（cytoscape 挂载点、搜索框、图例、控件）；CDN 引入 cytoscape + fcose；缓存戳 bump。
- 新增 `docs/flow.js`：资金流图全部逻辑。
- `docs/style.css`：资金流页布局（满高画布、控件条、图例、tooltip）+ SafeTrade 金额输入控件样式。
- `docs/app.js`：`route()` 加 `flow` 分支；巨鲸榜/地址详情页加「在资金流图查看」按钮；`renderWhales` 的 SafeTrade feed 加金额过滤 UI。
- `collector/collect.py`：SafeTrade 阈值 10000 PRL。

## 验证

1. 本地 `python collector/collect.py` 重生成 safetrade.json（仅 ≥10000 PRL 流水），确认条数合理。
2. 本地预览：「资金流」tab 搜索一个已知巨鲸（如 @kg1234 或 prl1pf5af… unsupervised），确认图渲染、节点可点展开、实体命名/上色正确、边方向+金额正确、双击进详情、重置可用。
3. 巨鲸 tab：SafeTrade feed 金额框默认 10000、改大后实时过滤、进/出切换生效、刷新后记住值。
4. prlscan 故障演练：临时断网/改错 base，确认图优雅报错、其它 tab 正常。
5. CI：push 后 workflow 绿、Pages 部署、`#flow/<addr>` 深链可用。

## 不做（YAGNI）

全局总览大图、自动多跳追踪（仅手动点展开）、WebGL/sigma、EVM 侧资金流图、后端预计算图快照、图状态保存/分享（除 URL 种子外）。
