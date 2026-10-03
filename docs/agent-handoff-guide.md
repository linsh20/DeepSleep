# 主 Agent、搜索与两级风控：函数对接攻略

这条对接链直接调用函数、传 JavaScript/TypeScript 对象。所有对接金额都用 **HKD 元**，例如 `100` 是 100 港元，`19.9` 是 19.90 港元。商品从本地 SQLite 数据库读取，不需要商品 URL。

## 1. 两个对接点在哪里

```text
用户说话 → 主 Agent 整理条件
                    ↓ 对接1：await selectProduct(request)
           本库从数据库搜索 → 排序 → 一级检查商品条件
                    ↓ 返回 result.selection：单个商品数据
                    ↓ 对接2：传给二级风控的函数
           二级风控检查金额/支付限制 ← 主 Agent 单独传用户授权与支付偏好
                    ↓ 返回 approved / blocked / needs_verification
           主 Agent 根据结论进入下单步骤
```

| 对接 | 函数 / 数据 | 代码位置 | 谁实现 |
| --- | --- | --- | --- |
| 对接1 | `selectProduct(request)` → `SelectProductResult` | [`services/product-selection.ts`](../services/product-selection.ts) | 本库已实现 |
| 对接2 | 把 `result.selection` 和 `userAuthorization` 传给二级函数 | 参数类型 `PaymentRiskRequest`，返回类型 `PaymentRiskResult` | 二级团队实现函数；本库已定义双方字段 |

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
  // result.selection 就是传给二级风控的商品对象。
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
| `ready` | 一个商品对象 | 交给二级风控 |
| `needs_verification` | null | 有商品，但必须条件缺数据；补资料或询问用户是否调整要求 |
| `no_match` | null | 当前候选中没有合格商品，或都已排除；调整要求 |
| `failed` | null | 看 `result.error.code/message`，修正参数或重试 |

搜索可以保留未知商品，但一级检查只选全部 must 已通过的商品，按排序逐个递补。prefer 不满足不阻止选中。`reviews` 记录已检查商品，`warnings` 记录搜索提示；`searchStatus: partial` 可表示 LLM 降级，并不必然阻止返回商品。LLM 分数不代替 must 证据。

## 4. 对接2：数据库提取的单个商品

本库默认直接读取 `data/watson/data/products.db` 的 `products` 表，通过 [`WatsonsSqliteProductProvider`](../services/watsons-product-provider.ts) 提取并整理商品数据，选中后放入 `result.selection.candidate`。二级接到的是数据库里的商品数据，不是网页地址。

`selection` 的字段：

| 字段 | 用途 |
| --- | --- |
| `taskId, requirementVersion` | 对齐这次任务和用户要求 |
| `quantity, destination` | 购买数量、收货地区 |
| `searchInput` | 用户原始结构化条件；金额仍为 HKD 元 |
| `candidate` | 下表中的一个商品 |
| `productCheck` | 一级检查时间和逐条件结论；通过的商品 status 为 passed |

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

未知 value 保持 null，不能按 0 元计算。`verified` 是快照来源可追溯，不是实时支付授权；Mock 仍为 `status: "mock"`。二级处理实际支付时负责核对当前报价、运费和授权。

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

## 5. 二级风控函数和授权参数

二级团队实现如下函数。主 Agent 把上面的单商品对象和用户的支付偏好/授权一起传入：

```ts
import type { PaymentRiskRequest, PaymentRiskResult } from "@/types"

// 二级团队实现的函数签名；本库只定义参数和返回类型。
declare function checkPaymentRisk(input: PaymentRiskRequest): Promise<PaymentRiskResult>

if (result.status === "ready" && result.selection && result.selection.candidate.offerId) {
  const checked = await checkPaymentRisk({
    selection: result.selection,
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
  // 核对当前任务、版本和 offer 后，approved 才交给主 Agent 的下单步骤。
  console.log(checked.status, checked.totalHkd)
}
```

二级返回：`{ taskId, requirementVersion, status, offerId, totalHkd, currency: "HKD", reasons }`。status 为 `approved / blocked / needs_verification`；totalHkd 未知时为 null。

上例只是字段说明。授权 ID、额度和到期时间应来自真实用户授权记录，二级查询并核对；支付偏好只是偏好，不等于授权。支付方式传引用 ID，allowedPaymentMethodIds 为空表示不限制该用户可用的支付方式。搜索函数不需要这些参数。

## 6. 直接运行示例

在仓库根目录，Node.js 22.13+：

```powershell
npm install
node examples/select-product-demo.mjs
```

不需要 `npm run dev`。脚本读取 [`请求示例`](../examples/select-product.request.json)，直接调用 selectProduct，从 SQLite 提取并打印一个商品。默认 useLlm=false，无需密钥。

启用 LLM：在 `.env.local` 配置 LLM_API_URL、LLM_API_KEY、LLM_MODEL，然后运行 `node examples/select-product-demo.mjs --llm`。这里只是评分器调用模型，Agent 之间仍然用函数传参。切换 Mock 时设置 `PRODUCT_DATA_MODE=mock`，运行同一命令。

二级拒绝后要换候选时，把三个 ID 加到 request.excludedCandidates，再调用 selectProduct。每次仅在搜索的前十名中递补；遇到 no_match / needs_verification 停止。如果是授权整体失效，则先处理授权，不循环换商品。换 offer 后需重新核对授权绑定。

## 7. 与库中旧代码的关系

本次对接入口统一用 selectProduct，参数和输出的金额都是 HKD 元。已有搜索/旧 Agent B 的整数金额计算仍由内部适配复用，上下游不需要转换单位，也不要混用旧函数的金额字段。旧的首页搜索接口仅供首页使用；上次新增的 select HTTP 路由已删除。

本函数的一级检查只处理商品条件。旧 runShoppingTask 包含报价、支付等更完整的流程，本次接入不需要再调用它。二级风控函数及主 Agent 下单仍由对应团队实现。

验证结果：83 项测试通过，Lint、TypeScript 和构建通过。直接函数示例在 Watsons 数据库返回 `BP_823438`、价格 `245` 港元；Mock 示例返回 `238` 港元并保留 mock 标记。测试同时覆盖小数价格、未知运费、没有 URL、无网络调用下读取数据库和精确身份递补。
