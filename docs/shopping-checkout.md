# Shopping 结算准备与受控购买闭环

基线：7277e23，分支 feat/shopping-checkout。仍在 DeepSleep-shopping-integration 隔离工作树。无 Shopping A/B 搜索、排序、审核算法修改，无 app/shop 或 components/shop 修改；无真实商户交易。

## 支持范围和事实来源

当前明确支持一条新的**完整测试案例**，不是 Watsons 快照通过案例：

| 项目 | 值 |
| --- | --- |
| 类别 / query | 沙盒目录乳液 / DEEPSLEEP DEMO LOTION 200ML |
| 商品 / SKU | demo-shopping-lotion / demo-shopping-lotion-200ml |
| 原搜索 Offer | demo-reference-lotion-v1 |
| 参考来源 | mock-dataset；https://example.com/deepsleep/demo-shopping-lotion 是虚拟参考地址，不是实际商品网页 |
| 商品事实 | 虚拟品牌 DeepSleep Demo、容量200ml；生成时刻作为测试数据采集时间 |
| 实际演示商户 | Demo Merchant，merchantId=demo-merchant，平台 deepsleep-demo |
| 最终 Offer / quote | 每份服务端方案独立 demo-offer:<planId> / UUID quoteId，与原搜索 Offer 分开 |
| 结算 | 1件、配送引用「香港」、HKD；小计16000 + 运费1000 − 即时优惠0 + 其他费用0 = 17000港仙 |
| 报价有效期 | 60秒；完整方案不晚于报价、静态事实及固定支付上下文的有效期 |
| 支付选项 | stripe_test_card，一张服务端固定 Stripe 测试卡，无多卡/钱包优化功能 |

保留原 sandbox-lotion / sandbox-lotion-200ml / 180 HKD 案例。目录来源与旧固定测试需求分开，不替换用户搜索结果。

所有新商品属性和商户报价、库存、配送、支付选项适用性均为模拟，Fact.status=mock，source=mock-dataset，整体 development_mock。模拟支付费用0/无额外卡优惠只是本次沙盒路线的测试上下文，不是发行银行的真实优惠。成分、功效、色号和交付截止事实**未补全**；相应用户硬条件仍导致 needs_verification。B 的 benchmark_insufficient 警告保留，不虚构市场样本。

**Watsons 未登记到本目录**：本轮实测一个未明确被硬条件排除的真实快照候选，返回 unsupported_product，原身份、事实来源与采集时间未变。Watsons 还缺商户映射、可追溯的最终配送/整单报价及部分规格/功效事实；本轮没有把它们标成已核验。

## 模块与契约

- `services/checkout/catalog.ts`：受控目录、显式测试 ProductProvider、Demo B policy、系统支持的商品/商户/支付方法列表。
- `services/main-agent/shopping-adapter.ts`：仅精确的测试类别+query选择测试目录，仍经过原 A searchProducts 和原 B runShoppingTask；其他需求仍走 Watsons。测试来源不由浏览器 policy 开关控制。
- `services/checkout/coordinator.ts`：读取当前任务中完整保存的 shopping_contract_v1 结果和候选；排除已有硬条件 mismatch；请求模拟最终报价；直接调用新版 B `evaluateShoppingCandidates` 复核候选及 paymentContext。不调用旧 evaluateCandidates，也不请求自身 HTTP。
- `services/checkout/types.ts`：CheckoutEvidence 复用共享 Requirement / ShoppingCandidate / ContractBResult / PaymentContext。没有复制共享类型。
- `services/checkout/gate.ts`：付款前验证保存的审核、商品/Offer/quote/支付身份、需求及事实期限，接回原 SandboxExecutionGate 和 LimitedExecutionGate。
- `services/purchase-execution/demo-merchant.ts`：仅增加登记商品报价。订单、Stripe 适配器、Webhook 和幂等逻辑保持原实现。
- `services/purchase-bridge/service.ts`、`http.ts`：扩展 prepare 的候选标识；权威任务解析支持已保存结算方案，不依赖旧 sandboxSource 固定商品条件。
- `services/risk-control/types.ts`：支持范围读取受控目录；未改用户已确认的授权，也未改风控规则。
- `components/agent-purchase-debug.tsx`、`risk-debug.tsx`：候选补查按钮、准备结果、显式勾选授权商品；不改 /shop。

与 Shopping 组需对齐：

1. 查询候选身份采用 ProductIdentity 三元组(productId,skuId,offerId)，不能只用标题或 productId。
2. 原 Candidate 保留，结算生成**新 Offer**。B workflow.verifyFacts 禁止替换 Offer 身份，因此协调层明确重新调用新版 B 评估；未放松其 verifyFacts 身份约束。
3. 原 Requirement、quantity、sourceSearchInput 原样复核；新商户字段及 quote 使用现有共享 ShoppingCandidate 定义。没有向 A 传支付上下文。
4. B paymentContext 使用新 Offer、本次数量、目的地、币种和最终总额，methods 只有 stripe_test_card。cardId 是内部不透明引用，不是凭证。B 的 paymentChannel=credit_card 与执行/授权的 stripe_test_card 是不同层的标识。
5. B 推荐及 paymentOptimization.ready 不是购买授权。此处只接受 development_mock，执行仍需当前用户有限授权、一次测试许可、风险approve以及200 HKD上限。
6. 未来真实商品接入需单独提供可信目录身份映射/商户报价和缺失事实；不能通过放宽类别、时效、硬条件或风控使案例通过。

## 持久化与保护

沿用 sandbox_plans、main_purchase_links、sandbox_operations、sandbox_orders、risk_*。SandboxPlan 增加可选 checkout；Quote 增加可选 offerId、destination、discountMinor、otherFeesMinor、source、fetchedAt，旧方案无需这些字段，读取兼容。

checkout 保存原候选完整快照、原 Shopping decisionId、当前 Requirement、数量、原/新Offer、quoteId、paymentOptionId、补充后候选、完整 B 复核与 paymentContext、有效期。原搜索状态不会被支付成功覆盖，补查结果独立展示。

仅新增 `main_checkout_attempts(owner,request_id,task_id,version,candidate_id,data)`，(owner,request_id)唯一，持久化成功或未通过的准备结果/报价/B审核。该表不覆盖任何旧数据库记录。任务版本最多一个方案，已有方案不因重试重新报价。新旧准备入口复用 requestId 时检查冲突。

准备过程不创建订单或 PaymentIntent。外部报价返回后，在短事务内再检查当前任务与需求快照；并发只保存一个绑定方案。当前适配器仅同步本地报价，B 为确定性程序，无网络补查或无限重试。

执行使用服务端方案和报价，Gate 再检查当前权威任务、版本、审核绑定、报价金额和期限；现有限额、预占、疑似重复、稳定Stripe幂等键保持有效。报价/授权/需求变化使旧软确认不能直接使用；过期方案不自动重新报价。旧版本存在可能扣款的交易时，不允许新方案掩盖它。成功和未知交易仍保留，recover只核实原对象。

## 前端接口和操作路径

沿用主Agent服务端会话，不接收 userId、金额、商户URL、支付凭证或 policy。

`POST /api/agent/purchases/prepare` 新增可选 candidateId，其值为服务端返回候选三元组的 JSON 字符串：

```json
{"taskId":"<当前任务ID>","expectedVersion":1,"requestId":"<唯一请求ID>",
 "candidateId":"[\"demo-shopping-lotion\",\"demo-shopping-lotion-200ml\",\"demo-reference-lotion-v1\"]"}
```

不提供 candidateId 时保留旧 sandbox-lotion 准备入口。提供标识时只查当前任务已保存的候选；无需已有最终推荐。不支持任意候选快照或客户端权威报价。

返回原 `{taskId,requirementVersion,intent,purchases}`，附加 `checkoutPreparation`：

- result_ready：已保存可执行的**沙盒方案**，包含planId、quote、完整review；未付款。
- needs_verification：关键事实或支付上下文仍不完整，返回review/missingFacts，没有购买方案。
- no_match：硬条件、预算或配送不满足，没有购买方案。
- unsupported_product：未登记商品，不尝试冒充真实结算。
- failed：B审核失败，保留明确失败结果。

权限、旧版本、未知旧交易、无Shopping候选、报价不一致等仍返回 `{error:{code,message}}` 和对应HTTP错误码。结果HTTP200不等于可付款，必须看 checkoutPreparation.status。重复准备只复用已有方案，其是否过期以 purchases[].quoteExpired / 服务端 Gate 为准。

执行、GET状态、recover接口不变：前端发送taskId、planId、expectedVersion、requestId、testPermission:true；风控hold时在 /agent-risk 查看并确认具体软限额，再执行原方案。新商品必须在授权表单中明确勾选 demo-shopping-lotion 并保存新版本；旧 sandbox-lotion 授权不会被自动扩展。

开发操作：

1. `/agent` 建立当前会话，在结构化表单填上述类别/query、1件、香港、HKD、总预算200元，可加容量200ml硬条件；保存并运行 Shopping。
2. 到 `/agent-risk` 明确选择新商品、限额及有效期并保存；不要把一次测试许可当有限授权。
3. 回 `/agent` 点击候选“补查并准备”，查看原始来源、模拟报价和 B 复核；报价有效60秒。
4. 明确一次沙盒测试许可后执行；分别观察风险、订单与支付状态。若hold，必须在报价/确认单到期前完成确认并重新执行。
5. GET状态只读；需主动查询Stripe时使用recover。方案、预算和交易状态由服务端持久化，页面success参数不起作用。

## 实际验收与配置

`checkout-acceptance.json` 保存三条完整服务验收输入输出（支付提供方全部为 controlled_payment_double_not_stripe）：

| 初始风险 | 授权单笔软/硬上限（港仙） | 结果 |
| --- | --- | --- |
| approve | 20000 / 20000 | Shopping候选→报价→B通过→模拟支付succeeded→订单confirmed，预算spent17000 |
| hold | 10000 / 20000 | 确认前0次付款；明确确认并重新检查后同操作成功，spent17000 |
| block | 10000 / 16000 | R2-hard，无付款、无订单、无预算扣减 |

专项还验证真实Watsons不支持、未知色号、不可配送、超预算、排除条件、旧商品授权拒绝新商品、并发/重复准备及执行、重复回调、版本竞态、报价过期、确认后报价/授权/需求变化、付款创建期间切换compare、未知旧交易阻止替代、重启恢复以及HTTP只接受候选标识。数据库均为系统临时目录独立SQLite，未用于真实Stripe。

本目录 `STRIPE_SECRET_KEY` 和 `STRIPE_WEBHOOK_SECRET` **均缺失**。未复制其他工作区配置/数据库，未运行CLI诊断付款。因此本轮浏览器当前会话的真实PaymentIntent、模拟商户确认、真实Webhook与预算结算**尚未验收**；历史Stripe成功记录不作为本轮证据。配置就绪后必须按上述新的Shopping方案→有限授权→风险流程验收，不能用独立CLI诊断替代。

最终检查：`npm test` **237/237通过**（原224项保留，新增13项结算验收）；`npm run lint` 与 `npx tsc --noEmit` 通过。默认 `npm run build` 的 Turbopack 仍遇子进程端口绑定 EPERM；`npx next build --webpack` 完整通过编译、类型检查、12页生成及追踪。未屏蔽检查、未修改A/B算法、未推送、部署或合并。
