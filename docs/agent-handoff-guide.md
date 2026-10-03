# 主 Agent / 搜索与一级风控 / 二级风控联调攻略

这份文档是黑客松的对接约定。主 Agent 和二级风控团队优先读本文件；字段的唯一 TypeScript 定义在 [`types/index.ts`](../types/index.ts)。

## 先对齐两个接口

```text
用户对话 → 主 Agent 提取结构化条件
                  │
                  │ 对接1：POST /api/products/select
                  ▼
         本库：搜索 → 排序 → 一级商品条件检查
                  │
                  │ 对接2：响应中的 selection（单个商品或 null）
                  ▼
         主 Agent 转交给二级风控 ← 主 Agent 单独提供用户偏好/授权
                  │
                  ▼
         二级风控返回支付检查结论 → 主 Agent 决定是否下单
```

为了尽快跑通，由主 Agent 转发 `selection`，本库不用配置二级风控地址或回调。业务上仍是一级到二级的交接。

| 边界 | 谁调用谁 | 输入 | 输出 | 实现位置 |
| --- | --- | --- | --- | --- |
| 对接1，已实现 | 主 Agent → 本库 | `SelectProductRequest` | `SelectProductResult` | [`POST /api/products/select`](../app/api/products/select/route.ts) |
| 对接2，载荷已实现 | 主 Agent 转发本库选中的商品 → 二级风控 | `ProductHandoff`，即 `result.selection` | 二级风控的支付检查结论 | [`services/product-selection.ts`](../services/product-selection.ts) 生成载荷 |
| 授权旁路，二级团队接入 | 主 Agent → 二级风控 | `PaymentRiskAuthorization` | 授权查询/检查结果 | 本库提供类型，不提供接收接口 |

旧 `POST /api/products/search` 仍返回前十名，适合首页和调试；它没有完成一级检查，不能拿 `candidates[0]` 当作已通过的商品。新入口把这段必要检查串好了。

## 对接1：主 Agent 怎么发

`Content-Type: application/json`，本地地址 `http://localhost:3000/api/products/select`。完整可运行请求在 [`examples/select-product.request.json`](../examples/select-product.request.json)。

```json
{
  "searchInput": {
    "taskId": "demo-001",
    "requirementVersion": 1,
    "useLlm": false,
    "product_name": { "value": "lotion", "aliases": ["乳液"], "must": 1 },
    "range_conditions": [
      { "field": "volumeMl", "min": 100, "max": 300, "must": 1 },
      { "field": "priceMinor", "min": 10000, "max": 30000, "must": 0 }
    ],
    "include_keywords": [
      { "keywords": ["sensitive skin"], "must": 1 },
      { "keywords": ["moisturizing", "moisturising", "hydration"], "must": 0 }
    ],
    "exclude_keywords": [
      { "keywords": ["alcohol", "ethanol"], "scope": "ingredients", "must": 1 },
      { "keywords": ["fragrance", "parfum"], "scope": "ingredients", "must": 0 }
    ]
  },
  "quantity": 1,
  "destination": "香港",
  "excludedCandidates": []
}
```

| 字段 | 必填 / 默认值 | 主 Agent 要做的事 |
| --- | --- | --- |
| `searchInput` | 必填 | 复用现有 `StructuredSearchInput`，不再另造一套 Requirement |
| `taskId` / `requirementVersion` | 必填 | 同一任务保持 ID；用户改条件时版本递增。上下游响应必须与本次请求一致 |
| `useLlm` | 可选，默认 true | 联调先设 false；配置好模型后改为 true。只影响排序评分 |
| `product_name` | 必填，must 必须为 1 | 提供品名；标题匹配 value 或任一 aliases。Watsons 是英文快照，建议提供英文词 |
| 三个条件数组 | 必填，可以为 `[]` | range / include / exclude 都要提供；没有要求时用空数组 |
| `range_conditions` | 每条必须有 field、min、max、must | 仅支持 `volumeMl`、`priceMinor`；单边无限用 null，但上下限不能同时为 null |
| `include_keywords` / `exclude_keywords` | 每组至少一个词 | 组内任一词命中；多个 must 组都要满足。`scope` 默认 all；成分要求用 ingredients |
| `must` | 1 或 0 | 1 必须满足；0 是偏好，未满足也能被选中 |
| `quantity` | 可选，默认 1 | 正整数；原样传到二级风控，搜索价格范围仍是**单件价** |
| `destination` | 可选，默认 null | 收货地区或地址引用；传给二级风控补运费、配送信息 |
| `excludedCandidates` | 可选，默认 [] | 已拒绝的 `(productId, skuId, offerId)` 三元组，用于递补 |

金额都用 **HKD 整数分**：10000 = HKD 100。容量用 ml。搜索的价格条件是选品要求；支付授权上限是另一个字段，主 Agent 不能把 prefer 的最高价自动变成用户授权。

一级检查复用现有 TypeScript 文本/数值规则，不增加第二次 LLM 调用。它判断的是“现有数据是否满足结构化条件”，不保证商品功效。`lotion` 可能同时命中 Toner 和 Moisturizer；希望特定商品类别时，上游要提供更准确的品名/关键词。

## 对接1：响应怎么处理

```ts
type SelectProductResult = {
  taskId: string
  requirementVersion: number
  status: "ready" | "no_match" | "needs_verification" | "failed"
  selection: ProductHandoff | null
  searchStatus: "complete" | "partial" | "failed"
  reviews: ProductReview[]
  warnings: string[]
  error?: { code: SearchErrorCode; message: string }
}
```

| status | selection | 主 Agent 下一步 |
| --- | --- | --- |
| ready | 一个商品对象 | 将 selection 原样交给二级风控 |
| needs_verification | null | 尚有候选，但其 must 信息未知；补充可信商品信息后重试，或询问用户是否修改条件 |
| no_match | null | 本次前十名中没有可用候选，或都已被排除；让用户修改条件或扩大数据源 |
| failed | null | 看 error，修正请求或重试 |

`ready` 仅代表基于当前商品数据通过一级检查。`searchStatus: partial` 可能来自 LLM 降级，仍可有 ready 商品；`reviews` 记录实际检查过的候选，找到第一个通过者就停止。未知 must 永远不会被当成通过，未知 prefer 不阻止选择。没有商品时也使用 HTTP 200。

HTTP 400 表示请求无效，503 表示数据源/服务异常，504 表示搜索报告超时。非 POST 方法由框架返回 405。响应 `Cache-Control: no-store`。无效 JSON 无法识别任务时，错误响应的 taskId 为 `""`、版本为 0。

## 对接2：二级风控拿到什么

`selection` 的完整结构：

```ts
type ProductHandoff = {
  taskId: string
  requirementVersion: number
  quantity: number
  destination: string | null
  searchInput: StructuredSearchInput // 保留用户条件，方便后续重新检查
  candidate: Candidate              // 单个商品的全部事实，见下表
  productCheck: {
    status: "passed"
    checkedAt: string
    checks: ProductConditionCheck[] // conditionId, must, outcome, evidenceFields, reason
  }
}
```

`checks[].outcome` 为 `match / mismatch / unknown`。passed 时所有 must 均为 match；prefer 仍可能 mismatch 或 unknown。

| candidate 字段 | 二级风控用途 |
| --- | --- |
| `productId, skuId, offerId` | 三种独立标识；精确绑定商品、规格和报价，后续不得只靠商品名认领 |
| `title, url, category` | 展示商品、定位商家页面；URL 不代替已验证的下单接口 |
| `searchableText` | 描述、成分、品牌、分类路径等文本事实 |
| `attributes` | volumeMl、rating、salesCount 等属性事实 |
| `offer.currency` | 当前固定 HKD |
| `offer.itemPriceMinor` | 单件展示售价；Watsons 已是销售价 |
| `offer.shippingMinor, discountMinor` | 运费/额外折扣事实，可能未知；禁止将未知当 0、或重复扣除展示价已含的折扣 |
| `offer.stock, deliverable` | 库存和配送事实，仍需下单前刷新 |
| `missingFields` | 数据源的缺失字段提示 |

除 ID、标题、URL、category 和 currency 外，上述属性/文本/报价值都保留 `Fact<T>`：

```json
{
  "value": 24500,
  "source": "watsons-hk-api-snapshot",
  "fetchedAt": "2026-10-03T12:45:06.192967+00:00",
  "status": "verified"
}
```

未知值为 null；整份 offer 也可能为 null。示例的 verified 表示来自可追溯快照，**不是实时下单报价**。Mock 保持 `source: "mock-dataset", status: "mock"`。运费缺失不阻止一级商品检查，但二级风控不能因此假定免运费。一级通过时间 `checkedAt` 不会更新原始事实的 fetchedAt。

二级风控需要补足实际商户/报价、运费、数量可履约性和支付费用，计算整单金额，再对照授权上限。搜索/一级检查不读取银行卡、授权额度或用户支付偏好。

## 主 Agent 单独给二级风控的授权数据

本库已在共享类型中定义 `PaymentRiskAuthorization` 和 `PaymentRiskRequest`，便于两队复制/导入。二级 HTTP 服务由二级团队实现，**本库没有 `/api/risk/payment/check` 或下单接口**。

建议二级接口接收以下合并对象；若二级已经分开存储授权，也可用 taskId、版本、userId 和 authorizationId 对齐两路数据：

```ts
if (result.status !== "ready" || !result.selection) throw new Error("先处理选品结果")
const offerId = result.selection.candidate.offerId
if (!offerId) throw new Error("先补齐报价身份")

const riskRequest: PaymentRiskRequest = {
  selection: result.selection, // 仅当 result.status === "ready"
  userAuthorization: {
    taskId: result.taskId,
    requirementVersion: result.requirementVersion,
    userId: "demo-user",
    authorization: {
      authorizationId: "auth-001",
      allowedOfferId: offerId,
      maxTotalMinor: 30000, // 示例：用户允许整单最多支付 HKD 300
      maxQuantity: 1,
      currency: "HKD",
      expiresAt: "2099-01-01T00:00:00.000Z" // 仅示例；实际使用真实授权到期时间
    },
    allowedPaymentMethodIds: ["card-ref-1"],
    preferredPaymentMethodId: "card-ref-1"
  }
}
```

代码示例中的授权为结构说明，不是真实授权记录。`authorization` 复用现有 `Authorization` 类型，绑定一个具体 offer；offerId 为 null 时先补齐报价身份。金额、数量、到期时间由用户授权记录提供，不能由 LLM 生成；二级风控应通过 authorizationId 查询并核对后台记录。支付方法只传不透明引用，不传卡号、CVV 或密钥。allowedPaymentMethodIds 为空表示在该用户可用支付方法中不限方式。

两队可复用现有 `PurchaseCheck` 作为二级响应：携带 taskId、requirementVersion、`approved / blocked / needsVerification`、offerId、totalMinor、checkedAt、reasons、verificationRequests。二级自行实现授权查询与金额检查；主 Agent 仅在 approved 且与当前任务/版本/报价匹配时进入其下单步骤，保留本次 quantity 和 currency 上下文。此文档不新增真实交易代码。

## 最短跑通方法

在仓库目录执行：

```powershell
npm install
npm run dev
```

另开终端：

```powershell
node examples/select-product-demo.mjs
```

该脚本读取请求样例，调用新 HTTP 入口，断言 ready 和任务版本，并打印完整的 `selection` 作为对接2载荷。默认使用 Watsons 快照、关闭 LLM；不需要 API Key，不会向二级或下单服务发送请求。

要测 LLM，在 `.env.local` 配置 LLM_API_URL、LLM_API_KEY、LLM_MODEL，重启服务后运行：

```powershell
node examples/select-product-demo.mjs http://localhost:3000 --llm
```

要用 Mock，把 `.env.local` 中 `PRODUCT_DATA_MODE=mock` 后重启，运行同一个脚本。输出会保留 Mock 标记。跨服务调用从主 Agent 后端发起即可；本库不新增浏览器跨域或登录系统。

同进程调用也可省去 HTTP：

```ts
import { selectProduct } from "@/services/product-selection"
import type { SelectProductRequest } from "@/types"

const result = await selectProduct(request as SelectProductRequest)
if (result.status === "ready" && result.selection) {
  // 将 result.selection 交给二级团队的 HTTP/函数入口。
}
```

## 如何递补，以及当前范围

一级会自动跳过不满足或 must 未知的商品。若二级拒绝一个具体报价，主 Agent 累积它的精确身份，再次请求：

```ts
request.excludedCandidates ??= []
request.excludedCandidates.push({
  productId: selected.candidate.productId,
  skuId: selected.candidate.skuId,
  offerId: selected.candidate.offerId
})
const next = await selectProduct(request)
```

同一需求递补可保持 requirementVersion；需求本身改变才递增。授权绑定 offer，因此换商品后由二级重新匹配/确认授权，不能复用旧商品的通过结论。用户整体未授权或额度不足时先处理授权，不应无条件循环换商品。

当前每次会重新搜索，只在本次前十名内递补；不维护会话、不做分页或无限重试。到 no_match / needs_verification 就停止，剩余处理交回主 Agent。LLM 重跑可能改变顺序；excludedCandidates 保证已排除的精确报价不再被选中。

旧的 [`services/shopping-agent.ts`](../services/shopping-agent.ts) 和 `lib/agent-b` 完整流程仍保留，包含报价、商户、支付等检查；本次黑客松选择接口采用上述独立的轻量一级检查，不用再调用旧 runShoppingTask，否则会重复承担二级职责。以后要接完整报价/支付能力，再参考 [原集成文档](agent-b-shopping-integration.md)。

## 本次必要代码与验证

新增：共享对接类型、`services/product-selection.ts`、HTTP 适配和 `app/api/products/select/route.ts`。修改 `next.config.ts`，让新路由的部署产物包含 SQLite。现有搜索、评分和首页入口保持兼容。

测试在 [`tests/product-selection.test.mjs`](../tests/product-selection.test.mjs)，覆盖高 LLM 分不能放过 must 失败/未知、递补精确身份、偏好未知、数据来源保留、空结果、partial、源失败、任务版本、无效输入，以及 Mock/Watsons 实际管线。

```powershell
npm test
npm run lint
npx tsc --noEmit
npm run build
```

本次验证：81/81 测试通过，Lint、TypeScript 和生产构建通过。生产服务上执行上述 demo 成功得到 `BALANCING ACNE CARE LOTION 125ML` 的单商品交接对象；新路由构建追踪已包含 products.db。该结果证明接口与本地快照可跑通，不代表已接通二级风控或完成支付授权。
