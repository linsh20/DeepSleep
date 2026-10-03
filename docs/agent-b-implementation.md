# Agent B 契约版实现与团队交接

基准：`shopping-contract-template(1).mjs` 的 proposal-v1 和 `agent-b-design.md`。

## 已实现入口

| 入口 | 文件 | 返回内容 |
| --- | --- | --- |
| `evaluateShoppingCandidates(input, policy)` | `lib/agent-b/contract.ts` | 四类状态、最多 1 个首选、逐条件审核、L/U 区间、diagnostics、决策快照 |
| `checkShoppingPurchase(input, policy, context)` | 同上 | approved / blocked / needsVerification；必须查询后端授权并复核全部底线 |
| `explainDecision(record)` | 同上 | 只使用已保存快照生成选品依据，不读取当前商品网页 |
| `createContractShoppingAgent(port, policy, limits).run(request)` | `lib/agent-b/workflow.ts` | 调用注入的 A 搜索和补查，最多 2 轮、超时取消、无进展停止、拒绝旧版本 |

公共类型唯一来源仍为 `types/index.ts`。修改了原 Constraint、Preference、Requirement、Fact、Candidate，新增字段以可选方式兼容旧数据，并增加 `Contract*` 和 `DecisionRecord` 等结构。

新增支付方式优化：主 Agent 可传 `paymentContext`，B 在选出合格且报价完整的商品后返回 `paymentOptimization`，并在 `decisionRecord` 保存支付条款快照和计算结果。目标已确认是当下扣款最低，未来返现不抵扣预算或参与排序。完整字段、计算口径、示例和远端合并差异见 [支付方式优化对接](agent-b-payment.md)。独立入口为 `optimizePaymentMethods(order, context, policy)`。

网页和现有 `services/shopping-agent.ts` 仍走旧入口。新接口已可供团队调用，但当前 A 的 MockProductProvider 不提供新版 quote/merchant，也不支持新版文本条件，不能将旧 A 直接视为契约版实现。旧入口遇到条件组、替代许可或 quote 会明确报错，防止新旧折扣语义混用。

## 最小调用方式

```ts
import { evaluateShoppingCandidates } from "../lib/agent-b/contract"
import type { ContractBPolicy } from "../types"

const policy: ContractBPolicy = {
  policyVersion: "team-v1",
  dataEnvironment: "development_mock",
  merchantAllowlist: [{ id: "mock-merchant-001", platformId: "mock-platform" }],
  priceBenchmarks: [],
}
const result = await evaluateShoppingCandidates({
  requirement,
  quantity,
  candidates: searchResult.candidates,
  searchStatus: searchResult.status,
  sourceTaskId: searchResult.taskId,
  sourceRequirementVersion: searchResult.requirementVersion,
}, policy)
// 主 Agent 保存 result.decisionRecord，然后根据 diagnostics.nextAction 调度。
```

策略配置由服务端传入，不能直接接收浏览器用户提交的白名单、环境或价格基准。

## 本轮规则

- 审核类别、排除、HKD 币种、预算、报价上下文、库存、配送、渠道、低价风险和全部硬条件。
- 到手价 = 单价 × 数量 + 运费 + otherFeesMinor − 整笔折扣。总价与 quote.totalMinor 不一致时待核验，不任选较低金额。
- 条件组 AND，关键词 OR，NFKC 和大小写归一；未知否定文本不视为匹配。
- 相对权重必须为正数，计算已证实分数 L 和可能上界 U；区间重叠会说明不确定性。
- 系统条件 ID 使用 `system:` 前缀，避免与模板的 `stock`、`delivery` ID 冲突。
- 顶层状态 result_ready / no_match / needs_verification / failed。单个候选未知不阻止另一个合格候选成为首选。
- 空白名单会失败并请求配置；有名单但缺商户平台证据时待核验。
- 价格基准不足时告警、不单独淘汰；满足至少 5 报价、3 卖家、7 天内且排除当前 Offer 时，低于中位价 50% 触发补查。
- 默认真实事实有效期：报价 5 分钟、静态属性 24 小时；购买前动态事实最多 1 分钟；未来时间、过期及 unverified 不通过。
- development_mock 可得到标记为 mock 的模拟首选；真实环境不能接受 mock，购买接口始终拒绝演示环境。
- 模块产生完整的需求/候选/审核快照，由调用方持久化；没有新增数据库或订单执行器。

## 与团队沟通的差异和暂定字段

| 编号 | 对接方 | 目前实现/需求 | 团队需确认 |
| --- | --- | --- | --- |
| I-01 | 主 Agent/A | 新 B 使用 `{ requirement, quantity, candidates, searchStatus, sourceTaskId, sourceRequirementVersion }` | 调用时传递 A 的版本信封，不把当前需求版本填到旧候选上 |
| I-02 | A | quote 和整笔折扣语义已实现；旧入口仍按旧单件公式 | A 提供 quantity/destination/otherFeesMinor/totalMinor，随后统一切换旧工作流和购买入口 |
| I-03 | 主 Agent | 新版所有偏好（包括 inferred）都要求非空 conditions | 这是比模板对 inferred 更严格的临时规则；不猜测旧偏好目标 |
| I-04 | A/公共契约 | 暂定 `quote.canFulfillQuantity: Fact<boolean>` | 是否使用此字段或 availableQuantity；数量大于 1 时必须有证据 |
| I-05 | A/渠道维护 | 暂定 `merchant.platformId: Fact<string>`，白名单匹配 platformId + merchant.id | 稳定商户身份命名空间和实际白名单由团队提供，模板的 name/id 不足以核验平台 |
| I-06 | 数据服务 | 暂定 `PriceBenchmark`，包含同商品/SKU/市场/币种、中位价、样本数、时间、source、excludedOfferIds | 必须由可信服务提供去重基准；目前没有真实服务接入 |
| I-07 | 风控/A | 低价触发后继续待核验；价格或基准更新且不再触发才通过 | 真实大促低价仍需人工/服务端可追溯的放行证据契约；本轮不凭一句促销说明放行 |
| I-08 | 主 Agent | 暂定 diagnostics.nextAction = none/verify/search/clarify/resolve_configuration | 不增加 ShoppingPort 第五种状态；矛盾需求返回 failed + INVALID_INPUT + clarify |
| I-09 | 前端/公共契约 | scoreLowerBound / scoreUpperBound 为 0..100 或 null | 不再透传旧 score；缺偏好时两者为 null，按可比总价排序 |
| I-10 | 数据源 | Fact 新增可选 validUntil，且始终受 fetchedAt + 服务端 TTL 限制 | 确认动态来源有效期，不允许 validUntil 延长本地 TTL |
| I-11 | 主 Agent | allowAlternativeProducts=false 时需 productName eq 约束，否则要求澄清 | 更可靠的指定商品 ID 输入尚未定义；缺省不自动推断许可，主 Agent 必须完整传入指定款硬条件 |
| I-12 | 公共契约 | 真实环境暂名 verified_sources；本轮 mock 值保持 development_mock | 真实环境枚举仍待团队统一，不等同于“所有输入事实都已核验” |
| I-13 | 主 Agent/存储/购买 | B 输出 decisionRecord，解释函数可读取它 | 接入持久化、归属权限、实际订单快照后，才能回答真实订单为什么购买；当前只回答选品依据 |
| I-14 | 主 Agent/A | 新编排器只补查，不自动扩大搜索或修改需求 | no_match 给出 search 动作，由主 Agent 调度重搜；复问也由主 Agent 完成 |
| I-15 | 全团队 | 属性字段采用服务端白名单 schema，未知字段报 INVALID_INPUT | 新增肤质/成分字段需同步 schema、来源与语义，不能直接用文本命中证明功效 |
| I-16 | 公共契约 | item 范围暂将 discountMinor 全部视为商品优惠 | 若存在免运券或混合折扣，需要明确分摊字段，否则商品预算可能口径不一致 |

## 验证

测试覆盖整笔折扣、多件运费/费用、过期与数量地区变化、品类/币种/库存/渠道拒绝、文本否定未知、L/U 区间、部分成功、空结果、低价、旧版本、Mock、授权、快照、补查停止与超时。

运行：`npm run test:agent-b` 或 `npm test`。交付时同时运行 lint、TypeScript 检查和生产构建。

本次验证：全部 60 项测试通过（新增契约版 19 项）；lint、TypeScript 检查及 Next.js 生产构建通过。保留旧模块测试以验证兼容边界。没有真实商户数据、支付接口或授权数据库集成测试。
