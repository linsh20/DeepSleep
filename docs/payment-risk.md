# 风控一 → 风控二：函数对接

本模块把一级选出并计价的**一个商品**交给二级风控，全程是函数调用，不需要 HTTP、数据库写入、LLM 或支付。二级 `approved` 只表示可以进入**界面模拟下单**，不是真实付款授权。

```text
selectProduct(request)                     商品搜索 → Watsons 候选（价格 + 商品事实）
        ↓
runWatsonsDemoPaymentRisk({ selection, userAuthorization })
   ├─ 风控一：商品信息核对 + 虚拟信用卡计价
   │         totalHkd = 商品价 × 数量；不判断预算，不使用运费/配送/商户
   └─ 风控二：checkPaymentRisk             核对总价、授权、限额、版本和支付方式
        ↓
flow.status === "approved" && flow.order   交给界面模拟下单
```

代码：[`services/payment-risk.ts`](../services/payment-risk.ts)。共享类型 `PaymentRiskRequest`、`PaymentRiskResult`、`PaymentRiskFlowResult` 在 [`types/index.ts`](../types/index.ts)。金额都是 **HKD 元**。

## 调用方式

```ts
import { selectProduct } from "@/services/product-selection"
import { DEMO_VIRTUAL_CREDIT_CARD_ID } from "@/services/mock-order-pricing"
import { runWatsonsDemoPaymentRisk } from "@/services/payment-risk"

const selected = await selectProduct(request)
if (selected.status === "ready" && selected.selection) {
  const flow = await runWatsonsDemoPaymentRisk({
    selection: selected.selection,
    userAuthorization: {
      taskId: selected.taskId, requirementVersion: selected.requirementVersion, userId: "demo-user",
      authorization: {
        authorizationId: "auth-demo-001", allowedOfferId: selected.selection.candidate.offerId!,
        maxTotalHkd: 300, maxQuantity: 1, currency: "HKD", expiresAt: "2099-01-01T00:00:00.000Z",
      },
      allowedPaymentMethodIds: [DEMO_VIRTUAL_CREDIT_CARD_ID],
      preferredPaymentMethodId: DEMO_VIRTUAL_CREDIT_CARD_ID,
    },
  })
  if (flow.status === "approved") showMockOrder(flow.order!, flow.risk!)
}
```

已经有一级计价结果时，也可以只调用二级：`checkPaymentRisk({ selection: priced.selection, userAuthorization }, options)`。

## 返回

`runPaymentRisk` 返回 `PaymentRiskFlowResult`：

| 字段 | 含义 |
| --- | --- |
| `status` | `approved` / `blocked` / `needs_verification` / `failed` |
| `stage` | 停在哪一步：`pricing`（一级计价）或 `payment_risk`（二级风控） |
| `order` | 仅 `approved` 时非空：带 `orderAmount` 的商品，供界面模拟下单 |
| `pricing` | 一级 `preparePaymentHandoff` 的完整结果 |
| `risk` | 二级 `PaymentRiskResult`；一级未就绪时为 null |

一级状态映射：`needs_verification` → `needs_verification`，`no_available_method` → `blocked`，`failed` → `failed`。一级没有就绪时不会调用二级。通用入口仍是 `runPaymentRisk`；`runWatsonsDemoPaymentRisk` 是显式的黑客松快捷入口，会注入 Mock 虚拟信用卡和 `allowMock: true`。

## 二级检查规则

任一 `blocked` 规则命中即为 `blocked`（同时列出待核实原因）；否则有待核实项为 `needs_verification`；全部通过为 `approved`。

| 规则 | 结果 |
| --- | --- |
| 授权与商品的 `taskId` / `requirementVersion` 不一致 | blocked |
| 商品未通过风控一商品信息核对 | blocked（输入防线，不在二级重复核对具体商品事实） |
| 授权过期或到期时间无效 | blocked |
| 授权或订单金额不是 HKD | blocked |
| `allowedOfferId` 与选中商品的 `offerId` 不同 | blocked |
| 数量超过 `maxQuantity` | blocked |
| `allowedPaymentMethodIds` 非空且不含 `orderAmount.paymentMethodId` | blocked（空数组表示不限制） |
| `orderAmount.totalHkd` > `maxTotalHkd`（按整数港仙比较，等于上限可通过） | blocked |
| 金额或上限不是有效 HKD 元数，或输入缺少商品、`orderAmount`、授权 | blocked（原因以 `INVALID_INPUT:` 开头） |
| `orderAmount.validUntil` 已过期 | needs_verification，重新调用一级计价 |
| 金额来自 Mock 报价且未传 `allowMock: true` | needs_verification |

限额只看 `totalHkd`。Watsons 演示链路里 `totalHkd = priceHkd × quantity`，虚拟信用卡费用及优惠均为 0；风控一不按预算或额度拒绝，价格控制只发生在风控二。

`preferredPaymentMethodId` 只是偏好，不参与放行判断。

## 演示数据的限制

- Watsons 快照没有运费、配送和商户结账事实。黑客松快捷入口明确把这些字段排除在流程判断外，不把未知伪造成已验证事实。
- [`services/mock-order-pricing.ts`](../services/mock-order-pricing.ts) 只接收搜索候选的商品价，并注入 `demo-virtual-credit-card`：HKD、费用 0、优惠 0。其证据仍标记为 `mock-dataset` / `mock`，只可用于界面模拟下单。
- 风控二不再检查库存、配送或商户；这些属于风控一/正式履约模块，而当前演示的风控一仅核对搜索请求中的商品名称、规格和关键词条件。
- 用户授权当前由调用方直接传入，没有授权数据库；正式接入时授权 ID、额度和到期时间要来自后端保存的记录。
- 本模块不扣款、不建订单。`services/risk-control` 和 `services/purchase-execution` 中的 SQLite 风控与 Stripe 沙盒流程是另一条更重的链路，本模块没有接入它们。

## 运行与验证

```powershell
node examples/payment-risk-demo.mjs              # 默认上限 HKD 300 → approved
node examples/payment-risk-demo.mjs --limit 200  # 上限 HKD 200 → blocked
```

脚本读取 Watsons SQLite 选出一个商品（当前快照中通常为 BALANCING ACNE CARE LOTION 125ML，HKD 245），风控一计出 `245 × 1 + 0 卡费 = 245`，再交给风控二。

测试：`node --test tests/payment-risk.test.mjs`，覆盖真实 Watsons SQLite 候选、商品价即总价、虚拟信用卡、等于上限放行、超限拦截、版本/任务/Offer/数量/到期/卡片/币种不匹配、报价过期、Mock 限制、职责隔离、畸形输入，以及风控一失败时不进入风控二。
