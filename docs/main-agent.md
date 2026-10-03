# 主 Agent 任务骨架（开发模式）

范围：需求草稿、澄清、任务版本、状态转换、ShoppingStub、内存仓储和独立 `/agent`。不引用或调用现有 Shopping A/B，不创建购买、授权、订单或支付。没有 GLM / DeepSeek 请求、端点、model ID、工具格式或密钥配置；表单不是模型回复。

## 文件与边界

| 文件 | 职责 |
| --- | --- |
| `services/main-agent/types.ts` | 主 Agent 专属草稿、意图、状态、任务、事件；引用共享 Requirement |
| `services/main-agent/requirement-interpreter.ts` | RequirementInterpreter、开发输入适配器、运行时草稿校验和完整性判断 |
| `services/main-agent/orchestrator.ts` | MainTaskOrchestrator；版本、允许的转换、快照、超时、重试、结果校验与拒绝 |
| `services/main-agent/shopping-port.ts` | ShoppingPort 输入/输出契约和 ShoppingStub；与 MainTask 类型分离 |
| `services/main-agent/task-repository.ts` | TaskRepository 与单进程 MemoryTaskRepository |
| `services/main-agent/http.ts`、`runtime.ts` | 请求校验、同源约束、服务端演示会话、所有权、依赖装配 |
| `app/api/agent/**/route.ts` | 五个 HTTP 路由；GET 只读 |
| `app/agent/page.tsx`、`components/agent-debug.tsx` | 使用现有 Button/Input/Card 的独立调试页面 |
| `tests/main-agent.test.mjs` | A–F、竞争、故障、幂等、所有权与边界测试 |

未改共享类型、Shopping 实现、现有首页、依赖清单或锁文件。

## 启动和操作

在仓库根目录运行：

```sh
npm ci
npm run dev -- --hostname 127.0.0.1 --webpack
```

访问 `http://127.0.0.1:3000/agent`：

1. 点击「开始新任务」，服务端设置 HttpOnly / SameSite=Strict 演示会话。无账户注册；仅本地开发。
2. 填写部分字段并「保存需求并校验」，页面显示缺失字段与澄清问题；不能运行搜索。
3. 明确选择比较或购买，填写类别、商品和规格、HKD、预算港仙和口径、数量、配送地区。
4. 保存完整需求后为 `ready_to_search`，点击「运行 ShoppingStub」，查看结果与事件。
5. 编辑预算/商品后再保存，版本增加，旧方案立即清空。搜索中也能保存新需求并重新运行。
6. 「重发上次请求」复用相同 requestId，用于验证去重；正常保存/运行使用新 requestId。失败搜索可点击运行发起一次新的有限重试。

购买意图也止于 `result_ready`，页面固定说明「购买执行尚未接入」，没有下单按钮。表单不解析自然语言；商品名称和规格作为用户输入保存，尚无化妆品规格语义校验。未知事实由 Stub 保持未知，不声称精确 SKU 已核验。

场景在服务端启动时选择，改动后重启 dev 进程：

```sh
MAIN_AGENT_STUB_SCENARIO=delayed npm run dev -- --hostname 127.0.0.1 --webpack
```

支持 `plan`（默认）、`no_match`、`needs_verification`、`failure`、`timeout`、`delayed`。`delayed` 等待 1500ms，可在返回前修改需求。`timeout` 超过每次调用 3000ms 上限；默认最多重试 1 次，即最多 2 次调用。构造器仅允许 0–2 次重试。场景不是请求字段，也不能通过 query、表单、模型或商品内容改变。调试 API 仅 NODE_ENV=development 开放；production 返回 404，不用于线上服务。

## 接口与样例

`RequirementInterpreter.interpret({userMessage, currentDraft, context, developmentInput?}, signal)` 返回：

```json
{
  "intent": "unclear",
  "requirementDraft": { "query": "粉底" },
  "missingFields": ["intent", "category", "currency", "budget.maxMinor", "budget.scope", "quantity", "destination"],
  "clarificationQuestions": ["你希望比较方案，还是提出购买任务？本轮均不执行购买。", "……各缺失字段对应的问题"]
}
```

解释器没有状态写入接口；编排器重新验证 intent/draft，自行计算缺失信息，不信任解释器声称的完整性。预留消息和上下文参数；当前页面只用结构化表单，context 为空，未保存模型对话历史。未来模型密钥仅能来自服务端环境变量，具体协议待提供。

HTTP 均返回 `{task: MainTask}` 或 `{error:{code,message}}`，session 除外。写请求必须同源、application/json，最大 16KiB；不接受客户端 userId/status/scenario。所有任务调用绑定服务端会话，GET 不创建会话、不搜索、不重试。

| 路由 | 输入 |
| --- | --- |
| POST `/api/agent/session` | `{}`；建立演示会话，返回模式和存储说明 |
| POST `/api/agent/tasks` | `{ "requestId": "create_0001" }` |
| GET `/api/agent/tasks/:taskId` | 无请求体，返回当前快照；Cache-Control: no-store |
| POST `/api/agent/tasks/:taskId/requirements` | 下方需求完整替换请求（不是 patch） |
| POST `/api/agent/tasks/:taskId/search` | `{ "requestId": "search_0001", "expectedVersion": 1 }` |

```json
{
  "requestId": "save_0001",
  "expectedVersion": 0,
  "intent": "compare",
  "requirementDraft": {
    "category": "化妆品",
    "query": "指定品牌粉底 02色 30ml 正装",
    "currency": "HKD",
    "budget": { "maxMinor": 18000, "scope": "delivered" },
    "quantity": 1,
    "destination": "香港"
  }
}
```

草稿可以省略字段；空字符串/null 归一化为缺失。预算必须为正整数港仙，数量为 1–100 的整数。未填预算不会填 0 或默认值。首次有效修改由 v0 增至 v1；任何意图或归一化草稿的变化都会增版本，包括完整需求变回不完整。相同语义的重复保存不增加版本、不自动重搜。不同请求修改相同旧版本返回 409。

验证完整后才生成 canonical `Requirement`。没有指定的 hardConstraints/preferences/excludedProductIds 表示空集合，不制造商品事实。`ShoppingPort.search({requirement, quantity}, signal)` 的 requirement 带服务端 taskId/version。quantity 暂在外层，未冒充现有共享字段。

成功模拟返回示例（展示用商品名，价格未知）：

```json
{
  "taskId": "服务端任务ID",
  "requirementVersion": 1,
  "dataEnvironment": "development_mock",
  "status": "result_ready",
  "plan": {
    "title": "开发模拟方案：指定品牌粉底 02色 30ml 正装",
    "notice": "仅代表 Stub 流程成功；商品、价格、库存与配送均未核验，不可据此购买。",
    "priceMinor": { "value": null, "source": "mock-dataset", "fetchedAt": "2026-10-03T00:00:00.000Z", "status": "mock" }
  }
}
```

其余输出为 `no_match + reason`、`needs_verification + missingFacts`、`failed + error:{code,retryable}`。超时是 failed/TIMEOUT，来源故障为 failed/SOURCE_UNAVAILABLE。结果的 taskId/version 不匹配则拒绝，当前任务失败并记录 result_rejected；旧任务版本晚到则记录 stale_result_discarded，不改变新版本状态和结果。外部结果只投影允许的数据字段，文本在 React 中按文字渲染，不执行指令或 HTML。

TaskRepository 提供 `get`、`insert`、同步原子的 `update` 和 `once(key,fingerprint,operation)`。所有读写返回克隆；once 在异步调用前占用请求键，保留成功及失败结果，相同键不同内容返回 409。任务创建、需求修改、搜索全部使用 requestId；重发返回原请求结果快照，GET 返回最新任务。客户端按事件序号拒绝旧快照覆盖新快照。已经 shopping/result_ready 的同版本不会因另一 requestId 重复搜索。

内存实现仅用于开发：重启清空，热更新不保证存储代码升级兼容，没有多实例协调、清理配额或持久化恢复，不能用于授权、预算或支付去重。生产替换需要持久化事务、原子版本检查和请求去重记录，不能直接把 Map 换成无锁读写。

## 状态与验收

创建 → needs_clarification；完整保存 → ready_to_search；显式运行 → shopping → result_ready / needs_verification / no_match / failed。需求修改从任意状态进入 needs_clarification 或 ready_to_search。failed 可显式重试；其余结果需要修改需求后再运行。同版本重发不会继续推进任务。不存在购买或支付状态。

`npm test`：60/60（已有 39 + 新增 21）。覆盖：

| 场景 | 实际测试结果 |
| --- | --- |
| A 缺字段或 unclear | needs_clarification；Shopping 调用数 0 |
| B 完整 compare | result_ready；mock 方案；无交易对象 |
| C 完整 purchase | result_ready；保留 purchase 意图；执行未接入 |
| D 修改预算/商品 | 版本递增；旧结果无法覆盖新结果；完整变不完整清除结果 |
| E 无匹配/核验/失败/超时/延迟 | 分别返回对应状态；最多两次调用；超时触发 AbortSignal |
| F 重复请求 | 并发 create/save/search 去重；不同内容复用键拒绝；有意修改后可重新搜索 |
| 其他边界 | 不同任务/版本结果拒绝、会话隔离、只读查询、外部指令隔离、拒绝 verified 模拟事实、忽略迟到的已超时 Promise、解释器不能伪造完整性 |

浏览器实测已完成：创建空任务后显示澄清；填写 compare 后 v1 返回 result_ready；重发同一搜索请求没有新增调用事件；修改预算并切换 purchase 后增至 v2、清空旧结果；再次运行返回 mock 方案，页面显示「购买执行尚未接入；返回方案不代表已下单」。截图见 `agent-debug-acceptance.png`。页面表单保存后保留输入，方便继续修正。

本地文档按 AGENTS.md 阅读 Next 的 route/page/use-client/cookies 指引后实现。`npx next typegen` 生成初次缺少的 LayoutProps 等路由类型，再执行 `npx tsc --noEmit`。lint 和类型检查通过。

默认 `npm run build` 在此环境首先因 Google Fonts 网络限制失败；获准重试后遇到 Turbopack 内部端口绑定 EPERM。使用支持的 `npm run build -- --webpack` 已完成生产编译、类型检查和静态页生成。没有为通过构建修改既有字体、首页、构建脚本或校验。npm ci 报告原锁文件有 9 项 high 漏洞；本轮未升级依赖。

## 后续对齐（未实现）

- 模型组：确切 API 文档、base URL、model ID、结构化输出/工具协议；增加真实解释器、有限上下文和语义字段校验，仍不能直接设置状态或交易。
- Shopping 组：化妆品 category 枚举、品牌/系列/色号/容量/包装字段及其硬约束语义，query 暂为用户规格文本；不能把当前文本完整性理解为 SKU 核验。
- 数量是本轮接入 envelope 的字段。须约定共享 Requirement 是否扩展 quantity；预算对数量的总额/单件口径、运费计算和配送地区/期限语义需明确后才接真实 Shopping。
- 将 ShoppingWorkflowResult 的 ready/needsSearch/searchFailed/verificationLimit/noVerifiableFields 及 partial 映射到 ShoppingPort 异常/补问；不得把 Mock 或部分未知事实直接映射成已核验。
- 当前 ShoppingPortResult 仅支持 development_mock 和简化模拟方案。真实接入须扩展环境与方案结构并复用 Candidate/Fact/ShoppingWorkflowResult，不能把真实数据塞入此 mock 契约；真实商户、SKU、报价、证据、库存、配送和支付路线需要团队共同定稿。
- 不同模块必须原样返回 taskId/requirementVersion；AbortSignal、超时、有限重试和旧结果拒绝必须保留。
- 正式身份认证、持久化、授权、预算账本、购买执行、真实/沙盒支付均未接入，属于后续单独批准的阶段。
