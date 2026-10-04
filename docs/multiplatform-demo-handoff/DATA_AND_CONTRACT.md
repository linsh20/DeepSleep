# 数据库与 Agent 字段交接

## 文件和数据范围

| 文件 | 作用 |
| --- | --- |
| `data/watson/data/products.demo-multiplatform.db` | 交付的 SQLite 副本；运行时用 `WATSONS_DB_PATH` 指向它 |
| `data/watson/data/products.db` | 原始 Watsons 库；不要覆盖 |
| `data/watson/create_multiplatform_demo.sql` | 从原始库重新生成报价表的 SQL；不要在已有报价表的副本上重复执行 |
| `data/watson/run_multiplatform_demo.ps1` | 设置数据库路径并启动开发服务 |
| `examples/multiplatform-*.request.json` | 两种品类的搜索接口请求 |

`products` 表仍为 355 条原始商品，`code` 不增加平台后缀；`product_offers` 有 403 条报价：355 条 Watsons 快照报价，外加两个细分类别各 12 件商品、每件两个新增平台报价，共 48 条。新增报价按 Watsons 快照单价生成：SaSa ×0.94、Mannings ×1.03。这只是 Demo 定价规则。

## 字段契约

| SQLite 字段 | Agent 字段 | 约定 |
| --- | --- | --- |
| `products.code` | `productId` / 原始 `databaseCode` | 同一商品跨平台稳定；不要添加平台后缀 |
| `product_offers.sku_code` | `skuId` | 同一规格跨平台稳定 |
| `product_offers.offer_id` | `offerId` | 每个平台独立；候选完整身份为 `(productId, skuId, offerId)` |
| `platform_id`、`merchant_id`、`merchant_name` | `merchant.platformId`、`merchant.id`、`merchant.name` | 跟候选传入 Agent B 与主 Agent handoff |
| `price`、`currency` | `offer.itemPriceMinor`、`currency` | 数据库价格单位为 HKD 元；Agent 金额单位为港仙整数，HKD 129.72 = 12972 |
| `fact_source`、`fact_status`、`fetched_at` | Fact 的 `source`、`status`、`fetchedAt` | SaSa/Mannings 必须保持 `mock-dataset` / `mock`；不得升级为已验证 |

例如 `BP_119795` 的 Watsons `offerId` 是 `watsons-offer-hk:BP_119795:119795`，新增平台分别用 `sasa-offer-hk:`、`mannings-offer-hk:` 前缀。已存在的 Watsons offer 身份保持不变。读取链路为 `/api/products/search` → `services/product-search.ts` → `services/watsons-product-provider.ts`；主 Agent/Agent B 继续按共享候选契约处理，不应直接从前端 SQLite 读取。

## 验证与边界

快速核对目标报价：

```sql
SELECT product_code, sku_code, offer_id, platform_id, price, fact_source, fact_status
FROM product_offers
WHERE product_code IN ('BP_119795', 'BP_235677')
ORDER BY product_code, platform_id;
```

运行 SQL 的例子：

```powershell
sqlite3.exe -readonly ".\data\watson\data\products.demo-multiplatform.db" "SELECT product_code, platform_id, price FROM product_offers WHERE product_code IN ('BP_119795','BP_235677') ORDER BY product_code, platform_id;"
```

数据库记录没有实时运费、配送、库存及整单结账确认，新增平台链接也是占位 Demo URL。用户需求和搜索结果不是付款授权；不得把模拟报价接入真实购买、Stripe 支付或对外宣称实时可购。详细调用和完整校验命令见 [`MULTIPLATFORM_DEMO.md`](../../data/watson/MULTIPLATFORM_DEMO.md)。
