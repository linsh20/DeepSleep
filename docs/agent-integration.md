# A / B 接入约定

公共类型唯一来源为 `types/index.ts`。`types/shopping.ts` 仅重导出，保留 A 和前端现有的导入路径。

- 重量：`attributes.weightGrams`，克。
- 续航：`attributes.batteryLifeHours`，小时。原 B 的 `batteryHours` 已移除，调用方需要迁移。
- 需求版本：非负整数，主 Agent 修改需求时递增。
- 商品事实：允许 `value: null, source: "", fetchedAt: "", status: "unverified"` 表示尚未获取到任何来源的未知值；有值的事实仍必须携带来源和时间。
- 金额仍为整数最小货币单位。单次需求、报价和授权的币种必须一致。
- A 支持 B 的裸报价字段（如 `itemPriceMinor`）和计算字段 `totalPrice / deliveredTotalMinor / netItemPriceMinor`。计算字段在搜索阶段展开为真实报价字段，补查只请求事实字段。

## 服务端主 Agent 入口

```ts
import { runShoppingTask, checkPurchase } from "@/services/shopping-agent"

const result = await runShoppingTask({ requirement, limit: 20 })
// result.search: 最新候选、源状态及累计 warnings
// result.evaluation: B 的推荐、拒绝理由、补查请求、searchHints
// result.verificationRounds: 已执行补查轮数
// result.stopReason: 为什么结束本次编排

// 购买检查独立调用，必须由后端提供真实授权查询。
const check = await checkPurchase(
  { requirement, candidate, quantity: 1, authorization },
  { getAuthorizationById: (id) => authorizationStore.findById(id) },
)
```

编排依次调用 A 搜索、B 评估；遇到 `needsVerification` 调 A 补查并重新评估，默认最多 2 轮。部分搜索结果会保留。没有候选、需要继续搜索或补查耗尽时，将结果交回主 Agent；不自行放宽预算或硬约束，也不无限重复相同搜索。

每次运行持有独立需求快照，返回 taskId 和 requirementVersion。主 Agent / 前端仍须对照当前任务版本，丢弃过期结果。

默认 A 是 MockProductProvider。补查不会把模拟事实提升为 verified，因此通常以 needsVerification / verificationLimit 结束。此时不能把候选展示为已经核验的推荐，也不能批准购买。

接入真实数据源：

```ts
import { createShoppingAgent } from "@/services/shopping-agent"
const agent = createShoppingAgent(realProductProvider, {
  timeoutMs: 5000, maxVerificationRounds: 2,
})
const result = await agent.runShoppingTask({ requirement, limit: 20 })
```

当前已有首页搜索组件继续调用 A 的 search / verify HTTP 接口；本次提供的是主 Agent 可调用的 A/B 服务端编排入口，尚未将推荐和风控结果接到页面。没有购买执行模块或授权数据库实现。

验证：`npm test` 覆盖 A、B、搜索 HTTP 接口及跨模块联调。
