# Agent B：决策与风控

## 契约版入口（proposal-v1）

支付方式优化已接入契约版 B：可传 `paymentContext`，返回 `paymentOptimization` 并保存选卡依据。按即时优惠、汇率和手续费比较当下扣款，返现只展示。字段与示例见 [支付对接文档](../../docs/agent-b-payment.md)。独立计算入口为 `payment.ts` 的 `optimizePaymentMethods`。

新增 `contract.ts` 的 `evaluateShoppingCandidates`、`checkShoppingPurchase`、`explainDecision`，以及 `workflow.ts` 的 `createContractShoppingAgent`。完整接入方式、已实现规则和团队待统一字段见 [实现交接文档](../../docs/agent-b-implementation.md)。以下旧入口保留给尚未迁移的 A/网页；它们不支持新 quote 和偏好条件组，不可用于新契约请求。

Agent B 只计算并返回结果，不修改主 Agent 的共享状态，也不执行购买。公共输入输出类型位于 `types/index.ts`。下一阶段的完整职责、字段契约、单一选择、异常低价审核和决策日志方案见 [Agent B 完整设计](../../docs/agent-b-design.md)。

当前全部输出字段见 [Agent B 输出字段清单](../../docs/agent-b-output-fields.md)。

A/B 统一编排入口为 `services/shopping-agent.ts`，详见 [联调约定](../../docs/agent-integration.md)。续航字段统一使用 `batteryLifeHours`（小时），需求版本从 0 开始也受支持。

## 接口

- `evaluateCandidates({ requirement, candidates }, options?)`
  - 先执行预算、库存、配送和 `hardConstraints` 过滤。
  - 硬约束未知时不把商品列为已满足要求的推荐，而是返回 `needsVerification` 和补查字段。
  - 对通过硬约束的候选按偏好权重计算 `0..1` 分数，并保留综合、性能、便携等不同取舍方向的代表候选。
  - 无可用候选且无待核验事实时返回 `needsSearch` 和 `searchHints`。
- `checkPurchase({ requirement, candidate, quantity, authorization }, context?)`
  - `context.getAuthorizationById` 必须查询后端保存的授权；未提供查询、记录不存在或调用方内容与后端记录不一致时安全阻止。
  - 执行前重新核验价格、运费、优惠、库存和配送。
  - 数量、币种、`offerId`、需求预算和授权金额任一不满足时阻止。
  - 本模块只返回检查结果；`approved` 仍需交给独立购买执行模块。

## 已约定策略

- 重量统一使用克（g）：候选事实为 `attributes.weightGrams`，约束与偏好接受 `weightGrams` 或 `attributes.weightGrams`，数值越小越便携。例如 1.3 千克应传入 `1300`；调用方迁移时必须同时转换字段名和数值，不再使用 `weightKg`。
- 报价用于推荐时默认有效期：5 分钟。
- 商品静态事实默认有效期：24 小时。
- 购买前动态事实默认有效期：1 分钟。
- 订单总价：`(itemPriceMinor - discountMinor) * quantity + shippingMinor`，即运费按订单计一次。
- 默认最多返回 3 个代表候选。
- 默认评分方向在 `DEFAULT_FIELD_POLICIES` 中显式定义。新增偏好字段必须先配置 `FieldPolicy`，系统不会猜测评分方向。
- 只有 `verified` 且未过期的事实能满足硬约束或通过购买检查；`unverified` 和 `mock` 会触发补查。

这些默认值都可通过函数选项覆盖，主 Agent 与 A 确认最终 SLA 后应统一配置。

## 调用示例

```ts
import { checkPurchase, evaluateCandidates } from "@/lib/agent-b"

const evaluation = await evaluateCandidates({ requirement, candidates })

const purchaseCheck = await checkPurchase(
  { requirement, candidate, quantity: 1, authorization },
  {
    getAuthorizationById: (authorizationId) =>
      authorizationStore.findById(authorizationId),
  },
)
```

## 验证

```bash
npm run test:agent-b
npm run lint
npm run build
```
