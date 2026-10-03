# Agent B 支付方式优化与主 Agent 对接

实现位置：`lib/agent-b/payment.ts`。公共类型：`types/index.ts`。

本轮已确认目标：**当下扣款最低**。B 在已通过选品审核、报价完整的订单上，比较即时优惠、信用卡结算汇率及手续费。未来返现只展示，不抵减预算、不参与排序或同价决胜。输出属于支付建议，最终支付仍由风控和执行模块处理。

## 1. 调用与输出

已有 B 入口支持可选的 `paymentContext`：

```ts
const result = await evaluateShoppingCandidates({
  ...evaluationInput,
  paymentContext, // 主 Agent 提供，须绑定当前商品、报价、任务和需求版本
}, policy)

const payment = result.paymentOptimization
const recommendedCardId = payment?.recommended?.cardId
const paymentChannel = payment?.recommended?.paymentChannel
```

未传 `paymentContext` 时，保持原选品调用方式，输出也不新增支付结果。传入后，在 `result.paymentOptimization` 和 `result.decisionRecord.paymentOptimization` 中返回比较结果。决策记录另存 `paymentContextSnapshot`，便于按当时证据回答“为什么选这张卡”。日志持久化仍由主 Agent/存储服务负责。

`createContractShoppingAgent(...).run({ requirement, quantity, paymentContext })` 也已支持相同流程。支付上下文只交给 B，不会被转发给 A 的搜索或补查接口。

通常使用两步接入：先由 A/B 确定商品及完整到手价，再由主 Agent 获取与该报价匹配的信用卡条款，重新调用 B。支付方案不改变商品排序，不进行“商品 × 卡片”的联合选品。

也可以独立调用：

```ts
import { optimizePaymentMethods } from "../lib/agent-b/payment"

const result = optimizePaymentMethods(qualifiedOrder, paymentContext, {
  policyVersion: "payment-v1",
  dataEnvironment: "verified_sources",
})
```

独立入口要求调用方先完成商品资格核验；它检查报价、支付条款和预算，不重复获取商品库存等事实。`qualifiedOrder` 类型是 `PaymentOrder`，不是数据库正式订单，也不生成 `order_id`。

## 2. 主 Agent 需要提供的字段

| 路径 | 含义与单位 | 来源/要求 |
| --- | --- | --- |
| `taskId`、`requirementVersion` | 当前任务与需求版本 | 主 Agent 服务端，与 B 请求一致 |
| `quote` | `productId/skuId/offerId/quantity/destination/currency/totalMinor` | 绑定当前已选商品和完整报价；任何一项改变都需重取条款 |
| `methods[].optionId` | 唯一支付方案引用 | 主 Agent；同一卡片不同优惠组合使用不同 optionId |
| `methods[].cardId` | 用户可用信用卡的非敏感引用 | 用户服务/主 Agent，不传完整卡号、CVV、支付密钥 |
| `methods[].label` | 展示名称，例如“卡 A” | 主 Agent |
| `methods[].paymentChannel` | 团队约定的支付渠道编码 | 主 Agent/支付模块；映射到订单的 `payment_channel` |
| `methods[].billingCurrency` | 卡片账单币种 | 主 Agent 核实，例如 CNY/HKD |
| `methods[].eligible` | `Fact<boolean>`，是否适用于此用户和订单 | 上游确认卡片可用、商户支持、会员/报名/有效期/优惠组合等适用条件 |
| `methods[].settlementRate` | `Fact<string>`，1 单位订单币种兑换多少账单币种 | 主 Agent 获取该卡适用的结算汇率；十进制字符串，例如 HKD→CNY 为 `"0.92"` |
| `methods[].feeBps` | `Fact<number>`，扣款本金上的总手续费率 | 整数基点，100=1%；确认无手续费才填 0 |
| `methods[].fixedFeeMinor` | `Fact<number>`，整笔固定费用 | **账单币种**最小单位；整单收一次 |
| `methods[].instantOffer` | `Fact<PaymentInstantOffer>` | 本次仍可额外使用的即时优惠，见下文；不能重复扣除商品报价已含优惠 |
| `methods[].futureCashbackMinor` | 可选 `Fact<number>` | **订单币种**最小单位；已经核实适用的预计未来返现，未知可传 null |
| `comparisonRates[]` | `fromCurrency/toCurrency/rate` | 主 Agent 获取的统一参考汇率，方向为账单币种→订单币种，每种币对只传一条 |

每项 `Fact` 必须有 `value/source/fetchedAt/status`，可选 `validUntil`。未知值为 `null`；无即时优惠需明确提供 0 规则，不能用 null 表示无优惠。错误数据抛出 `PaymentInputError`，`code=INVALID_INPUT`；过期或待核实的事实返回待核验结果。

默认支付事实有效期为 5 分钟，购买预检查缩短至最多 1 分钟；数据源 validUntil 只能进一步缩短有效期。服务端可通过 `policy.payment.factTtlMs/currencyMinorUnits` 配置契约版入口，独立入口直接传同名策略字段。

同币种时 `settlementRate=null` 表示无需换汇，系统使用 1；跨币种的 null 表示缺汇率。参考汇率由所有卡片共享，不能对每张卡分别取自身结算汇率的倒数，否则卡片的汇率价差会被抵消。

即时优惠结构：

```ts
{
  minSpendMinor: 20000, // 订单币种，优惠前整单金额达到 200 元
  rateBps: 1000,        // 减免 10%，不是“支付 10%”
  amountMinor: 0,       // 附加固定减免，订单币种
  capMinor: 1500        // 本次有效减免上限；null 表示已确认没有封顶
}
```

`capMinor` 应由主 Agent 依据条款和账户情况提供，例如“单次上限”和“剩余月度额度”取较小者。额度未核实时，不应擅自填 null。上游须保证优惠只依赖已解析的条件，适用资格未知时 `eligible.value=null`。

确认无优惠的规则为 `{ minSpendMinor: 0, rateBps: 0, amountMinor: 0, capMinor: null }`。支持已确认可同时适用的比例加固定减免；不自动叠加不同 `optionId`。如果优惠不能叠加，将它们分别建成方案。分期、积分/里程估值、未来账单返现、按分段计算的复杂优惠需上游适配，不应放入即时减免。

## 3. 计算规则

1. 商品到手价已经包含 A 的商品优惠、运费和其他费用。没有完整且一致的整单报价时，不做支付比较。
2. 达到即时优惠门槛后，减免为 `floor(整单金额 × rateBps / 10000) + amountMinor`，受 capMinor 和订单金额双重封顶。
3. 减免后的金额按卡片结算汇率转换成账单币种本金。
4. 计算 `ceil(本金 × feeBps / 10000) + fixedFeeMinor`，加到本金上得到 `chargeMinor`。
5. 使用统一参考汇率，将各卡的扣款折算为订单币种，得到 `comparisonChargeMinor`，按它从低到高排序。
6. 同价按 `optionId` 稳定选择，不使用返现作为决胜项。

金额全用安全整数，内部使用 BigInt 比例计算。换汇和费用向上取整到目标最小货币单位，即时优惠向下取整，避免低估扣款。这里是明确的估算规则；若发行行实际舍入或费用计提基数不同，需由主 Agent 适配或补充实际支付报价，并在最终风控时核对。

默认币种位数：HKD/CNY/USD/EUR/GBP 为 2，JPY 为 0。其他币种由服务端 `currencyMinorUnits` 配置，未知币种报错。契约版商品审核仍只支持 HKD 订单，新增能力支持该订单用不同账单币种信用卡支付，并未改变商品端币种限制。

`delivered` 预算同时限制商品原始到手价和支付费用后的折算扣款。原订单已超预算时不能用卡片优惠补救选品通过。`item` 预算仍只限制商品小计；若另需支付总限额，应传给独立支付入口的 `maxUpfrontMinor` 或使用购买预检查中的后端授权上限。

## 4. 输出字段

| 输出 | 说明 |
| --- | --- |
| `status` | `ready / needs_verification / no_available_method / not_evaluated` |
| `objective` | 固定为 `lowest_upfront_charge` |
| `recommended.cardId/optionId/paymentChannel` | 最终选中的信用卡引用、方案和渠道 |
| `recommended.billingCurrency` | 账单币种 |
| `recommended.costs.instantDiscountMinor` | 本次即时减免，订单币种 |
| `recommended.costs.orderPayableMinor` | 即时减免后的商品整单金额，订单币种 |
| `recommended.costs.convertedPrincipalMinor` | 换汇后本金，账单币种 |
| `recommended.costs.feeMinor` | 支付手续费，账单币种 |
| `recommended.costs.chargeMinor` | 预计实际扣款，账单币种 |
| `recommended.costs.comparisonChargeMinor` | 用于统一比较的扣款，订单币种 |
| `recommended.costs.futureCashbackMinor` | 已知未来返现，订单币种；不从上述金额扣除 |
| `recommended.explanation/evidenceFields/validUntil` | 选择理由、证据路径、决策有效截止时间 |
| `comparisonComplete` | 是否每个提交方案都已能判断；false 时只能称“已核实方案中最优” |
| `evaluations` | 各方案的费用明细、合格/不适用/待核验状态和原因 |
| `verificationRequests` | 需要主 Agent 补充的支付信息，不发给商品搜索 A |
| `orderSnapshot/checkedAt/policyVersion` | 对应订单报价、审核时间、规则版本 |

状态处理：

| 状态 | 主 Agent 下一步 |
| --- | --- |
| `ready` | 展示推荐卡片和扣款；若 comparisonComplete=false，一并说明有卡片待核验 |
| `needs_verification` | 根据 fields 补查汇率、手续费、资格或与订单匹配的支付条款 |
| `no_available_method` | 说明无卡、所有方案不适用或超预算，向用户请求其他方式/调整需求 |
| `not_evaluated` | 先完成商品审核及完整报价，再获取支付条款 |

支付子状态与选品状态分别返回。例如 `result_ready` + 支付 `needs_verification` 表示商品已选出但信用卡信息尚不完整。不会把信用卡信息错误加入 A 的商品补查循环。

## 5. 可复制的模拟输入

以下只演示字段口径，所有汇率和优惠均为人工示例，不代表真实银行条款：

```ts
const mock = <T>(value: T) => ({
  value, source: "mock-dataset", fetchedAt: new Date().toISOString(), status: "mock" as const,
})
const paymentContext = {
  taskId: "task", requirementVersion: 1,
  quote: { productId: "p", skuId: "s", offerId: "o", quantity: 1,
    destination: "香港", currency: "HKD", totalMinor: 20000 },
  methods: [
    { optionId: "hkd", cardId: "card-a", label: "卡 A", paymentChannel: "credit_card",
      billingCurrency: "HKD", eligible: mock(true), settlementRate: null,
      feeBps: mock(0), fixedFeeMinor: mock(0),
      instantOffer: mock({ minSpendMinor: 0, rateBps: 0, amountMinor: 0, capMinor: null }),
      futureCashbackMinor: mock(10000) },
    { optionId: "cny", cardId: "card-b", label: "卡 B", paymentChannel: "credit_card",
      billingCurrency: "CNY", eligible: mock(true), settlementRate: mock("0.92"),
      feeBps: mock(100), fixedFeeMinor: mock(100),
      instantOffer: mock({ minSpendMinor: 20000, rateBps: 1000, amountMinor: 0, capMinor: 1500 }) },
  ],
  comparisonRates: [{ fromCurrency: "CNY", toCurrency: "HKD", rate: mock("1.08") }],
}
// 在 development_mock 模式，且商品报价也符合 quote 时：
// 卡 A 当下扣款 HK$200.00，未来返现不扣除。
// 卡 B 先减 HK$15.00，再换汇：CNY170.20 + 手续费CNY2.71 = CNY172.91。
// 卡 B 统一折算 HK$186.75，成为推荐方式。
```

## 6. 团队接入事项和现有限制

| 编号 | 对接方 | 需要确认/提供 |
| --- | --- | --- |
| P-01 | 主 Agent | 按上述 PaymentContext 传入处理后的条款及 Fact；目前未接银行接口或信用卡录入页面 |
| P-02 | 主 Agent/支付服务 | 明确两种汇率的方向、有效期及来源；参考汇率须统一，不按各卡反推 |
| P-03 | 主 Agent/优惠服务 | 确认会员、报名、名额、剩余额度和叠加条件；每个 optionId 为已知适用组合 |
| P-04 | 最终风控 | 接收 cardId、optionId、paymentChannel、双币种金额、证据和有效期，并按真实订单/授权复核；不得只看 ready 就扣款 |
| P-05 | 订单/存储 | 保留商户订单总价和支付扣款的区别；汇兑及卡片费用不要重复写入商品单价或重复计费 |
| P-06 | 主 Agent/日志 | 持久化扩展后的 decisionRecord，保存选卡原因与当时条款；当前函数只返回快照 |
| P-07 | 搜索/B维护者 | 本轮基于现有 B 分支 e904284 开发；已读取 origin/main 的 fe13e52，该版本使用新的搜索类型并删除旧 B。合并到 main 前需先确定新搜索结果→B 契约适配，不能直接覆盖 types/index.ts |

新模块没有修改数据库表，不获取完整卡号，不生成订单，不扣款。`checkShoppingPurchase` 传入支付上下文时，会额外按用户预算和后端授权金额检查含支付费用的扣款，并返回支付建议；未传时保留已有行为。该接口历史 `approved` 命名仍是预检查结果，尚未统一重命名，不能作为最终支付许可。

验证覆盖：跨币种、JPY/自定义币种精度、即时优惠门槛/封顶/取整、手续费、返现不参与比较、过期/未知条款、报价与版本变化、缺卡、mock、输入校验、溢出、稳定排序、不可变日志、B 集成、支付信息不转发 A，以及购买前预算/授权上限。

本轮验证结果：全量 `npm test` 77 项通过（支付相关新增 17 项）；`npm run lint`、`tsc --noEmit`、`npm run build` 均通过。这些验证针对当前 B 功能分支，不代表已完成与远端新版 main 的联调。
