# Agent B：决策与风控

Agent B 只计算并返回结果，不修改主 Agent 的共享状态，也不执行购买。公共输入输出类型位于 `types/index.ts`。

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
