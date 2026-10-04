# Watsons 风控一 → 风控二最小链路

日期：2026-10-04

## 本次修复

- 新增 `runWatsonsDemoPaymentRisk` 直接函数入口，把 Watsons 已选候选依次送入风控一计价和风控二金额审核，不使用 HTTP。
- 搜索侧传来的唯一金额事实是 `candidate.offer.priceHkd`。风控一核对商品选择结果后计算 `totalHkd = priceHkd × quantity`，不读取预算，也不根据金额放行或拒绝。
- 风控一注入 Mock 虚拟信用卡 `demo-virtual-credit-card`，HKD 结算，手续费 0、优惠 0、运费 0。`billingTotal` 是该卡的模拟扣款金额，并与 `totalHkd = 商品价 × 数量` 相等。
- Watsons 缺少的商户、运费和配送事实不再阻断黑客松链路；这些事实没有被伪造成 verified，只是在此显式 Demo 入口中排除。
- 风控二移除库存/配送判断，只检查风控一生成的总价、用户额度、Offer、数量、币种、支付方式、授权有效期、任务版本和计价有效期。

## 数据边界

```text
Watsons Search
  └─ ProductHandoff（商品事实 + priceHkd）
       ↓
Risk 1
  ├─ 复用 productCheck 的商品信息核对结果
  ├─ 注入 demo-virtual-credit-card
  └─ OrderAmount.totalHkd = priceHkd × quantity
       ↓
Risk 2
  └─ totalHkd <= authorization.maxTotalHkd ? approved : blocked
       ↓
UI 模拟下单（仅 approved）
```

## 安全范围

- 入口名称含 `Demo`，内部强制使用 `mock-dataset` 证据；不支持真实下单或真实支付。
- 通用 `runPaymentRisk` 和 `preparePaymentHandoff` 保留，正式接入真实结账事实时仍可替换 Mock 计价。
- 未伪造 Watsons 的商户、配送、库存或运费来源。

## 验证

- `node --test tests/payment-risk.test.mjs`
- `node examples/payment-risk-demo.mjs`
- `node examples/payment-risk-demo.mjs --limit 200`

验证结果：相关测试 9/9 通过；Lint、TypeScript 和 Next.js 生产构建通过。全量测试业务断言 257 项通过，另 7 项仅因 Windows 清理临时 SQLite 目录时返回 `EPERM` 而被测试运行器标记失败。
