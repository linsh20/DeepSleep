# 多平台护肤品 Demo 调用说明

## 交付内容

| 文件 | 用途 |
| --- | --- |
| `data/watson/data/products.demo-multiplatform.db` | 多平台 SQLite 数据库副本 |
| `data/watson/create_multiplatform_demo.sql` | 从原始 `products.db` 重建副本的 SQL |
| `data/watson/run_multiplatform_demo.ps1` | 使用 Demo 数据库启动本地服务 |
| `examples/multiplatform-moisturizer.request.json` | Moisturizer API 请求样例 |
| `examples/multiplatform-toner.request.json` | Toner API 请求样例 |

## 数据范围

演示品类为：

1. `Moisturizer`：保湿面霜/乳液。
2. `Toner`：爽肤水/化妆水。

`products` 表保留 355 条原始商品主数据，商品 `code` 不增加平台后缀。`product_offers` 表包含 403 条报价，其中 355 条来自 Watsons 快照，48 条是 SaSa/Mannings Demo 报价。每个选定品类选择 12 个商品，并为每个商品增加两个平台报价。

Demo 定价规则：SaSa 为 Watsons 快照价的 94%，Mannings 为 Watsons 快照价的 103%。这些价格不是实时商城价格。

## 身份字段规则

同一件商品在不同平台必须保持相同的 `productId` 和 `skuId`，只让 `offerId`、平台、商户和价格发生变化：

| 字段 | 规则 |
| --- | --- |
| `products.code` / `productId` | 稳定商品身份，跨平台不变 |
| `product_offers.sku_code` / `skuId` | 稳定 SKU 身份，跨平台不变 |
| `product_offers.offer_id` / `offerId` | 每个平台唯一 |
| `platform_id` | `watsons-hk`、`sasa-hk` 或 `mannings-hk` |
| `fact_source` / `fact_status` | Watsons 为已验证快照；新增平台为 `mock-dataset` / `mock` |

## 启动

要求 Node.js 22.13+。在仓库根目录执行：

```powershell
.\data\watson\run_multiplatform_demo.ps1
```

脚本只为当前进程设置：

```text
WATSONS_DB_PATH=data/watson/data/products.demo-multiplatform.db
```

也可以手动设置环境变量后执行 `npm run dev`。服务默认地址为 `http://localhost:3000`。

## 调用搜索接口

另开一个 PowerShell 终端，在仓库根目录执行 Moisturizer 示例：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/api/products/search" `
  -ContentType "application/json" `
  -InFile ".\examples\multiplatform-moisturizer.request.json"
```

Toner 示例：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/api/products/search" `
  -ContentType "application/json" `
  -InFile ".\examples\multiplatform-toner.request.json"
```

响应中的平台路径为：

```text
candidates[].candidate.merchant.platformId.value
```

同一商品的多个结果应具有相同 `productId`/`skuId` 和不同 `offerId`。金额字段 `offer.itemPriceMinor.value` 使用 HKD 最小货币单位，例如 `12972` 表示 HKD 129.72。

## 代码调用链

1. `app/api/products/search/route.ts` 接收 HTTP 请求。
2. `services/product-search.ts` 执行召回、规范化、过滤、去重和排序。
3. `services/watsons-product-provider.ts` 检测 `product_offers` 表并读取多平台报价。
4. `services/shopping-agent.ts` 将平台商户信息交给 Agent B；报价、配送和购买授权仍需后续可信校验。

## 重新生成数据库

如需从当前原始数据库重建副本，先删除旧副本，然后复制原库并执行 SQL：

```powershell
Copy-Item ".\data\watson\data\products.db" `
  ".\data\watson\data\products.demo-multiplatform.db"

sqlite3.exe ".\data\watson\data\products.demo-multiplatform.db" `
  ".read data/watson/create_multiplatform_demo.sql"
```

不要对已经包含 `product_offers` 表的副本重复执行生成 SQL。

## 验证

```powershell
npm test
npm run lint
npx tsc --noEmit
npm run build
```

SQLite 快速检查：

```powershell
sqlite3.exe -readonly ".\data\watson\data\products.demo-multiplatform.db" `
  "PRAGMA integrity_check; PRAGMA foreign_key_check;"
```
