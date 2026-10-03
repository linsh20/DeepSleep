# DeepSleep

DeepSleep 当前实现一条统一的商品搜索管线，不再区分 Agent A 和 Agent B。模块接收上层已经解析好的结构化条件，执行确定性筛选、评分/销量预选、LLM 条件评分，并将最多十个有序候选交给后续授权验证。

默认数据源已经切换为 `data/watson/data/products.db` 中的 Watsons 香港 `en_HK` 快照。搜索模块不会授权购买、模拟真实交易或调用商城下单接口；快照价格、库存和促销必须由后续授权验证实时复核。

## 当前能力

- 品名、数值范围、包含关键词、排除关键词四阶段顺序筛选。
- 每个条件输出筛选前后数量和未知事实数量。
- `must` 只淘汰已知违反；未知值保留并标记待验证；`prefer` 只参与排序。
- 超过十个候选时按评分 60%、销量 40% 预选。
- LLM 对每个条件给出 1–5 分，未知事实由代码强制为 3。
- 采用对低分敏感的加权调和平均，`must` 权重 2、`prefer` 权重 1。
- 单商品 LLM 失败时确定性降级，不影响其他商品。
- 保留来源、获取时间、事实状态、精确商品身份、任务 ID 和需求版本。
- 支持英文品名别名和成分字段限定；通用 `alcohol` 不会误判 cetyl/cetearyl alcohol，`fragrance` 可识别 `parfum`。
- 只召回 349 条 `confirmed_face_treatment` 记录；6 条类目异常仍保留在原始数据中，但不参与搜索。
- 成功搜索但零匹配返回 `complete/no_match`，与数据源故障明确区分。

## 本地运行

要求 Node.js 22.13+（SQLite 使用 Node 内置 `node:sqlite`）：

```sh
npm install
npm run dev
```

打开 `http://localhost:3000`。默认表单使用英文关键词搜索 HKD 100–300、100–300 ml 的 lotion，并展示筛选日志和逐条件评分。

## 结构化输入

```json
{
  "taskId": "task-001",
  "requirementVersion": 1,
  "product_name": {
    "value": "lotion",
    "aliases": ["emulsion", "moisturising lotion"],
    "must": 1
  },
  "range_conditions": [
    { "field": "volumeMl", "min": 100, "max": 300, "must": 1 },
    { "field": "priceMinor", "min": 10000, "max": 30000, "must": 0 }
  ],
  "include_keywords": [
    { "keywords": ["sensitive skin"], "must": 1 },
    { "keywords": ["moisturizing", "moisturising"], "must": 0 }
  ],
  "exclude_keywords": [
    { "keywords": ["alcohol", "ethanol"], "scope": "ingredients", "must": 1 },
    { "keywords": ["fragrance", "parfum"], "scope": "ingredients", "must": 0 }
  ]
}
```

金额统一使用整数最小货币单位：HKD 100 表示为 `10000`。容量使用 `volumeMl`。`aliases` 和 `scope` 均为可选字段；`scope` 默认为 `all`，成分排除建议明确使用 `ingredients`。未知商品事实使用 `null`，不能用零或空字符串代替。

当前快照是 `en_HK`，所以上游应把中文意图转换为英文 `value`/`aliases`；展示和说明仍可使用中文。品牌名和 INCI 成分保留源数据原文，不做简繁或机器翻译。这样可以避开简繁转换和中文分词歧义，同时保留成分标准名称。

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

## 商品数据配置

默认读取仓库内 Watsons 快照；需要切换测试数据或另一个数据库时使用服务端环境变量：

```text
PRODUCT_DATA_MODE=mock
WATSONS_DB_PATH=D:\snapshots\watsons\products.db
```

`PRODUCT_DATA_MODE=mock` 才会使用 `data/products.mock.json`。未设置时使用 Watsons。数据库必须包含本项目抓取器生成的 `products`、`snapshot` 表，且快照元数据必须是 `complete`、`en_HK`、`HKD`。构建配置会把默认数据库加入 `/api/products/search` 的服务端文件追踪。

## 模块结构

| 路径 | 用途 |
| --- | --- |
| `types/index.ts` | 唯一共享类型来源 |
| `services/product-search.ts` | 统一搜索编排、校验、归一化和最终排序 |
| `services/search-filter.ts` | 四阶段确定性筛选和日志 |
| `services/popularity-ranker.ts` | 评分/销量预选 |
| `services/condition-scorer.ts` | LLM 适配、输出校验和确定性降级 |
| `services/product-provider.ts` | 商品数据源抽象和 Mock Provider |
| `services/watsons-product-provider.ts` | Watsons SQLite 读取、清洗和字段归一化 |
| `data/products.mock.json` | 乳液 Mock 商品数据 |
| `data/watson/data/products.db` | 默认 Watsons `en_HK` 搜索快照 |
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

测试覆盖正常、空结果、非法输入、部分失败、总失败、超时、去重、硬筛/偏好、缺失事实、评分/销量预选、未知 3 分、LLM 单商品降级、调和平均、任务版本、HTTP 错误映射、真实 SQLite 映射、类目过滤、容量冲突以及酒精/香精语义。

### 手工验证

1. 运行 `npm run dev`，打开首页；页头应显示“Watsons en_HK 快照”。
2. 保留默认 `lotion` 条件提交；结果商品 ID 应以 `watsons-product:` 开头，链接指向 `www.watsons.com.hk`。
3. 把品名改为明显不存在的英文词，应得到“没有符合当前条件的商品”，而不是数据源错误。
4. 用 `PRODUCT_DATA_MODE=mock npm run dev`（PowerShell：`$env:PRODUCT_DATA_MODE="mock"; npm run dev`）可验证 Mock 降级路径。
5. 动态事实只代表 `2026-10-03` 快照；进入购买授权步骤前必须重新检查价格、库存、配送和促销资格。

## 开发约定

修改 Next.js 代码前必须阅读当前安装版本的 `node_modules/next/dist/docs/`。每项工作从最新 `main` 创建短分支，保留不属于当前任务的现有修改，提交使用 Conventional Commit。
