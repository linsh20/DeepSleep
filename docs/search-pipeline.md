# 统一商品搜索管线

本模块的边界从接收结构化条件开始，到输出最多十个有序候选结束。它不解析对话、不授权购买、不执行交易。后续授权验证应从第一名开始检查，不满足时按返回顺序递补。

## 调用入口

```ts
import { searchProducts } from "@/services/product-search"

const result = await searchProducts({
  taskId: "task-001",
  requirementVersion: 1,
  product_name: {
    value: "lotion",
    aliases: ["emulsion", "moisturising lotion"],
    must: 1,
  },
  range_conditions: [
    { field: "volumeMl", min: 100, max: 300, must: 1 },
    { field: "priceMinor", min: 10000, max: 30000, must: 0 },
  ],
  include_keywords: [
    { keywords: ["sensitive skin"], must: 1 },
    { keywords: ["moisturizing", "moisturising"], must: 0 },
  ],
  exclude_keywords: [
    { keywords: ["alcohol", "ethanol"], scope: "ingredients", must: 1 },
    { keywords: ["fragrance", "parfum"], scope: "ingredients", must: 0 },
  ],
})
```

HTTP 入口为 `POST /api/products/search`，请求体就是上述结构。响应禁止缓存。

## 字段和单位

| 字段 | 单位/语义 |
| --- | --- |
| `priceMinor` | HKD 最小货币单位；HKD 100 = `10000` |
| `volumeMl` | 毫升，非负整数 |
| `must` | `1` 为硬条件，`0` 为排序偏好 |
| `product_name.aliases` | 可选；与 `value` 任一命中标题即可 |
| `KeywordCondition.scope` | 可选；`all` 或 `ingredients`，默认 `all` |
| `taskId` | 当前任务标识 |
| `requirementVersion` | 非负整数；需求变化时递增 |

金额进入核心契约前必须转换为整数最小货币单位。事实未知时使用 `null`，不能使用 `0`、空字符串或虚构值。

## 执行顺序

1. 默认从 Watsons SQLite 广泛召回 349 条已确认 Face Treatment 商品，标准化事实，并按 `(productId, skuId, offerId)` 去重。
2. 依次处理品名、数值范围、包含关键词、排除关键词。
3. `must` 的已知违反会淘汰；未知事实保留并加入 `needsVerification`。`prefer` 不淘汰。
4. 每个条件产生包含筛选前后数量的 `FilterLog`。候选变成零时立即返回，不调用评分器。
5. 候选超过十个时，先按评分 60%、销量 40% 预选。销量使用 `log1p` 降低长尾影响；缺失指标不伪造为零。
6. 对最多十个候选逐条件执行 LLM 评分。分数为 1–5；未知条件由代码强制为 3。
7. 使用 `must=2`、`prefer=1` 的加权调和平均计算最终分，低条件分会受到更强惩罚。
8. 返回最多十个按分数排序的精确候选身份。

关键词组为“任一词命中”。文本在比较前执行 Unicode NFKC、大小写、标点和空白归一化。`scope: "ingredients"` 只查看成分字段：通用 `alcohol` 只匹配 alcohol denat、ethanol、ethyl alcohol、isopropyl alcohol 等挥发性酒精，不匹配 cetyl/cetearyl 等脂肪醇；通用 `fragrance` 同时识别 `parfum`。成分缺失时结论为未知，不会当作“不含”。

当前快照语言是 `en_HK`。上游应将中文意图转换为英文规范词并提供英文别名；内部不混用机器翻译后的品牌或 INCI。若未来换为 `zh_HK` 数据，应先统一繁体规范，再额外处理简繁映射和同义词，不能只依赖 NFKC。

## Watsons 数据映射

- 只查询 `category_status = confirmed_face_treatment`；原始 355 条中的 2 条泛类目和 4 条不一致/缺失类目不会进入搜索。
- `price.value` 转成 HKD 整数分，作为已经折扣后的展示单价；原价另存 `attributes.listPriceMinor`。`offer.discountMinor` 保持未知，等待针对本次订单核实额外优惠，避免再次扣除“原价减现价”。会员、件数和其他条件促销不假定可用。
- 容量优先比较 `elabPackSize`、variant 单位和标题。多个容量、组合装或来源冲突一律为 `null`。
- 评分只有在评论数大于零时才采用；销量缺失保持 `null`，不使用零代替。
- HTML 描述只保留纯文本，`N/A` 成分转为 `null`。相对商品链接固定解析到 Watsons 香港 HTTPS 域名。
- `purchasable` 在本快照全部为 false，不能作为可购买结论；配送费和可配送性保持 `null`。
- 所有事实使用 `source: "watsons-hk-api-snapshot"`，`fetchedAt` 来自 manifest 的导出时间，`status: "verified"` 表示可追溯到该快照，不表示实时。

## LLM 配置和降级

当前适配 OpenAI-compatible chat-completion JSON 接口，配置仅能存在于服务端：

```text
LLM_API_URL=https://provider.example/v1/chat/completions
LLM_API_KEY=...
LLM_MODEL=...
```

不得使用 `NEXT_PUBLIC_` 暴露密钥。商品文本作为不可信数据放在 user 内容中；系统指令禁止执行商品文本中的指令或补写事实。模型输出必须覆盖全部条件、满足 1–5 整数分和证据字段约束。

未配置模型、超时或单商品输出非法时，该商品使用确定性评分降级，结果标记为 `partial`。单商品失败不会导致整个搜索失败。确定性规则为满足 5 分、违反 1 分、未知 3 分。

## 状态语义

- `complete/ranked`：搜索和评分完整，返回有序候选。
- `complete/no_match`：数据源搜索成功，但条件筛选后没有候选。
- `partial/ranked`：仍有可用候选，但数据源覆盖不完整或发生 LLM 降级。
- `failed/failed`：输入无效、数据源总失败、超时或全部记录不可用。

错误只使用 `INVALID_INPUT`、`SOURCE_UNAVAILABLE`、`TIMEOUT`、`UNSUPPORTED_CATEGORY` 前缀，不返回密钥或私有上游响应。

## 数据源与 Mock 覆盖

运行时默认使用 `data/watson/data/products.db`。设置 `PRODUCT_DATA_MODE=mock` 后，`data/products.mock.json` 覆盖乳液/非乳液、精确重复、容量内外、价格内外、包含和排除词、缺失价格/容量/文本、评分和销量、缺货等情况。所有 Mock 事实使用 `source: "mock-dataset"`、`status: "mock"` 和本次召回时间。

快照不能解决实时购买性、配送地区、即时库存、促销资格或抓取后的变化。后续授权验证必须按候选精确身份重新请求可归属的数据源，并在购买前再次检查；推荐结果不是购买授权。

## 验证

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
```

测试覆盖正常、空结果、非法输入、部分失败、总失败、超时取消、去重、硬筛、偏好、缺失字段、Mock 降级、评分/销量预选、未知 3 分、调和平均、任务版本、HTTP 错误映射，以及 Watsons 映射、容量冲突、HTML 清理和成分语义。
