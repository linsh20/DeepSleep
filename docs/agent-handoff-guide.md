# 主 Agent、搜索与两级风控：函数对接攻略

这条对接链直接调用函数、传 JavaScript/TypeScript 对象。订单及限额金额都用 **HKD 元**，例如 `100` 是 100 港元，`19.9` 是 19.90 港元。外币卡另保留实际账单币种及元数供核对，不使用分。商品从本地 SQLite 数据库读取，不需要商品 URL。

## 1. 两个对接点在哪里

```text
用户说话 → 主 Agent 整理条件
                    ↓ 对接1：await selectProduct(request)
           本库从数据库搜索 → 排序 → 一级检查商品条件
                    ↓ 返回 result.selection：单个商品数据
           一级：preparePaymentHandoff(selection, pricingInput)
                 计算整单金额（数量、运费、优惠、汇率、手续费）
                    ↓ 返回 priced.selection：商品 + orderAmount
                    ↓ 对接2：传给二级风控的函数
           二级风控检查金额/支付限制 ← 主 Agent 单独传用户授权与支付偏好
                    ↓ 返回 approved / blocked / needs_verification
           主 Agent 根据结论进入下单步骤
```

| 对接 | 函数 / 数据 | 代码位置 | 谁实现 |
| --- | --- | --- | --- |
| 对接1 | `selectProduct(request)` → `SelectProductResult` | [`services/product-selection.ts`](../services/product-selection.ts) | 本库已实现 |
| 一级金额计算 | `preparePaymentHandoff(selection, pricingInput)` | [`services/order-amount.ts`](../services/order-amount.ts) | 本库已实现，复用现有优惠/汇率计算器 |
| 对接2 | 把 `priced.selection` 和 `userAuthorization` 传给二级函数 | 参数类型 `PaymentRiskRequest`，返回类型 `PaymentRiskResult` | 二级团队实现函数；本库已定义双方字段 |

共享类型统一在 [`types/index.ts`](../types/index.ts)。这里不需要启动服务、配置端口或发送 HTTP 请求。调用代码运行在 Node.js 后端，能够访问本库和数据库。

## 2. “范围条件”和“条件数组”到底是什么

**范围条件就是最低多少、最高多少。** 例如“容量 100～300 ml”“价格 100～300 港元”。

**数组就是一张可以放多条要求的清单，用 `[]` 表示。** 没有这类要求就填 `[]`。这不是需要上游理解的新算法，主 Agent 只要把用户说的话填到对应清单里。

| 用户说的话 | 放到哪个字段 | 含义 |
| --- | --- | --- |
| 我要找乳液 | `product_name` | 商品名字 |
| 容量必须 100～300 ml | `range_conditions` | 一条容量范围要求 |
| 最好 100～300 港元 | `range_conditions` | 再加一条价格范围要求 |
| 必须提到敏感肌 | `include_keywords` | 商品文字必须包含的词 |
| 最好保湿 | `include_keywords` | 再加一组希望包含的词 |
| 成分不能有酒精 | `exclude_keywords` | 成分文字需要排除的词 |

每条要求的 `must: 1` 表示必须满足，`must: 0` 表示最好满足。一个关键词组内多个词表示“任意一个匹配即可”，多个 must 组则都要满足。当前匹配依据数据库文字，不代表医学功效验证。

例如只有“最多 300 港元”，这样写：

```ts
range_conditions: [
  { field: "priceHkd", min: null, max: 300, must: 1 }
]
```

`min: null` 表示没有最低要求；`max: null` 表示没有最高要求。两端不能同时为空；如果完全不限制价格，就不加这条。

## 3. 对接1：主 Agent 直接调用这个函数

```ts
import { selectProduct } from "@/services/product-selection"
import type { SelectProductRequest } from "@/types"

const request: SelectProductRequest = {
  searchInput: {
    taskId: "demo-001",          // 本次购物任务的 ID
    requirementVersion: 1,        // 用户改要求时加 1
    useLlm: false,                // 先关闭，跑通后可改为 true
    product_name: { value: "lotion", aliases: ["乳液"], must: 1 },
    range_conditions: [
      { field: "volumeMl", min: 100, max: 300, must: 1 },
      { field: "priceHkd", min: 100, max: 300, must: 0 }
    ],
    include_keywords: [
      { keywords: ["sensitive skin"], must: 1 },
      { keywords: ["moisturizing", "moisturising", "hydration"], must: 0 }
    ],
    exclude_keywords: [
      { keywords: ["alcohol", "ethanol"], scope: "ingredients", must: 1 },
      { keywords: ["fragrance", "parfum"], scope: "ingredients", must: 0 }
    ]
  },
  quantity: 1,
  destination: "香港",
  excludedCandidates: []          // 第一次为空；递补时填写已拒绝的商品身份
}

const result = await selectProduct(request)
if (result.status === "ready" && result.selection) {
  console.log(result.selection.candidate.title)
  console.log(result.selection.candidate.offer?.priceHkd.value) // 如 245，即 HKD 245
  // 先调用 preparePaymentHandoff 加上整单金额，再交给二级风控。
}
```

必要约定：

- 品名的 must 固定为 1。Watsons 库是英文数据，建议提供英文品名和关键词；aliases 是可选别名。
- 三个清单都要提供；不需要时填 `[]`。价格字段用 `priceHkd`，容量字段用 `volumeMl`。价格最多两位小数，容量用整数毫升。
- 关键词的 scope 默认 `all`（标题和商品文本），成分排除用 `ingredients`（只看成分）。
- quantity 默认 1，destination 默认 null，excludedCandidates 默认 `[]`。价格范围是**单件售价**，不是整单支付上限。
- 二级风控需要同时核对 taskId、requirementVersion。品名 `lotion` 本身可能包含化妆水和乳液；需要特定类别时主 Agent 应提供更准确的词。

返回处理只看以下状态：

| `result.status` | `result.selection` | 主 Agent 下一步 |
| --- | --- | --- |
| `ready` | 一个商品对象 | 一级计算整单金额，成功后交给二级风控 |
| `needs_verification` | null | 有商品，但必须条件缺数据；补资料或询问用户是否调整要求 |
| `no_match` | null | 当前候选中没有合格商品，或都已排除；调整要求 |
| `failed` | null | 看 `result.error.code/message`，修正参数或重试 |

搜索可以保留未知商品，但一级检查只选全部 must 已通过的商品，按排序逐个递补。prefer 不满足不阻止选中。`reviews` 记录已检查商品，`warnings` 记录搜索提示；`searchStatus: partial` 可表示 LLM 降级，并不必然阻止返回商品。LLM 分数不代替 must 证据。

## 4. 对接2：数据库提取的单个商品 + 一级计算的整单金额

本库默认直接读取 `data/watson/data/products.db` 的 `products` 表，通过 [`WatsonsSqliteProductProvider`](../services/watsons-product-provider.ts) 提取并整理商品数据，选中后放入 `result.selection.candidate`。二级接到的是数据库里的商品数据，不是网页地址。

`priced.selection`（`PricedProductHandoff`）的字段：

| 字段 | 用途 |
| --- | --- |
| `taskId, requirementVersion` | 对齐这次任务和用户要求 |
| `quantity, destination` | 购买数量、收货地区 |
| `searchInput` | 用户原始结构化条件；金额仍为 HKD 元 |
| `candidate` | 下表中的一个商品 |
| `productCheck` | 一级检查时间和逐条件结论；通过的商品 status 为 passed |
| `orderAmount` | 一级算出的整单金额、信用卡引用、汇率、费用明细及数据来源，见下节 |

`candidate` 的主要字段：

| 字段 | 示例 / 含义 |
| --- | --- |
| `databaseCode` | 如 `BP_823438`，对应数据库 `products.code`；Mock 为 null |
| `productId, skuId, offerId` | 商品、规格、报价的独立 ID，递补和授权绑定使用 |
| `title, category` | 商品名称和分类 |
| `searchableText` | description、ingredients、brand、categoryPath 等数据库文字 |
| `attributes.volumeMl` | 容量，如 125 ml |
| `attributes.listPriceHkd` | 数据库存在原价时提供，单位 HKD 元 |
| `offer.currency` | HKD |
| `offer.priceHkd` | 单件售价，如 245，即 245 港元 |
| `offer.shippingHkd, offer.discountHkd` | 运费、额外折扣，单位 HKD 元；未知则为 null |
| `offer.stock, offer.deliverable` | 库存、是否可配送 |
| `missingFields` | 数据源缺少哪些字段 |

商品没有 `url` 字段。金额、容量、文字等事实保留来源，例如价格：

```ts
candidate.offer.priceHkd = {
  value: 245,
  source: "watsons-hk-api-snapshot",
  fetchedAt: "2026-10-03T12:45:06.192967+00:00",
  status: "verified"
}
```

未知 value 保持 null，不能按 0 元计算。`verified` 是快照来源可追溯，不是实时支付授权；Mock 仍为 `status: "mock"`。一级补齐报价和支付条款后计算整单金额，二级核对金额是否在授权内，并在下单前复核报价、汇率、优惠有效期。

如果二级团队希望自己从数据库再取原始记录，可以直接按 databaseCode 查询，无需 URL：

```ts
import { DatabaseSync } from "node:sqlite"

const db = new DatabaseSync("data/watson/data/products.db", { readOnly: true })
try {
  const row = db.prepare(
    "SELECT code, name, brand, price, ingredients, raw_json FROM products WHERE code = ?"
  ).get(result.selection!.candidate.databaseCode!)
  // row.price 的单位也是 HKD 元；raw_json 是原始商品 JSON 字符串。
} finally {
  db.close()
}
```

查询前确认 selection 和 databaseCode 非 null；没有该 code 时返回待补资料。默认从仓库根目录运行，其他数据库可配置 `WATSONS_DB_PATH`，二级自行查库时也要使用同一文件。

## 5. 一级如何计算整单金额

一级调用同步函数 `preparePaymentHandoff(selection, pricingInput)`，不需要 HTTP 或 LLM。目前是一种商品 × 数量、一个选定支付方式，不做多商品购物车或自动选卡。主 Agent/报价适配器提供该卡引用和可信条款；**卡片使用授权和额度仍由主 Agent 单独传给二级**。

数据库提供商品单价，但目前不包含实时运费、信用卡优惠和汇率。生产接入要从报价/支付数据源补齐这些数据；不能让 LLM 编造，也不能把数据库单价当整单总价。

`pricingInput: OrderPricingInput` 包含：

| 字段 | 含义 |
| --- | --- |
| `taskId, requirementVersion` | 与 selection 一致 |
| `productId, skuId, offerId, quantity, destination` | 绑定选中商品、数量和配送地，防止串单 |
| `pricing` | 一个 `Fact<OrderPricingTerms>`，包含下表的 value 和 source、status、fetchedAt、validUntil |

`pricing.value` 的字段（未知填 null，已确认没有费用/优惠才填 0）：

| 字段 | 单位 / 含义 |
| --- | --- |
| `unitPriceHkd` | HKD 单件现售价，必须与选中商品一致；变价需刷新选品检查 |
| `shippingHkd` | 整单运费，HKD |
| `orderDiscountHkd` | 整单额外商家优惠，HKD；不能重复扣除售价已包含的折扣 |
| `paymentMethodId` | 卡片引用，如 card-ref-1，不传卡号或安全码 |
| `eligible` | 此支付优惠方案是否适用于该用户和订单；不是付款授权 |
| `billingCurrency` | HKD / CNY / USD / EUR / GBP / JPY |
| `settlementRate` | 字符串，1 HKD 换多少账单币种，例如 USD `"0.13"`；HKD 填 null 或 `"1"` |
| `referenceRateToHkd` | 字符串，1 账单币种折合多少 HKD，例如 `"7.8"`；HKD 填 null 或 `"1"` |
| `feePercent` | 支付手续费百分比，`2` 表示 2%，最多两位小数 |
| `fixedFeeBillingAmount` | 固定手续费，单位为 billingCurrency 的元；JPY 为整数 |
| `cardOffer` | 即时优惠：`minSpendHkd` 门槛、`discountPercent` 折扣百分比（10 表示减 10%）、`discountHkd` 再减固定港元、`capHkd` 优惠上限（null 不设上限） |
| `futureCashbackHkd` | 延迟返现，仅展示，不抵扣当前金额；未知可为 null |

无即时优惠也必须明确传 `{ minSpendHkd: 0, discountPercent: 0, discountHkd: 0, capHkd: null }`。`cardOffer: null` 表示尚不知道是否有优惠，不能直接算出完整金额。

计算规则：

```text
商品小计 = 单价 × 数量
优惠前整单金额 = 商品小计 + 运费 - 额外商家优惠
信用卡即时优惠 = 达到门槛后计算百分比优惠 + 固定优惠（不超过上限及整单金额）
商家应收 HKD = 优惠前整单金额 - 信用卡即时优惠
账单本金 = 商家应收 HKD × 结算汇率
实际账单金额 = 账单本金 + 百分比手续费 + 固定手续费
totalHkd = 实际账单金额 × 统一参考汇率
```

本版优惠门槛/比例以含运费、减商家优惠后的整单金额为基数；复杂卡条款不适用时不可硬套。金额内部用整数运算，折扣向下取整、换汇和费用向上取整到币种最小单位，输出仍是元。统一参考汇率应独立于信用卡结算汇率，不能直接取卡汇率的倒数，否则会抵消卡片汇差。HKD 支付两个汇率均为 1。

一级返回的 `priced.selection.orderAmount`：

| 字段 | 用途 |
| --- | --- |
| `unitPriceHkd, itemsSubtotalHkd, shippingHkd, orderDiscountHkd` | 单价、数量小计、运费和商家优惠 |
| `beforeCardDiscountHkd, cardDiscountHkd, merchantPayableHkd` | 卡优惠前金额、即时卡优惠、商家应收 |
| **`totalHkd`** | **二级用于检查整单支付限额的金额，包含换汇和手续费，不减延迟返现** |
| `paymentMethodId` | 二级核对用户是否授权这张卡 |
| `billingCurrency, billingPrincipal, billingFee, billingTotal` | 实际账单币种及本金、手续费、扣款元数；外币账单金额不要误当 HKD |
| `settlementRate, referenceRateToHkd` | 本次计算使用的两个汇率 |
| `futureCashbackHkd` | 未来返现，未抵扣 totalHkd |
| `checkedAt, validUntil, evidenceStatus, evidence` | 计算时间、有效期、mock/verified、原始报价条款及来源 |

例如 100 港元 × 2 件 + 20 港元运费 - 10 港元商家优惠，再减 10% 即时卡优惠，无手续费且 HKD 扣款：**totalHkd = 189**。

`pricing` 将报价和条款合为一个事实对象，以保持接入简单；适配器必须使用各输入中最早的 fetchedAt、最早的 validUntil，任一来源未核实就不能标 verified。当前计算有效期最多为 fetchedAt 后 5 分钟。不要给旧数据库快照盖上当前时间伪装实时报价。Mock 必须 source="mock-dataset"、status="mock"，并显式传 `{ allowMock: true }` 才能运行。

返回状态：`ready` 才有带 orderAmount 的 selection；`needs_verification` 表示缺失/过期数据；`no_available_method` 表示该卡方案不可用；`failed` 看 error。后三者 selection 为 null，**不能只拿未计价的商品交给二级付款**。

## 6. 二级风控函数和授权参数

二级团队实现如下函数。主 Agent 把一级计算后的商品对象（含 orderAmount）和用户的支付偏好/授权一起传入：

```ts
import type { PaymentRiskRequest, PaymentRiskResult, SelectProductResult, OrderPricingInput } from "@/types"
import { preparePaymentHandoff } from "@/services/order-amount"

// 二级团队实现的函数签名；本库只定义参数和返回类型。
declare function checkPaymentRisk(input: PaymentRiskRequest): Promise<PaymentRiskResult>

async function handoffToRisk(result: SelectProductResult, pricingInput: OrderPricingInput) {
  if (result.status !== "ready" || !result.selection || !result.selection.candidate.offerId) return
  // pricingInput 来自可信报价适配器，结构见第 5 节；Mock 运行示例见第 7 节。
  const priced = preparePaymentHandoff(result.selection, pricingInput)
  if (priced.status !== "ready" || !priced.selection) {
    console.log(priced.reasons, priced.error)
    return // 补齐金额数据后再继续
  }
  const checked = await checkPaymentRisk({
    selection: priced.selection,
    userAuthorization: {
      taskId: result.taskId,
      requirementVersion: result.requirementVersion,
      userId: "demo-user",
      authorization: {
        authorizationId: "auth-001",
        allowedOfferId: result.selection.candidate.offerId,
        maxTotalHkd: 300,          // 整单最多 300 港元，不是 300 分
        maxQuantity: 1,
        currency: "HKD",
        expiresAt: "2099-01-01T00:00:00.000Z" // 示例；实际填真实授权的到期时间
      },
      allowedPaymentMethodIds: ["card-ref-1"],
      preferredPaymentMethodId: "card-ref-1"
    }
  })
  // 二级检查 orderAmount.totalHkd <= maxTotalHkd，并检查授权、数量、卡片、有效期等。
  // 核对当前任务、版本和 offer 后，approved 才交给主 Agent 的下单步骤。
  console.log(checked.status, checked.totalHkd)
}
```

二级返回：`{ taskId, requirementVersion, status, offerId, totalHkd, currency: "HKD", reasons }`。status 为 `approved / blocked / needs_verification`；totalHkd 未知时为 null。

上例只是字段说明。授权 ID、额度和到期时间应来自真实用户授权记录，二级查询并核对；支付偏好只是偏好，不等于授权。支付方式传引用 ID，allowedPaymentMethodIds 为空表示不限制该用户可用的支付方式。搜索函数不需要这些参数。

二级还必须拒绝已过期/不匹配的报价，真实下单不可接受 evidenceStatus="mock"；核对实际扣款卡片、币种和金额是否与 orderAmount 一致。二级不得只拿 candidate.offer.priceHkd 或 merchantPayableHkd 检查限额，因为它们未包含全部费用。金额/数量/地区/卡片变化时重新调用一级计算，不复用旧 orderAmount。本库不实现二级授权或真实交易。

## 7. 直接运行示例

在仓库根目录，Node.js 22.13+：

```powershell
npm install
node examples/select-product-demo.mjs
```

不需要 `npm run dev`。脚本读取 [`请求示例`](../examples/select-product.request.json)，直接调用 selectProduct，从 SQLite 提取并打印一个商品。默认 useLlm=false，无需密钥。

连同一级整单计算一起验证：

```powershell
node examples/select-product-demo.mjs --with-amount
```

此命令读取真实数据库商品，但使用 [`Mock 支付条款`](../examples/order-pricing.mock.mjs)：运费 20 港元、减 10% 即时卡优惠（最多减 50 港元）、HKD 卡、无手续费。它直接执行 `preparePaymentHandoff(selection, mockOrderPricing(selection), { allowMock: true })`，打印含 orderAmount 的对接二对象，金额证据明确标 mock。不是实时优惠，不付款，也不调用尚未实现的二级函数。

启用 LLM：在 `.env.local` 配置 LLM_API_URL、LLM_API_KEY、LLM_MODEL，然后运行 `node examples/select-product-demo.mjs --llm`。这里只是评分器调用模型，Agent 之间仍然用函数传参。切换 Mock 时设置 `PRODUCT_DATA_MODE=mock`，运行同一命令。

二级拒绝后要换候选时，把三个 ID 加到 request.excludedCandidates，再调用 selectProduct。每次仅在搜索的前十名中递补；遇到 no_match / needs_verification 停止。如果是授权整体失效，则先处理授权，不循环换商品。换 offer 后需重新核对授权绑定。

## 8. 与库中旧代码的关系

本次对接入口统一用 selectProduct，参数和输出的金额都是 HKD 元。已有搜索/旧 Agent B 的整数金额计算仍由内部适配复用，上下游不需要转换单位，也不要混用旧函数的金额字段。旧的首页搜索接口仅供首页使用；上次新增的 select HTTP 路由已删除。

一级现在分两次函数调用：selectProduct 检查商品条件，preparePaymentHandoff 计算整单金额。金额函数复用现有 optimizePaymentMethods 的整数优惠/汇率算法，但不接入旧 runShoppingTask，也不处理支付授权。二级风控函数及主 Agent 下单仍由对应团队实现。

验证结果：91 项测试通过，Lint、TypeScript 和构建通过。覆盖商品筛选、HKD 小数金额、未知运费、数据库读取、精确身份递补，以及新增的整单数量、优惠门槛/封顶、外币换汇/手续费、延迟返现不抵扣、缺失/过期报价、Mock 隔离和身份绑定。`--with-amount` 示例以库内 245 港元商品和 Mock 条款，输出 `(245 + 20) × 90% = 238.50 HKD`。运行 `npm test`、`npm run lint`、`npx tsc --noEmit`、`npm run build` 可再次验证。
