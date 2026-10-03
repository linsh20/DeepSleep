# Agent B 输出字段清单

本文按当前代码整理，基准是契约版入口 `lib/agent-b/contract.ts` 和 A/B 联调入口 `services/shopping-agent.ts`。字段分为“B 审核产生”“A/主 Agent 原样带入”和“支付服务提供后由 B 计算”三类。

## 1. 主入口输出

主 Agent 调用 `evaluateShoppingCandidates(input, policy)` 时，返回 `ContractBResult`：

| 字段 | 类型/可选性 | 来源 | 含义 |
| --- | --- | --- | --- |
| `taskId` | `string` | 主 Agent，B 原样回传 | 任务标识 |
| `requirementVersion` | `number` | 主 Agent，B 原样回传 | 需求版本；下游必须拒绝旧版本 |
| `dataEnvironment` | `development_mock \| verified_sources` | 服务端策略 | 当前事实环境；`mock` 不能当真实购买依据 |
| `status` | `result_ready \| no_match \| needs_verification \| failed` | B | 本轮商品审核状态 |
| `plan` | 可选对象 | B 根据已选商品生成 | 展示用计划摘要，见第 2 节 |
| `reason` | `string`，可选 | B | `no_match` 时说明没有选出的原因 |
| `missingFacts` | `string[]`，可选 | B | `needs_verification` 时汇总缺失或待核验字段 |
| `candidates` | `ShoppingCandidate[]` | A 提供，B 保存快照 | B 实际审核的候选商品池 |
| `recommendations` | `ContractRecommendation[]` | B | 最多 1 个最终商品推荐 |
| `diagnostics` | 对象 | B | 审核明细、补查请求和下一步动作 |
| `decisionRecord` | `DecisionRecord` | B | 可持久化的完整决策日志 |
| `paymentOptimization` | 可选 `PaymentOptimizationResult` | B 计算 | 传入支付上下文后才有 |
| `error` | 可选 `AgentError` | B | `failed` 时的错误信息 |

`services/shopping-agent.ts` 的联调输出在此基础上额外增加：

| 字段 | 含义 |
| --- | --- |
| `search` | A 的 `RankedSearchResult` 原始快照；包含 A 的候选排序、搜索状态和警告 |
| `verificationRounds` | B/A 补查已执行轮数 |
| `stopReason` | `completed \| verification_limit \| no_progress \| no_verifiable_fields \| source_failed` |

## 2. 商品计划摘要 `plan`

仅在 B 选出商品时返回：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `plan.title` | `string` | 商品标题和购买数量，例如“乳液 × 1” |
| `plan.notice` | `string` | 模拟数据或购买前复核提示 |
| `plan.priceMinor` | `Fact<number>` | 已核验的本次整单金额；金额为订单币种最小单位 |

`plan.priceMinor.value` 为 `null` 时不能把计划当作可购买报价。

## 3. 商品推荐 `recommendations[]`

当前 B 只保留一个商品推荐，数组长度约束如下：

| 字段 | 类型 | 来源/含义 |
| --- | --- | --- |
| `productId` | `string` | A 的商品型号 ID |
| `skuId` | `string \| null` | A 的具体规格 ID |
| `offerId` | `string \| null` | A 的销售方案 ID；进入购买前必须明确 |
| `rank` | `number` | B 的商品推荐名次，当前首选为 `1` |
| `evidenceStatus` | `verified \| mock` | 当前推荐所用事实环境 |
| `checks` | `ConditionCheck[]` | B 对系统条件和用户硬条件的逐项判定 |
| `preferenceChecks` | `ConditionCheck[]` | B 对偏好的逐项判定 |
| `scoreLowerBound` | `number \| null` | 已确认偏好分数下界，范围 0–100 |
| `scoreUpperBound` | `number \| null` | 包含未知偏好后的可能上界，范围 0–100 |
| `explanation` | `string` | B 生成的推荐解释 |
| `tradeoffs` | `string[]` | 未完全满足的软偏好或选择取舍 |

推荐中的 `checks` 必须全部是 `match`。如果硬条件是 `unknown`，商品不能进入已确认推荐。

### `ConditionCheck`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `conditionId` | `string` | 条件 ID；系统条件通常使用 `system:` 前缀，A 搜索条件使用 `search:` 前缀 |
| `outcome` | `match \| mismatch \| unknown` | 满足、明确不满足、事实不足 |
| `evidenceFields` | `string[]` | 支撑判定的事实路径，例如 `offer.stock` |
| `reason` | `string` | 面向日志和解释的判定原因 |

## 4. 候选审核日志 `diagnostics`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `searchStatus` | `complete \| partial \| failed` | A 数据源状态，不等于 B 推荐状态 |
| `countUnit` | 固定 `offer` | 候选按商品、SKU、Offer 身份统计 |
| `candidateChecks` | `CandidateAudit[]` | 每个候选的硬条件、偏好和处置结果 |
| `filterLogs` | 数组 | 每个条件的输入数、匹配数、淘汰数、未知数 |
| `verificationRequests` | `VerificationRequest[]` | 需要 A 或可信数据服务补查的商品字段 |
| `warnings` | `string[]` | 部分搜索、模拟数据、低价基准不足等提示 |
| `nextAction` | `none \| verify \| search \| clarify \| resolve_configuration` | 主 Agent 下一步调度动作 |

### `CandidateAudit`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `productId / skuId / offerId` | 商品身份 | 对应被审核候选 |
| `checks` | `ConditionCheck[]` | 硬条件和系统底线判定 |
| `preferenceChecks` | `ConditionCheck[]` | 软偏好判定 |
| `disposition` | `eligible \| rejected \| needs_verification` | 候选处置状态 |
| `scoreLowerBound / scoreUpperBound` | `number \| null` | 偏好分数区间 |

### `VerificationRequest`

| 字段 | 类型 | 来源 | 含义 |
| --- | --- | --- | --- |
| `productId` | `string` | A/B 共同身份 | 要补查的商品 |
| `skuId` | `string \| null` | A | 具体规格 |
| `offerId` | `string \| null` | A | 具体销售方案 |
| `fields` | `string[]` | B | 要补查的事实路径 |
| `reason` | `string` | B | 为什么需要补查 |

## 5. 决策日志 `decisionRecord`

这个对象用于主 Agent 或日志服务持久化，以便回答“为什么推荐/选择这个商品”。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `decisionId` | `string` | B 根据请求和审核结果生成的日志 ID |
| `taskId` | `string` | 任务 ID |
| `requirementVersion` | `number` | 决策对应的需求版本 |
| `checkedAt` | `string` | B 审核时间，ISO 时间 |
| `policyVersion` | `string` | 使用的 B 规则版本 |
| `dataEnvironment` | 枚举 | 真实或模拟环境 |
| `requestSnapshot` | `{ requirement, quantity }` | 当时的用户需求快照 |
| `candidateSnapshots` | `ShoppingCandidate[]` | 当时审核的全部候选快照 |
| `audits` | `CandidateAudit[]` | 当时每个候选的审核记录 |
| `selected` | `ContractRecommendation \| null` | 当时选出的商品；无推荐时为 `null` |
| `paymentContextSnapshot` | 可选 `PaymentContext` | 当时参与选卡的支付条款快照 |
| `paymentOptimization` | 可选 `PaymentOptimizationResult` | 当时的支付比较和选卡结果 |

`explainDecision(decisionRecord)` 只读取这个快照，不重新查询当前网页数据，因此解释对应的是当时的证据。

## 6. 支付方式优化 `paymentOptimization`

只有主 Agent 传入与商品、SKU、Offer、数量、目的地和报价绑定的 `paymentContext` 时，B 才返回该字段。它是支付建议，不是最终风控批准。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `taskId` / `requirementVersion` | 任务元数据 | 与商品审核保持一致 |
| `policyVersion` | `string` | 支付比较规则版本 |
| `dataEnvironment` | 枚举 | 真实或模拟环境 |
| `status` | `ready \| needs_verification \| no_available_method \| not_evaluated` | 支付比较状态 |
| `objective` | 固定 `lowest_upfront_charge` | 当前目标：当下扣款最低 |
| `comparisonCurrency` | `string` | 统一比较币种，通常为订单币种 HKD |
| `orderSnapshot` | `PaymentOrder \| null` | 参与比较的订单报价快照 |
| `checkedAt` | `string` | 支付比较时间 |
| `evidenceStatus` | `verified \| mock` | 支付事实环境 |
| `comparisonComplete` | `boolean` | 是否所有提交的支付方案都已完成比较 |
| `recommended` | `PaymentRecommendation \| null` | B 推荐的唯一支付方案 |
| `evaluations` | `PaymentOptionEvaluation[]` | 每张可用卡/支付方案的比较结果 |
| `verificationRequests` | 数组 | 需要主 Agent 补齐的汇率、费用或资格字段 |
| `warnings` | `string[]` | 模拟、部分方案未知、购买前复核等提示 |

### `recommended` 和 `evaluations[]`

二者都包含以下身份与费用字段：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `optionId` | `string` | 已解析的支付方案 ID |
| `cardId` | `string` | 用户信用卡的非敏感引用 |
| `label` | `string` | 展示名称 |
| `paymentChannel` | `string` | 支付渠道编码 |
| `billingCurrency` | `string` | 卡片账单币种 |
| `status` | `eligible \| ineligible \| needs_verification` | 该方案状态 |
| `costs` | `PaymentCostBreakdown \| null` | 费用明细；待核验方案可为 `null` |
| `reasons` | `string[]` | 通过、淘汰或待核验原因 |
| `evidenceFields` | `string[]` | 使用的支付事实路径 |
| `validUntil` | `string \| null` | 该方案结果有效截止时间 |

`recommended` 额外有 `explanation`。`costs` 字段如下：

| 字段 | 单位 | 含义 |
| --- | --- | --- |
| `instantDiscountMinor` | 订单币种最小单位 | 本次即时优惠 |
| `orderPayableMinor` | 订单币种最小单位 | 扣除即时优惠后的整单金额 |
| `convertedPrincipalMinor` | 账单币种最小单位 | 换汇后的本金 |
| `feeMinor` | 账单币种最小单位 | 手续费 |
| `chargeMinor` | 账单币种最小单位 | 预计当下实际扣款 |
| `comparisonChargeMinor` | 订单币种最小单位 | 用于跨卡统一比较的金额 |
| `futureCashbackMinor` | 订单币种最小单位或 `null` | 未来返现，仅展示，不参与预算和排序 |

## 7. 购买预检查 `checkShoppingPurchase`

该入口不是商品推荐入口，而是 B 的购买前预检查。它必须查询后端真实授权，并重新核验商品报价。返回 `PurchaseCheck`：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `taskId` | `string` | 任务 ID |
| `requirementVersion` | `number` | 需求版本 |
| `status` | `approved \| blocked \| needsVerification` | **购买预检查**状态，不等于最终风控放行 |
| `offerId` | `string \| null` | 被检查的 Offer |
| `totalMinor` | `number \| null` | 重新核验的商品整单金额 |
| `checkedAt` | `string` | 检查时间 |
| `reasons` | `string[]` | 阻止、通过或待核验原因 |
| `verificationRequests` | `VerificationRequest[]` | 商品事实补查请求 |
| `paymentOptimization` | 可选 `PaymentOptimizationResult` | 含支付费用的预检查结果 |

`approved` 只表示 B 的购买预检查通过。主 Agent 仍需把商品、支付卡、授权和金额交给最终风控 Agent；只有风控最终放行后，独立支付执行模块才能发起真实支付。

## 8. 状态到主 Agent 动作

| B 状态 | 主 Agent 动作 |
| --- | --- |
| `result_ready` | 展示唯一商品推荐；如果支付为 `ready`，展示支付建议 |
| `no_match` | 使用 `reason`，重新搜索或向用户复问 |
| `needs_verification` | 使用 `verificationRequests` 补查，然后重新调用 B |
| `failed` | 使用 `error` 和 `diagnostics.nextAction` 处理错误或配置问题 |
| 支付 `ready` | 交给最终风控审核，不直接支付 |
| 支付 `needs_verification` | 补齐支付事实后重新比较 |
| 购买预检查 `approved` | 交给最终风控和支付执行模块 |

## 9. 当前边界

- `candidates` 和 `search` 是输入/审核快照，不代表全部市场商品。
- `recommendations` 最多一个；推荐不等于授权。
- `paymentOptimization.recommended` 是支付建议，不是风控的 `risk_approved`。
- B 不创建订单、不保存后端授权、不传完整卡号、不执行扣款。
- 所有 `Fact` 都保留 `source`、`fetchedAt`、`status`；未知使用 `value: null`，不能用 `0` 代替。
