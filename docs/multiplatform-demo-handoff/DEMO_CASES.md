# 两个个性化需求 Demo 案例

## “个性化授权书”的实际入口

目前代码里没有可为这两种真实护肤品签署购买授权的“个性化授权书”。本演示的最前端需求入口是 `/agent` 的“结构化表单模式”，用于保存用户的**购物偏好与比较需求**；它不是付款许可。另一页 `/agent-risk` 是沙盒有限购买授权，商品范围仍限 `sandbox-lotion`。主持人不要在该页为本演示商品勾选授权，也不要点购买执行。

每个案例先点击“开始新任务”，选择“意图：比较方案”，填写下表，点击“保存需求并校验”，待缺失字段清空后点击“运行 Shopping 搜索与审核”。如页面要求补充信息，按表中字段补齐；不要让模型推断未提供的肤质、成分安全性或真实库存。

| 表单字段 | 案例 1：Moisturizer | 案例 2：Toner |
| --- | --- | --- |
| 用户口述需求 | 我想比较这款保湿面霜在不同平台的商品价格，预算 200 港币，买 1 件，配送香港。 | 我想比较这款爽肤水在不同平台的商品价格，预算 200 港币，买 1 件，配送香港。 |
| 意图 | `比较方案` | `比较方案` |
| 类别 | `Moisturizer` | `Toner` |
| 商品与规格 | `BIRCH JUICE MOISTURIZING CREAM 80ml` | `LIGHTENING AND MOISTURIZING TONER 120ML` |
| 币种 | `HKD` | `HKD` |
| 预算上限（HKD 元） | `200` | `200` |
| 预算口径 | `商品金额` | `商品金额` |
| 数量 | `1` | `1` |
| 配送地区 | `香港` | `香港` |

以上用**商品金额**口径展示数据库中已有的价格差异，不把商品金额误称为含运费总额。填写“香港”是完整需求的一部分，不能据此宣称平台已经确认可配送。

## 案例 1：保湿面霜

目标商品的原始数据库 `code` 为 `BP_119795`。在候选或接口响应中核对同一 `productId`/`skuId` 的 Watsons、SaSa、Mannings 三个独立 `offerId`。数据库样例商品单价分别为 HKD 138.00、129.72、142.14；价格仅供演示，不能代表当前平台价格。可向观众说明：“系统能保留商品身份并对比三个平台的单价，但还要核验运费、库存和结账价。”

## 案例 2：爽肤水

目标商品的原始数据库 `code` 为 `BP_235677`。同样核对三平台报价。数据库样例商品单价分别为 HKD 158.00、148.52、162.74；同样仅供演示。可向观众说明：“切换细分类别后，同一套身份字段与审核流程仍工作，模拟报价不会被当作可付款事实。”

## 演示成功的判定

主 Agent 页面应显示当前任务的需求版本、实际 Shopping 请求及审核结果。候选数量和排序可能受筛选、评分与事实核验影响，不应承诺 UI 前三名必是同一商品的三个报价。**确定性检查三平台报价**请调用随库提供的两个搜索请求样例：

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/products/search" -ContentType "application/json" -InFile ".\examples\multiplatform-moisturizer.request.json"
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/products/search" -ContentType "application/json" -InFile ".\examples\multiplatform-toner.request.json"
```

可看到目标商品三个报价，以及 `candidate.merchant.platformId.value` 的 `watsons-hk`、`sasa-hk`、`mannings-hk`。未配置 LLM 时搜索状态可能是 `partial`；主 Agent/Agent B 对未核实结账事实返回 `needs_verification`，均不代表数据库读取失败。
