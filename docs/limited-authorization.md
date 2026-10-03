# 有限授权与确定性风控（仅沙盒）

基于集成提交 edaabc5；分支 feat/limited-authorization。未回退主链路，不改 Shopping、Watsons 映射或 /shop。五份 risk_control_*_v2 / database_schema_v2 文档按指定顺序读取；以下落地采用用户本轮约定优先。

## 与设计文档的差异及规则对应

文档采用 HKD 浮点示例、独立 orders 表、启动前签授权和多个支付渠道。本实现始终使用整数港仙、复用现有订单、搜索不要求授权，支持范围仅 sandbox-lotion / demo-merchant / stripe_test_card。演示会话不是正式身份认证，不实现法律责任分配。

| 文档规则 | 实现 | 边界 |
| --- | --- | --- |
| 第一类授权、R9、R10 | AuthorizationService 保存明确确认的授权版本；Gate 重读 active、生效/失效时间和范围 | now >= expiresAt 即失效；修改/撤销新增版本，保留历史；模型无创建授权工具 |
| R1-soft/hard | RiskPolicyEngine：预计月度金额 = 已支出 + 其他有效在途预占 + 本次总额 | 大于阈值才触发，等于允许；单笔授权不替代任务预算 |
| R2-soft/hard | 比较最终总额与单笔软硬限额 | 原 20000 港仙沙盒上限保留，授权单笔硬上限也不能超过此值 |
| R7 | 同一 owner，滚动十分钟内，有效预占/已支付或旧系统仍可能扣款的操作，加本次 > 3 则 block | 第四笔拦截，自己 operation 不重复计算；没有可点击越过的“本人确认” |
| R8 | 同一 owner，十分钟内其他有效操作的 productId + merchantId + totalMinor 相同则 block | 与 requestId/Stripe 幂等不同；重试同 operation 不命中自己 |
| R13 | 服务端测试商品 title 命中配置词库，辅助 block | 当前方案没有评论/原始详情字段；不声称词库完整识别提示注入，商品内容从不作为规则执行 |
| 第二类确认单 | ConfirmationService：仅 R1-soft / R2-soft 的 hold 合并生成一单 | 绑定用户、任务/需求版本、授权ID/版本、方案、完整报价、金额、规则；最长120秒 |
| R12 | 确定优先级 block > hold > approve；损坏/冲突的规则配置 fail-closed | 不把普通优先级差异当可确认冲突；配置错误 block，无软限额确认出口 |
| R16 的支付对象一致性 | 复用 PaymentSnapshot 金额/币种/订单关联校验，记录完整性拦截审计 | 不支持事后真实账单导入；不允许确认绕过支付对象不一致 |
| R3/R4/R18 的授权范围 | 执行前检查用户授权范围包含当前测试商品/商户/测试卡 | 不重做 Shopping 的商品筛选和排序，不声称其他支付渠道已接通 |
| R5/R11/R14 等搜索择优 | 沿用原 Shopping，未修改 | 不新增价格优化、商户评分等功能 |
| R15/R17 | 未实现 | 无退款、返现、争议、责任裁定或售后流程 |

规则参数在 services/risk-control/types.ts 的 RISK_CONFIG；额度来自持久化授权，不在 engine 中硬编码。decision 保存 policyVersion，授权所有历史版本可追溯。正式 production 执行仍拒绝，本实现不声明已具备正式风控/身份认证。

## 模块与迁移

- authorization.ts：创建、修改、撤销授权；严格范围/整数/软硬关系校验；expectedVersion 和 requestId 去重。
- engine.ts：确定性审核、聚合规则、确认绑定、预算预占与结算；只读取服务端方案、报价、任务和订单。
- confirmation.ts：明确接受/拒绝；接受前重读当前权威任务、授权及报价；不直接付款。
- gate.ts：LimitedExecutionGate，复用 SandboxExecutionGate 全部基础检查。
- repository.ts：附加 risk_* 表及审计；http.ts 和 /api/agent/risk/[action]：主会话归属、同源、请求白名单、大小限制。
- components/risk-debug.tsx、/agent-risk：独立授权/确认调试入口；金额输入显示 HKD 元。
- PurchaseExecutionService：保留支付适配器、订单、稳定幂等键、Webhook 验签与恢复，只增加 Gate 三态处理、原子提交检查及结算钩子。

首次使用 RiskRepository，在同一 SQLite 基础设施 CREATE TABLE IF NOT EXISTS：

| 表 | 用途 / 唯一约束 |
| --- | --- |
| risk_authorizations | 不可变授权版本，PRIMARY KEY(owner,version)；撤销是一份新版本 |
| risk_requests | 授权修改请求重试，PRIMARY KEY(owner,request_id)，相同ID不同内容拒绝 |
| risk_audit | 授权创建/修改/撤销、确认、完整性检查、过期未提交预占释放记录 |
| risk_decisions | 每次确定性检查的规则、原因、退出建议、统计、授权版本，decisionId 唯一 |
| risk_confirmations | confirmationId 唯一；UNIQUE(operation_id,binding)，同绑定不能重发延长有效期 |
| risk_reservations | operation_id 唯一且引用现有 sandbox_operations；金额、状态、月、首次预占及结算时间 |

不删除、改名或替换 main_* / sandbox_*；无第二套订单系统；旧支付 JSON 兼容。旧交易不回填授权，也不改归属。历史操作只在其原 owner 的额度统计中读取：成功记已支出、可能扣款记在途，不创建虚假 risk 授权。

## 统计与原子性

所有额度均为 HKD 港仙。月份使用 Asia/Hong_Kong（UTC+08:00）。本系统没有 Stripe 结算时间字段，新交易以服务端第一次确认支付成功的时间归属支出月份；旧成功记录用其已保存 confirmStartedAt（否则 createStartedAt）计算，不编造第三方结算时间。上月尚未确定的预占仍占用当前可用额度，直至核实，避免跨月绕过。

频率/重复窗口是 `(now - 600000, now]`，左开右闭。统计同一服务端会话 owner 的其他操作：reserved、spent，以及无 risk 记录但已经开始创建且非 failed/canceled 的历史操作。not_started 无预占、明确 failed/canceled 或 released 不计入；软限额 hold 尚未取得预占不计入。R7 再加本次一笔；R8 与其他商品/商户/金额三元组比较。同 operation 多次检查始终排除自身。

BEGIN IMMEDIATE 内重读 main_tasks、当前授权、报价和其他预占；approve 才插入/复用本 operation 预占。创建与确认付款分别在同一短事务中复核并标记提交开始；事务不跨网络 await。该提交标记是并发撤销与付款的顺序边界：先提交的操作继续核实，先撤销的后续提交被拒绝。

- succeeded：同一事务中 reserved 转 spent，成功吸收状态不回退；重复回调不重复累计。
- failed/canceled（已核实无扣款）：释放；不把一般异常叫 failed。
- 未发送创建、或已知 requires_confirmation 且从未提交确认而被阻止：可安全释放，后续再次执行必须重新检查并取得预占。
- unknown/creating/confirming/processing/requires_action：保留，使用原幂等键/PaymentIntent 核实，不新建替代付款。
- 崩溃留下的预占，只有 createStartedAt 为空且报价已过期，才在下一次风控写事务中释放；GET 不清理或触发付款。可能已提交的未知交易绝不按时间自动释放。
- 商户确认失败不改变 spent 或支付 succeeded；只恢复商户，不再次付款。

确认单期限 = min(创建时刻+120秒, 报价到期, 授权到期)。同 binding 过期或拒绝后不可自动续发。确认接口只登记同意、不预占、不付款；execute 再检查最新月度占用及全部 block。变化后的授权/报价/任务/软规则集合不复用旧确认。已接受的确认不会提高持续授权额度；超时默认拒绝。服务端执行检查是权威，页面计时仅展示。

## 前端接口

使用既有 `/api/agent/session` HttpOnly 演示 cookie；不接受 userId、客户端累计支出、approve/hold/block、支付凭证或执行金额。仅 development 开放。

| 接口 | 请求 | 行为 |
| --- | --- | --- |
| GET /api/agent/risk/state | 无 | 当前授权、最近100次决策/确认/审计、预占及已支持范围；只读 |
| POST /api/agent/risk/authorization | terms, expectedVersion, requestId, explicitlyConfirmed:true | 明确创建或修改；expectedVersion=0 表示首次 |
| POST /api/agent/risk/revoke | expectedVersion, requestId | 新版本 revoked；不退款、不删除旧交易 |
| POST /api/agent/risk/confirmation | confirmationId, accept:true/false | 仅确认/拒绝单次软限额；accept 不触发支付 |
| POST /api/agent/purchases/prepare | 原 taskId, expectedVersion, requestId | 仅准备和报价，不要求事先签购买授权 |
| POST /api/agent/purchases/execute | 原 taskId, planId, expectedVersion, requestId, testPermission:true | 风控 approve 才付款；testPermission 仍需明确，不代替有限授权 |
| GET /api/agent/purchases/state?taskId=… | 原任务ID | 原只读订单/支付记录，包括历史版本 |
| POST /api/agent/purchases/recover | 原 taskId, planId, requestId | 显式核对原支付，不新建或确认付款 |

授权请求示例（时间为示例，使用时须填写有效时间；金额是授权边界，不是支付金额）：

```json
{"requestId":"authorization-example-01","expectedVersion":0,"explicitlyConfirmed":true,
 "terms":{"startsAt":1791064800000,"expiresAt":1791151200000,
 "singleSoftMinor":10000,"singleHardMinor":20000,"monthlySoftMinor":30000,"monthlyHardMinor":40000,
 "productIds":["sandbox-lotion"],"merchantIds":["demo-merchant"],"paymentMethods":["stripe_test_card"]}}
```

响应为 `{authorization:{authorizationId,userId,version,status,...terms,createdAt}}`，归属由服务端决定。旧版本更新返回 STALE_AUTHORIZATION；同请求ID不同内容返回 REQUEST_CONFLICT。撤销/确认跨用户不可访问。

execute 仍返回原购买视图；暂停时 `operation.errorCode=RISK_HOLD/RISK_BLOCK`（基础错误如 STALE_VERSION 保留原码）。前端用 operationId 匹配 risk/state 的 decision，显示 hits 的 reason/exit。仅 hold 且 confirmationId 不为空时展示确认。确认示例：

```json
{"confirmationId":"<server-confirmation-id>","accept":true}
```

响应 `{confirmation,accepted,decision?}`；accepted=false 表示当前检查未允许该例外。随后执行原 planId/operation；不能把点击确认或 URL success 当成支付成功。完整实际 approve/hold/block 输出见 risk-control-acceptance.json（全部为可控支付替身）。

## 调试与旧入口

Node >=24.13，npm run dev，打开 /agent-risk 建立/读取当前会话，填写限额和有效期、明确勾选后保存。/agent 使用当前会话创建 purchase 任务：沙盒测试乳液 / 测试乳液 200ml / 1件 / HKD / 香港 / 预算200 HKD含运费。准备方案，明确一次测试许可后执行；若hold，回 /agent-risk 读取并确认具体交易，再执行原方案。compare/搜索无需授权。

原 `/api/sandbox-purchase/session|fixture|execute` 一律403 LEGACY_PAYMENT_DISABLED，不能成为绕过授权的浏览器入口。旧会话的只读状态/核对以及验签Webhook保留，历史 CLI 身份不转给浏览器。

scripts/check-stripe-sandbox.mjs 仅保留独立服务端支付诊断：--execute 必须显式指定 --diagnostic-db=<独立数据库路径>，拒绝主购买数据库及其符号/硬链接。诊断沿用 SandboxExecutionGate，只验证支付，不声称有限授权通过，不可用来替代本轮风险链路验收。不得用新诊断案例掩盖旧交易未知结果。本轮未运行此脚本付款。

## 本轮验证

全部测试使用临时独立 SQLite，未打开正在使用的购买库。原主 Agent、Shopping、支付测试保留；旧桥接成功测试新增明确测试授权，不移除原断言。

新增测试覆盖无授权、approve/hold/block、软规则聚合、确认过期/拒绝/绑定、硬限额优先、任务/报价/授权变化、撤销发生在 create 与 confirm 之间、跨连接月度竞争、重复操作/回调、创建/确认超时、需验证和processing保留预占、跨用户拒绝、重启恢复、历史成功保留、商户确认失败、香港月界、频率边界、疑似重复、注入辅助信号、坏配置、旧浏览器入口关闭及HTTP归属/同源/字段保护。

本隔离目录 .env.local 的 STRIPE_SECRET_KEY、STRIPE_WEBHOOK_SECRET 均缺失；未复制其他目录的配置或数据库，未调用真实 Stripe。待用户在本目录安全配置同一 Stripe 沙盒及其转发签名密钥后，才可做浏览器当前会话真实风险链路验收。历史已完成的 Stripe 交易不冒充本轮通过。

最终检查：`npm test` **224/224通过**（原200项保留 + 新24项）；对调整后的月度并发测试再运行风控专项 **24/24通过**。`npm run lint`、`npx tsc --noEmit`、`node --check scripts/check-stripe-sandbox.mjs` 通过。`npm run build` 默认 Turbopack 遇构建子进程端口绑定 EPERM；`npx next build --webpack` 完整生产构建通过（编译、类型、12页生成及追踪），未绕过任何类型检查。

三条实际服务验收均为18000港仙受控支付，不是 Stripe 实测：

| 授权单笔软/硬限额 | 结果 | 付款 / 预算 |
| --- | --- | --- |
| 20000 / 20000 | approve | succeeded、spent=18000 |
| 10000 / 20000 | hold，R2-soft | not_started，无预占；生成绑定确认单 |
| 10000 / 17000 | block，R2-hard | not_started，无预占，无可越过硬限额的确认单 |

操作ID及完整决策见相邻 `risk-control-acceptance.json`。最后核对：Shopping 文件和 app/shop、components/shop 无本轮改动；未推送、部署或合并；隔离工作树只新增本轮源码/文档和忽略的测试结果文件，支付数据库未用于验收。
