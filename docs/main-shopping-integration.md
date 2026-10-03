# 远端 Shopping 与持久化主 Agent 集成

## 集成范围与隔离

本次基线为本地主链路 `9cbda3e` 与重新 fetch 核实的 `origin/main=c6cde7d3e2f64747a2f2cefafe5b7080c6146334`。远端与提供的 SHA 一致。远端新增范围为 `c466ca6`、`fe13e52`、`c838436`、`026d774`、`e008ede`、`6d0f47a`、`e15af40`、`1a9eeea`、合并提交 `78fd315`、数据提交 `c6cde7d`。

隔离工作树：`/Users/yuxili/Documents/ChatGPT/hacku/DeepSleep-shopping-integration`；Git common dir 为实际 `DeepSleep/.git`。专用分支 `feat/shopping-main-integration` 从9cbda3e建立，以真实merge保留双方提交。共享目录仍在 `feat/main-purchase-bridge`，app/shop、components/shop未跟踪文件未复制、覆盖或提交。未推送、合入main或部署。

未复制共享 .env.local，也不读取运行中支付数据库。测试数据库为临时目录；HTTP验收数据库在隔离工作树 `.data/sandbox-purchase.sqlite`，与原目录同名文件无关联。未发起支付。Stripe依赖、Node >=24.13.0保留；锁文件最终与本地主链路语义一致。以Node24官方类型替代远端临时node:sqlite声明，不关闭类型检查。

## 适配文件

- `services/main-agent/shopping-adapter.ts`：Requirement → StructuredSearchInput；词表溯源；服务端policy；调用新版createShoppingAgent.runShoppingTask。
- `services/main-agent/shopping-result.ts`：新版结果、嵌套Fact、审核、推荐、身份及决策快照运行时校验。
- `services/main-agent/shopping-port.ts`：保留旧Stub联合类型，增加带kind的完整契约结果。
- `services/main-agent/orchestrator.ts` / `types.ts`：接收完整结果；需求变化归档最近10份旧结果；保留去重、版本与原状态机。
- `services/main-agent/runtime.ts`：默认真实Watsons快照+确定性评分；显式服务端配置可选Stub或LLM评分。
- `services/product-search.ts`、`services/shopping-agent.ts`、`lib/agent-b/workflow.ts`：传递同一取消链，取消后停止排队评分；不改排序公式。
- `lib/agent-b/contract.ts` / `types/index.ts`：服务端词语别名、宽类别未知判定，以及仅搜索模式的缺商户配置待核验。默认旧B策略行为兼容。
- `components/agent-debug.tsx`：修正原固定Stub文字；已有JSON展示完整候选、证据和状态。未改/shop。
- `tests/main-shopping-integration.test.mjs`：10项主链路/真实快照/受控模型集成验收。

远端删除的25项旧search-agent/shopping-agent测试保留原断言，改为加载 `tests/legacy` 中冻结的测试专用实现与旧数据。这些只用于旧兼容回归，生产运行时不引用；新链路全部使用新版Shopping契约，不调用旧evaluateCandidates入口。所有旧主Agent和支付测试及远端新增测试一起运行。

## 请求语义与英文转换

主Agent保存的Requirement始终不变，taskId、requirementVersion原样传递。服务直接调用，不访问自身HTTP：

```ts
createShoppingAgent(dependencies, serverPolicy, limits)
  .runShoppingTask({ requirement, quantity, searchInput }, { signal })
```

容量gte/lte/eq合并为volumeMl范围，硬条件must=1；每个偏好条件组must=0，原始权重仍在Requirement供B评分。text.searchable containsAny/notContainsAny分别映射include/exclude关键词组（组内OR），不把软偏好变硬条件。不能安全转换的品牌、色号、包装、截止时间等继续留在原Requirement交B审核，不静默删除。排除productId同样由B审核。

不从整单预算生成单价上限：件数、折扣和配送语义不允许一般化安全除法。B按本次quantity、discount、shipping、otherFees及quote.totalMinor检查预算。

词表 `en-hk-v1` 仅做明确等价的检索别名：乳液→lotion/emulsion，爽肤水→toner，精华→serum，面霜→face cream/facial cream，保湿→moisturizing/moisturising/hydrating，香精→fragrance/parfum。保留中文原词，返回translation.originalQuery、originalCategory和逐条mappings。品牌不猜译；未知中文品名保留并警告未有已审阅英文映射，不扩大到其他商品。

英文Lotion可能出现在Toner标题中，不能据词面确定乳液。B拒绝明确不同类别；Moisturizer和Face Treatment是较宽类别，不能证明具体乳液，返回category unknown而非match。不会把宽类目统一别名成乳液。

## 服务端策略与时间预算

默认policy：verified_sources、空可信商户白名单、无价格基准；offer TTL 5分钟、静态事实TTL 24小时。`searchOnly:true`允许先展示候选，但缺白名单/商户事实时不能产生已确认推荐；有候选且没有明确硬违反时保持needs_verification。其他既有B调用默认仍要求完整服务端配置。

policy新增可选textAliases/broadCategories/searchOnly均为服务器代码配置，主Agent HTTP不接受浏览器传policy、事实环境、白名单、TTL、useLlm或关键词词表。

搜索全链路由主Agent20秒总上限控制，无外层自动重试；B每次调用最多19秒、最多1轮补查，受同一父signal剩余时间约束；A数据源最多4秒、每候选评分最多5秒、并发2。取消传播到Watsons读取循环、评分fetch及B补查；终止后不启动排队候选或新重试。单候选评分失败可按原规则降级；整个父任务取消则停止。自然语言解释仍使用原独立60秒上限，它结束后才进入上述搜索预算。

运行配置：

- 默认Watsons + 确定性评分，无须密钥。
- `MAIN_AGENT_SHOPPING_MODE=stub`显式选择原Stub，原MAIN_AGENT_STUB_SCENARIO仍有效。
- `SHOPPING_SCORING_MODE=llm`启用Shopping评分，并要求LLM_API_URL（完整chat/completions路径）、LLM_MODEL、LLM_API_KEY同时存在；不继承主Agent硬编码的BigBig端点/模型，不猜测API路径。
- 禁止为联调复制生产/共享支付配置；隔离服务可用3002端口。

实际仅检查配置存在性：LLM_API_KEY存在，LLM_API_URL与LLM_MODEL缺失。未调用真实Shopping评分模型，未输出密钥、未覆盖配置。评分协议/取消已用真实scorer类+可控HTTP替身验证，明确不属于真实服务商验收。

## 前端接口与结果

现有 `/api/agent/session`、`/tasks`、`/messages`、`/tasks/:id/requirements`、`/tasks/:id/search`、`GET /tasks/:id`保持兼容。浏览器继续提交requestId、expectedVersion和需求，不提交Shopping policy。

新结果在 `task.shoppingResult`，判别 `kind="shopping_contract_v1"`；旧任务/Stub没有此kind，继续按旧联合类型读取。新结果完整保留：

- candidates、recommendations、plan、reason、missingFacts、error；
- diagnostics.searchStatus/candidateChecks/filterLogs/verificationRequests/warnings/nextAction；
- decisionRecord（原需求及数量、候选事实快照、审核、selected）；
- verificationRounds、stopReason，以及A的search排名与评分证据；
- 实际searchInput和translation溯源。

未知/过期事实使用null或unknown，Fact只允许verified/unverified/mock，mock-dataset不能标verified。verified_sources仅说明使用真实可追溯来源，不表示所有事实已核验或新鲜。展示itemPriceMinor时必须同时展示source和fetchedAt；Watsons快照销售价不是即时结账价。模型debug载荷和支付上下文不进入本结果。

需求变化清空当前结果并写入task.shoppingHistory（最近10份；版本和归档时间），保留必要事件。旧持久化任务不要求新增字段，数据库无删除/覆盖迁移。顶层、A结果和decisionRecord的task/version一致性均检查，旧结果不得替换新版本。

HTTP实测任务 `a024d02d-d339-4d77-9fb8-32eddc4a2be0`：隔离3002端口会话创建→保存比较需求→真实Watsons搜索→GET读取同一decisionId，返回needs_verification、10个候选。没有访问沙盒execute。

## 实际输入输出及对话

见 `main-shopping-acceptance.json`：真实快照结果摘要、实际HTTP结果，以及受控模型解释器驱动的中文多轮记录。完整运行时结果保存在隔离工作树 `.data/watsons-result.json`。

示例实际A输入：

```json
{"taskId":"integration-main","requirementVersion":1,"useLlm":false,
 "product_name":{"value":"lotion","aliases":["乳液","emulsion"],"must":1},
 "range_conditions":[{"field":"volumeMl","min":100,"max":300,"must":1}],
 "include_keywords":[{"keywords":["保湿","moisturizing","moisturising","hydrating"],"must":0,"scope":"all"}],
 "exclude_keywords":[]}
```

真实快照：10候选，status=needs_verification，searchStatus=partial，stopReason=no_progress，recommendations为空。缺失/过期事实包括category、报价数量/目的地、运费、优惠、整单金额、可配送、库存、merchant.platformId及部分搜索文本。显示单价仍可展示采集时间，但不能据此扣款。示例候选包括 iskinclock Moist Lock Emulsion 150ml、1025 DOKDO LOTION 200ML；Toner分类候选有明确拒绝明细。

受控模型解释+真实快照多轮（不是实际模型服务）：

1.「比较乳液」→v1，needs_clarification，只询问预算/币种/数量/配送等缺失项，不搜索。
2.「1件，100到300ml，总预算200港币含运费，配送香港，希望保湿。」→v2，10候选，needs_verification；预算20000港仙，保湿must=0。
3.「容量改成200到300ml，预算改成180，排除含香精的商品。」→v3，7候选，needs_verification；容量范围更新、预算18000、exclude关键词组must=1；v2决策归档。

完整模拟报价测试通过真实A→新版B→受控mock事实补查，result_ready，金额18000，推荐evidenceStatus=mock；它不是Watsons支付方案。

## 购买边界

Watsons结果不会进入PurchaseBridge。原沙盒source只接受明确的虚拟「沙盒测试乳液 / 测试乳液 200ml」任务；其他商品拒绝。未改正式风控、未创建真实/沙盒付款、未将推荐或B预检查当授权、未替换固定测试商品。

## 最终验证

- `npm test`：200 项通过，覆盖主 Agent、旧调用兼容、新 Shopping、购买桥接及支付替身测试；未发起 Stripe 付款。
- `npm run lint`、`npx tsc --noEmit`：通过。新版 Agent B 已解决此前 TS2366，本轮不再将它列为既有阻塞。
- `npm run build`：默认 Turbopack 先遇 Google Fonts 网络限制，允许联网后仍因构建子进程端口绑定权限（EPERM）失败。
- `npx next build --webpack`：完整生产构建通过，包括编译、TypeScript、页面生成及追踪；未关闭类型检查或忽略构建错误。
- Shopping 的真实 LLM 评分未验收：现有本地配置只有 LLM_API_KEY，缺少其专用 LLM_API_URL 和 LLM_MODEL。本轮仅通过可控评分请求验证协议和取消传播，没有复制密钥或更改配置。
- 原共享目录仍为 `feat/main-purchase-bridge` / `9cbda3e`，仅原有 `app/shop/`、`components/shop/` 未跟踪文件；隔离集成未改动共享目录、支付数据库或历史交易。
