# Agent A 与 Agent B 联调

当前集成分支把远端 main 的 `services/product-search.ts` 接到 B 的契约版审核器，入口是 `services/shopping-agent.ts`。

## 调用顺序

```text
主 Agent 生成 Requirement + StructuredSearchInput
        ↓
Agent A searchProducts（召回、硬筛、排序）
        ↓ 适配 candidate，保留来源和未知事实
Agent B evaluateShoppingCandidates（重新审核硬条件、预算、渠道和低价风险）
        ↓
若报价/商户/配送字段未知，调用可信 verifyFacts，再回到 B
        ↓
B 最多返回 1 个商品；有 paymentContext 时同时返回 1 个支付方案
```

主 Agent 调用 `createShoppingAgent(...).runShoppingTask({ requirement, quantity, searchInput, paymentContext })`。`paymentContext` 只传给 B，不会传给 A；卡号、CVV 和支付密钥不进入任何接口。

## A 到 B 的适配

远端 A 返回 `RankedSearchResult`，候选包含 `category`、`searchableText` 和产品报价。适配器会把所有可用文本事实合并为 B 所需的 `text.searchable`，并保留原始属性和 Fact 来源。A 的 `finalScore`、销量或 LLM 评分只作为搜索排序信号，B 不把它们当成硬条件证据。

B 重新检查 A 的硬条件。A 传回未知事实时，B 返回 `needs_verification`；B 不会因为 A 的评分较高而把未知条件当作满足。

## 当前数据源限制

Watsons SQLite 快照可以完成真实来源的商品召回和字段映射，但快照没有针对当前目的地的运费、配送可达性、商户平台白名单和整单 `quote`。因此联调结果会停在待核验，不能生成可购买推荐。`itemPriceMinor` 是已展示的销售价，快照原价另存为 `attributes.listPriceMinor`；`offer.discountMinor` 保持未知，避免重复扣减销售折扣。

要得到 `result_ready`，主 Agent 或可信订单服务需要补回：

- `merchant.id`、`merchant.platformId` 和来源 Fact；
- `quote.quantity`、`quote.destination`、`quote.otherFeesMinor`、`quote.totalMinor`；
- `offer.shippingMinor`、`offer.deliverable`、库存和本次可履约数量；
- 如果比较信用卡，传入与当前 Offer/数量/地区/金额绑定的 `paymentContext`。

## 验证

联调测试覆盖完整模拟报价、缺失配送和商户事实、未知成分硬条件、预算复核、任务版本、搜索超时和 Watsons 快照映射。运行 `npm test` 可执行全量测试；当前集成代码不会创建订单、查询授权或发起真实支付。
