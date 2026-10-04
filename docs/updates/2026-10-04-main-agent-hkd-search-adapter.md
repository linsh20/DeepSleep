# 主 Agent HKD 预算与搜索转接更新

日期：2026-10-04

## 修复内容

- 主 Agent 的需求草稿和完整需求改用 `budget.maxHKD`，单位为 HKD 元。用户输入 `200 港币` 保存为 `200`，不再在对话任务里显示为 `20000` 港仙。
- 模型传输协议继续要求 `budget.amountHKD` 字符串；通过来源校验后规范化为最多两位小数的 `maxHKD` 数值。
- 增加 `toShoppingRequirement` 转接器。Shopping、Agent B、报价和支付模块仍使用整数最小货币单位，例如 `200 HKD → maxMinor: 20000`，避免金额计算中的浮点误差。
- `deriveSearchInput` 只发送搜索 Agent 声明支持的 `product_name`、`range_conditions`、`include_keywords` 和 `exclude_keywords`，不把整单预算错误映射成商品单价限制。
- 转接结果在发送前调用搜索 Agent 的运行时输入校验；`taskId` 和 `requirementVersion` 保持不变。
- 开发表单改为直接提交和展示 `maxHKD`。旧的 `maxMinor` 表单或持久化任务仍可读取，并在主 Agent 入口归一化为 HKD。

## 数据边界

| 边界 | 字段 | 示例 |
| --- | --- | --- |
| 用户/模型 | `budget.amountHKD` | `"200"` |
| 主 Agent | `budget.maxHKD` | `200` |
| 搜索 Agent | 不接收预算 | 仅接收品名、范围和关键词 |
| Shopping/风控/支付 | `budget.maxMinor` | `20000` |

## 验证

- 主 Agent 模型、需求编辑、版本和函数调用测试：50/50 通过。
- Main → Search 转接业务测试：品名、容量、包含/排除关键词、HKD → minor 转换和真实 Watsons 快照均通过。
- Demo checkout 和 purchase bridge 业务断言通过；Windows 上部分 SQLite 重启用例仍在结束清理临时目录时出现既有 `EPERM`，与本次金额/格式断言无关。
- `npm run lint` 通过；排除被运行中开发服务破坏的 `.next/dev` 生成缓存后，源码 TypeScript 诊断为 0。
- `scripts/check-main-agent-direct.mjs` 使用 `.env.local` 完成一次真实模型直调：主 Agent 输出 `maxHKD: 200`，搜索输入通过运行时校验，下游转接输出 `maxMinor: 20000`。
