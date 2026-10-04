# 前端开发指导：个性化购物授权书页面

## 1. 目标与范围

本页面参考产品稿中的居中授权书弹窗、三步进度条、分区表单、风险声明和签名确认。产品稿只用于视觉和交互参考；字段、枚举、校验和提交行为以本文为准。

页面服务两个 Demo Case：

1. `moisturizer-auto-purchase-v1`：保湿面霜/乳液。
2. `toner-auto-purchase-v1`：爽肤水/化妆水。

用户完成授权后，系统目标行为是在品类、商户、配送、预算、有效期和支付方式范围内自动选择、下单及支付。超过软边界必须暂停并取得单次确认；超过硬边界必须阻止，前端不能提供绕过按钮。金额等于边界时仍在边界内。

## 2. 页面结构

使用单个 Modal 或全屏 Dialog，桌面端最大宽度建议 `960–1080px`，移动端使用全屏抽屉。顶部固定三步进度：

| 步骤 | 标题 | 内容 |
| --- | --- | --- |
| 1 | 委托人信息 | 授权人、肤质、禁用成分、授权日期 |
| 2 | 委托授权信息 | 目标商品、品类与渠道白名单、配送、数量、预算、有效期、支付方式、自动执行开关 |
| 3 | 签名确认 | 授权摘要、风险声明、签名、明确同意 |

底部操作按钮：

- 步骤 1：`取消`、`下一步`。
- 步骤 2：`返回`、`下一步`。
- 步骤 3：`返回`、`签署并提交`。
- 关闭按钮：有未保存内容时弹出“放弃本次填写？”；不得在关闭时隐式提交。
- 提交期间按钮显示 loading 并禁用重复提交；成功后展示授权编号和版本。

## 3. 完整字段清单

### 3.1 系统与幂等字段

这些字段不让用户编辑，但必须随草稿或请求保存。

| 字段 | 类型 | 来源 | 规则 |
| --- | --- | --- | --- |
| `caseTemplateId` | enum | 路由或“选择 Demo”按钮 | 两个 Case ID 之一 |
| `requestId` | string | `crypto.randomUUID()` | 一次提交固定一个值；网络重试复用原值 |
| `expectedVersion` | integer | 服务端当前授权 | 首次为 `0`；更新使用最新版本；冲突后重新读取 |
| `schemaVersion` | literal | 前端常量 | 当前建议 `authorization-form-v1` |
| `authorizedPartyId` | literal | 服务端配置 | `deepsleep-shopping-agent` |
| `authorizedPartyName` | string | 服务端配置 | 展示为“DeepSleep 购物代理”，只读 |
| `currency` | literal | Case 模板 | `HKD`，只读 |

### 3.2 第一步：委托人信息

| 字段 | 标签/控件 | 必填 | 校验及存储 |
| --- | --- | --- | --- |
| `principal.displayName` | 授权人；单行文本 | 是 | 去首尾空格后 1–80 字；不要用作身份认证凭据 |
| `principal.skinType` | 肤质；单选按钮组 | 是 | `dry`、`oily`、`combination`、`sensitive`、`normal` 五选一 |
| `principal.excludedIngredients` | 禁用成分；可新增标签的多值输入 | 是 | 允许填写“无”；内部“无”存为空数组，不存成成分名；单项 1–50 字，去重，最多 20 项 |
| `startsAt` | 授权日期；只读日期 | 是 | 页面显示当天；权威时间由服务端在创建授权时生成，客户端值不可作为审计时间 |

控件展示文案：如果没有禁用成分，用户点击“无禁用成分”快捷按钮并清空标签。不要强迫用户输入字符串“无”。

### 3.3 第二步：委托授权信息

| 字段 | 标签/控件 | 必填 | 校验及存储 |
| --- | --- | --- | --- |
| `purpose` | 委托目的；只读说明框 | 是 | 由 Case 模板生成，用户可阅读但不可改写执行规则 |
| `target.databaseCode` | 数据库商品编码；隐藏或只读 | 是 | Case 1 `BP_119795`；Case 2 `BP_235677` |
| `target.productId` | 稳定商品 ID；隐藏字段 | 是 | 跨平台保持不变；见 Case 模板 |
| `target.skuId` | 稳定 SKU ID；隐藏字段 | 是 | 跨平台保持不变；见 Case 模板 |
| `target.productName` | 目标商品与规格；只读文本框 | 是 | 使用 Case 模板中的准确商品名 |
| `target.quantity` | 数量；步进输入 | 是 | 安全整数，Demo 固定为 `1` |
| `scope.categoryIds` | 品类白名单；复选卡片 | 是 | 至少一项；Demo 分别固定勾选 `moisturizer` 或 `toner` |
| `scope.merchantPlatformIds` | 商户渠道白名单；复选卡片 | 是 | 至少一项；可选 `watsons-hk`、`sasa-hk`、`mannings-hk` |
| `destination.code` | 配送地区；单选按钮 | 是 | Demo 使用 `HK` |
| `destination.label` | 配送地区展示名 | 是 | `中国香港`，由 `code` 派生，不单独信任客户端 |
| `budget.scope` | 预算口径；单选 | 是 | 自动支付使用 `delivered`（含运费整单总额） |
| `budget.monthlySoftMinor` | 月度软边界；金额输入 | 是 | HKD 元输入，提交转港仙整数 |
| `budget.monthlyHardMinor` | 月度硬边界；金额输入 | 是 | `monthlySoftMinor <= monthlyHardMinor` |
| `budget.singleSoftMinor` | 单笔软边界；金额输入 | 是 | HKD 元输入，提交转港仙整数 |
| `budget.singleHardMinor` | 单笔硬边界；金额输入 | 是 | `singleSoftMinor <= singleHardMinor`；当前后端最大 HKD 200 |
| `expiresAt` | 授权有效期至；日期/时间控件 | 是 | 必须晚于 `startsAt` 和当前时间 |
| `scope.paymentMethodIds` | 支付渠道白名单；复选卡片 | 是 | Demo 只选 `stripe_test_card`；UI 展示“VISA（Stripe 沙盒测试卡）” |
| `allowAutomaticPurchase` | 允许自动下单与支付；开关 | 是 | 必须为 `true` 才能提交自动支付授权 |

金额输入规范：用户输入 HKD 元，最多两位小数；前端使用十进制字符串校验，再转换为港仙整数。不要使用浮点数乘法后直接提交，也不要把空值当成 `0`。

### 3.4 第三步：风险声明与签名

| 字段 | 标签/控件 | 必填 | 校验及存储 |
| --- | --- | --- | --- |
| `consent.riskAccepted` | 已阅读风险声明；checkbox | 是 | 必须为 `true` |
| `consent.scopeAccepted` | 同意授权范围内自动执行；checkbox | 是 | 必须为 `true` |
| `consent.signatureType` | 签名方式 | 是 | Demo 可用 `drawn` 或 `typed` |
| `consent.signedName` | 签名姓名；文本或签字板确认名 | 是 | 应与授权人一致；不同则要求重新确认 |
| `consent.signatureData` | 签名数据 | 条件必填 | `drawn` 时保存签名文件引用或受控数据，不把无限长 base64 放进授权 API |
| `consent.signedAt` | 签署时间 | 是 | 点击提交时由服务端生成；客户端仅展示 |
| `explicitlyConfirmed` | 明确确认 | 是 | 最终提交固定传 `true`，不能由默认勾选产生 |

风险声明至少显示：

1. 在白名单、有效期和软边界内，系统可自动下单及使用已授权支付方式。
2. 超过软边界会暂停并要求单次确认；硬边界不可通过普通确认绕过。
3. 最终支付前仍会校验授权版本、实时报价、商品、商户、支付方式和风控状态。
4. 当前 SaSa、Mannings 为模拟报价，Watsons 为历史快照；Demo 报价不能直接作为真实扣款金额。
5. 用户可以撤销后续授权；撤销不等于取消或退款已完成交易。

## 4. 两个 Case 的预填数据

| 字段 | Moisturizer Case | Toner Case |
| --- | --- | --- |
| `caseTemplateId` | `moisturizer-auto-purchase-v1` | `toner-auto-purchase-v1` |
| 授权人 | 陈同学（Demo 用户 A） | 林同学（Demo 用户 B） |
| 肤质 | `dry` / 干性 | `combination` / 混合性 |
| 禁用成分 | 酒精、变性酒精、乙醇、香精 | 酒精、变性酒精、乙醇、香精 |
| 数据库商品编码 | `BP_119795` | `BP_235677` |
| 稳定商品 ID | `watsons-product:BP_119795` | `watsons-product:BP_235677` |
| 稳定 SKU ID | `watsons-sku:119795` | `watsons-sku:235677` |
| 目标商品 | `BIRCH JUICE MOISTURIZING CREAM 80ml` | `LIGHTENING AND MOISTURIZING TONER 120ML` |
| 品类白名单 | `moisturizer` / 面霜 | `toner` / 爽肤水 |
| 渠道白名单 | `watsons-hk`、`sasa-hk`、`mannings-hk` | 同左 |
| 数量 | `1` | `1` |
| 配送地区 | `HK` / 中国香港 | 同左 |
| 预算口径 | `delivered` / 含运费总额 | 同左 |
| 月度软/硬边界 | HKD 500 / 800 | HKD 500 / 800 |
| 单笔软/硬边界 | HKD 180 / 200 | HKD 180 / 200 |
| 授权日期 | 2026-10-04 | 2026-10-04 |
| 有效期至 | 2026-12-31 23:59:59（香港时间） | 同左 |
| 支付方式 | `stripe_test_card` / VISA 沙盒测试卡 | 同左 |
| 自动执行 | 开启 | 开启 |

Case 1 数据库商品单价：Watsons 138.00、SaSa 129.72、Mannings 142.14。Case 2：Watsons 158.00、SaSa 148.52、Mannings 162.74。它们都低于单笔软边界，但是否自动执行必须以最终含运费总额及服务端检查为准。

## 5. 建议的前端表单模型

```ts
type SkinType = "dry" | "oily" | "combination" | "sensitive" | "normal"
type CategoryId = "moisturizer" | "toner"
type MerchantPlatformId = "watsons-hk" | "sasa-hk" | "mannings-hk"
type PaymentMethodId = "stripe_test_card"

type AuthorizationFormV1 = {
  schemaVersion: "authorization-form-v1"
  caseTemplateId: "moisturizer-auto-purchase-v1" | "toner-auto-purchase-v1"
  requestId: string
  expectedVersion: number
  authorizedPartyId: "deepsleep-shopping-agent"
  principal: {
    displayName: string
    skinType: SkinType
    excludedIngredients: string[]
  }
  startsAt: number
  expiresAt: number
  purpose: string
  target: {
    databaseCode: string
    productId: string
    skuId: string
    productName: string
    quantity: 1
  }
  scope: {
    categoryIds: CategoryId[]
    merchantPlatformIds: MerchantPlatformId[]
    paymentMethodIds: PaymentMethodId[]
  }
  destination: { code: "HK"; label: "中国香港" }
  budget: {
    currency: "HKD"
    scope: "delivered"
    monthlySoftMinor: number
    monthlyHardMinor: number
    singleSoftMinor: number
    singleHardMinor: number
  }
  allowAutomaticPurchase: true
  consent: {
    riskAccepted: true
    scopeAccepted: true
    signatureType: "drawn" | "typed"
    signedName: string
    signatureData?: string
  }
  explicitlyConfirmed: true
}
```

建议把两个模板作为前端 fixture 或由服务端模板接口读取，不要在多个组件中重复硬编码。

## 6. 示例提交对象

Moisturizer Case（时间戳由实现按香港时间正确生成）：

```json
{
  "schemaVersion": "authorization-form-v1",
  "caseTemplateId": "moisturizer-auto-purchase-v1",
  "requestId": "<uuid>",
  "expectedVersion": 0,
  "authorizedPartyId": "deepsleep-shopping-agent",
  "principal": {
    "displayName": "陈同学",
    "skinType": "dry",
    "excludedIngredients": ["酒精", "变性酒精", "乙醇", "香精"]
  },
  "startsAt": 1791043200000,
  "expiresAt": 1798732799000,
  "purpose": "在授权范围内自动筛选、购买并支付保湿面霜/乳液",
  "target": {
    "databaseCode": "BP_119795",
    "productId": "watsons-product:BP_119795",
    "skuId": "watsons-sku:119795",
    "productName": "BIRCH JUICE MOISTURIZING CREAM 80ml",
    "quantity": 1
  },
  "scope": {
    "categoryIds": ["moisturizer"],
    "merchantPlatformIds": ["watsons-hk", "sasa-hk", "mannings-hk"],
    "paymentMethodIds": ["stripe_test_card"]
  },
  "destination": { "code": "HK", "label": "中国香港" },
  "budget": {
    "currency": "HKD",
    "scope": "delivered",
    "monthlySoftMinor": 50000,
    "monthlyHardMinor": 80000,
    "singleSoftMinor": 18000,
    "singleHardMinor": 20000
  },
  "allowAutomaticPurchase": true,
  "consent": {
    "riskAccepted": true,
    "scopeAccepted": true,
    "signatureType": "typed",
    "signedName": "陈同学"
  },
  "explicitlyConfirmed": true
}
```

Toner Case 只替换以下值，其他字段保持一致：

```json
{
  "caseTemplateId": "toner-auto-purchase-v1",
  "principal": {
    "displayName": "林同学",
    "skinType": "combination",
    "excludedIngredients": ["酒精", "变性酒精", "乙醇", "香精"]
  },
  "purpose": "在授权范围内自动筛选、购买并支付爽肤水/化妆水",
  "target": {
    "databaseCode": "BP_235677",
    "productId": "watsons-product:BP_235677",
    "skuId": "watsons-sku:235677",
    "productName": "LIGHTENING AND MOISTURIZING TONER 120ML",
    "quantity": 1
  },
  "scope": {
    "categoryIds": ["toner"],
    "merchantPlatformIds": ["watsons-hk", "sasa-hk", "mannings-hk"],
    "paymentMethodIds": ["stripe_test_card"]
  },
  "consent": {
    "riskAccepted": true,
    "scopeAccepted": true,
    "signatureType": "typed",
    "signedName": "林同学"
  }
}
```

## 7. 与现有后端的映射和缺口

现有 `POST /api/agent/risk/authorization` 只接受：

```ts
{
  requestId: string
  expectedVersion: number
  explicitlyConfirmed: true
  terms: {
    startsAt: number
    expiresAt: number
    singleSoftMinor: number
    singleHardMinor: number
    monthlySoftMinor: number
    monthlyHardMinor: number
    productIds: string[]
    merchantIds: string[]
    paymentMethods: string[]
  }
}
```

因此前端**不能直接把完整表单对象发送给该接口**，否则会因额外字段或不支持的 scope 被拒绝。接入前需要后端完成以下任一方案：

1. 扩展授权模型和接口，原生保存 `principal`、肤质、禁用成分、品类、平台、配送、预算口径、目标商品及签名引用；或
2. 新增“个性化授权档案”接口保存完整表单，再由服务端经过受审适配器生成风险授权 `terms`。

当前风险配置只认可 `sandbox-lotion` / `demo-shopping-lotion`、`demo-merchant` 和 `stripe_test_card`。前端严禁做以下伪映射：

- 不得把 `BP_119795` 或 `BP_235677` 改写成 `sandbox-lotion`。
- 不得把 Watsons、SaSa、Mannings 改写成 `demo-merchant`。
- 不得把模拟单价当成实时含运费总额。
- 不得因 UI 显示“授权成功”便直接调用支付；执行门禁仍须在服务端重读最新授权和报价。

后端扩展时建议使用稳定 ID：授权目标保存稳定的 `productId` / `skuId`，实际选定平台报价后再绑定对应 `offerId`，最终执行身份为 `(productId, skuId, offerId)`。商户使用 `watsons-hk`、`sasa-hk`、`mannings-hk`，支付方式使用已令牌化的 `stripe_test_card`。前端永远不收集或提交卡号、CVV、Stripe Secret Key。

## 8. 错误和状态处理

| 场景/错误码 | 前端行为 |
| --- | --- |
| 字段本地校验失败 | 留在当前步骤，聚焦第一个错误；标题汇总错误数量 |
| `STALE_AUTHORIZATION` | 重新获取当前版本，提示用户检查变化后重新签署；不要自动覆盖 |
| `REQUEST_CONFLICT` | 生成新的 `requestId` 仅用于用户明确发起的新提交；不要静默重放不同内容 |
| `UNSUPPORTED_AUTH_SCOPE` | 明确显示“后端尚未接入该商品或平台”，不可替换为别的商品/商户 |
| `AUTH_CONFIRMATION_REQUIRED` | 返回签名确认步骤，要求用户主动勾选并提交 |
| `RISK_HOLD` | 展示本次金额、触发规则、确认有效期和“确认本次例外/拒绝”按钮 |
| `RISK_BLOCK` | 禁止继续支付，展示原因和退出建议；不显示“仍然支付”按钮 |
| 网络超时/500 | 保留草稿；使用同一 `requestId` 重试同一内容；状态未知时先查询服务端 |

授权提交成功只代表授权版本保存成功，不代表商品已下单或支付成功。支付状态必须来自购买操作的服务端状态。

## 9. 无障碍与交互要求

- Dialog 使用 `role="dialog"`、`aria-modal="true"`，打开后焦点进入标题，关闭后回到触发按钮。
- 每组单选/复选使用 `fieldset` + `legend`；必填状态不仅依赖红色星号。
- 错误文本通过 `aria-describedby` 绑定控件，并使用 `aria-live` 宣读提交结果。
- 键盘可完成步骤切换、白名单选择、签名确认和提交；焦点不可逃出 Modal。
- 签字板必须提供“键入姓名”替代方案及“清除签名”按钮。
- 金额同时展示 `HKD`，摘要页显示两位小数；提交值显示/记录为港仙整数。
- 不预先勾选风险同意、签名确认或自动支付开关。

## 10. 前端验收清单

- 两个 Case 均可一键加载模板，且只预填非同意类字段。
- Case 1 只选面霜，Case 2 只选爽肤水；三家渠道均可见并勾选。
- 用户未选择支付方式、未开启自动支付、未同意风险或未签名时无法提交。
- 软边界不得高于硬边界；单笔硬边界超过 HKD 200 时阻止提交并解释当前限制。
- 第三步摘要完整展示用户、目标商品、禁用成分、渠道、地区、数量、四个预算值、有效期和支付方式。
- 返回上一步不丢字段；关闭有未保存确认；重复点击提交只产生一次请求。
- API 冲突、未知状态和不支持 scope 均 fail-closed，不触发支付。
- 前端不保存卡号、CVV、密钥或可复用的真实支付凭据。
- 授权、搜索结果与最终支付状态使用不同文案和视觉状态，避免把“已授权”显示成“已付款”。
