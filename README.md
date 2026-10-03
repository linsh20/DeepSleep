# DeepSleep

DeepSleep 当前实现一条统一的商品搜索管线，不再区分 Agent A 和 Agent B。模块接收上层已经解析好的结构化条件，执行确定性筛选、评分/销量预选、LLM 条件评分，并将最多十个有序候选交给后续授权验证。

当前使用本地 Mock 商品数据。搜索模块不会授权购买、模拟真实交易或调用商城下单接口。

## 当前能力

- 品名、数值范围、包含关键词、排除关键词四阶段顺序筛选。
- 每个条件输出筛选前后数量和未知事实数量。
- `must` 只淘汰已知违反；未知值保留并标记待验证；`prefer` 只参与排序。
- 超过十个候选时按评分 60%、销量 40% 预选。
- LLM 对每个条件给出 1–5 分，未知事实由代码强制为 3。
- 采用对低分敏感的加权调和平均，`must` 权重 2、`prefer` 权重 1。
- 单商品 LLM 失败时确定性降级，不影响其他商品。
- 保留来源、获取时间、Mock 状态、精确商品身份、任务 ID 和需求版本。
- 成功搜索但零匹配返回 `complete/no_match`，与数据源故障明确区分。

## 本地运行

要求 Node.js 20+：

```sh
npm install
npm run dev
```

打开 `http://localhost:3000`。默认表单搜索 HKD 100–300、100–300 ml 的敏感肌乳液，并展示筛选日志和逐条件评分。

## 结构化输入

```json
{
  "taskId": "task-001",
  "requirementVersion": 1,
  "product_name": { "value": "乳液", "must": 1 },
  "range_conditions": [
    { "field": "volumeMl", "min": 100, "max": 300, "must": 1 },
    { "field": "priceMinor", "min": 10000, "max": 30000, "must": 0 }
  ],
  "include_keywords": [
    { "keywords": ["敏感肌", "sensitive skin"], "must": 1 },
    { "keywords": ["保湿", "补水", "moisturizing"], "must": 0 }
  ],
  "exclude_keywords": [
    { "keywords": ["酒精", "alcohol"], "must": 1 },
    { "keywords": ["香精", "fragrance"], "must": 0 }
  ]
}
```

金额统一使用整数最小货币单位：HKD 100 表示为 `10000`。容量使用 `volumeMl`。未知商品事实使用 `null`，不能用零或空字符串代替。

HTTP 入口：

| 入口 | 请求 | 返回 |
| --- | --- | --- |
| `POST /api/products/search` | `StructuredSearchInput` | `RankedSearchResult` |

详细字段、状态、算法和边界见 [统一搜索管线文档](docs/search-pipeline.md)。

## LLM 配置

不配置 LLM 时系统仍可用，但会使用确定性评分并返回 `partial`：

```text
LLM_API_URL=https://provider.example/v1/chat/completions
LLM_API_KEY=...
LLM_MODEL=...
```

接口采用 OpenAI-compatible chat-completion JSON 格式。配置和调用只存在于服务端，禁止使用 `NEXT_PUBLIC_` 暴露密钥。

## 模块结构

| 路径 | 用途 |
| --- | --- |
| `types/index.ts` | 唯一共享类型来源 |
| `services/product-search.ts` | 统一搜索编排、校验、归一化和最终排序 |
| `services/search-filter.ts` | 四阶段确定性筛选和日志 |
| `services/popularity-ranker.ts` | 评分/销量预选 |
| `services/condition-scorer.ts` | LLM 适配、输出校验和确定性降级 |
| `services/product-provider.ts` | 商品数据源抽象和 Mock Provider |
| `data/products.mock.json` | 乳液 Mock 商品数据 |
| `app/api/products/search/route.ts` | Next.js Route Handler |
| `components/product-search.tsx` | 首页演示界面 |

下游必须校验返回结果的 `taskId` 和 `requirementVersion`，默认从 `candidates[0]` 开始授权验证，不满足时按 rank 递补。推荐顺序不是购买授权。

## 验证

```sh
npm test
npm run lint
npx tsc --noEmit
npm run build
```

测试覆盖正常、空结果、非法输入、部分失败、总失败、超时、去重、硬筛/偏好、缺失事实、评分/销量预选、未知 3 分、LLM 单商品降级、调和平均、任务版本和 HTTP 错误映射。

## 开发约定

修改 Next.js 代码前必须阅读当前安装版本的 `node_modules/next/dist/docs/`。每项工作从最新 `main` 创建短分支，保留不属于当前任务的现有修改，提交使用 Conventional Commit。
