# DeepSleep · WalletAgent

一个分模块开发的购物 Agent 原型。目前已完成 **A 部分：商品搜索与数据 Agent**，并提供首页交互入口，支持搜索候选、查看商品事实、补查缺失字段和排除商品。

当前使用本地 Mock 商品数据，无需 LLM API Key。真实商城、最终推荐、购买风控和下单链路尚未接通。

## 当前版本与分支

- 项目版本：`0.1.0`，与 `package.json` 一致。
- 本文记录时间：2026-10-03。
- A 模块基础能力已合并到 `main`，提交为 [`d47d8e4`](https://github.com/linsh20/DeepSleep/commit/d47d8e497c2b784fb445f5f615448d5eb1c6d4ef)。
- 首页接入位于 [`codex/search-homepage`](https://github.com/linsh20/DeepSleep/tree/codex/search-homepage) 分支，功能提交为 `40ddeae`，本次暂不合并 `main`。
- 更新记录按功能阶段整理，不代表已创建新的发布版本或 Git 标签。

## 已实现的功能

| 功能 | 当前行为 |
| --- | --- |
| 搜索候选 | 输入关键词、港币预算，选择预算仅含商品或包含运费；首页固定 Electronics 类目、香港配送 |
| 搜索计划 | 根据结构化需求生成确定性的类目、查询词、币种、预算和约束条件 |
| 商品标准化 | 使用独立的 Product、SKU、Offer ID；金额使用整数最小货币单位 |
| 去重与排除 | 按商品、SKU、Offer 三元组去重；排除商品时移除其全部 SKU 和报价 |
| 事实展示 | 展示价格、运费、折扣、到手总价、重量、续航、库存及配送状态 |
| 缺失标记 | 未知值保持 `null`，页面显示 `Unknown`，缺失字段列入 `missingFields` |
| 事实补查 | 只更新请求指定的商品身份和字段，更新来源、时间及状态；查不到时保留已有有效事实 |
| 来源追踪 | 展开来源区域查看商品标识及事实来源；Mock 事实明确标记为 `mock` |
| 异常反馈 | 区分完整、部分和失败结果，处理输入错误、数据源失败、超时和不支持的类目 |
| 旧结果隔离 | 传递任务 ID 和需求版本；首页取消被替代的请求，并在条件变更后清除旧结果 |

搜索是大小写不敏感的关键词匹配，要求商品文本包含所有空白分隔的查询词。候选保留数据源顺序，不做最终推荐评分。未知的预算或约束事实会保留供后续补查，不能据此认为商品已通过购买风控。

首页当前只开放关键词和预算条件；服务接口还支持硬约束、偏好字段和排除列表。

## 本地运行（PowerShell）

已验证环境：Node.js 24、npm。技术栈：Next.js 16.3.8、React 19.2.8、TypeScript、Tailwind CSS 4。

在现有仓库运行首页接入版本：

```powershell
cd E:\Code\deepsleep
git switch codex/search-homepage
npm ci
npm run dev
```

`npm ci` 用于首次安装或依赖锁文件变化后重新安装。依赖已准备好时，只需 `npm run dev`。

打开 [http://localhost:3000](http://localhost:3000)。若端口被占用，以终端显示的地址为准，也可指定端口：

```powershell
npm run dev -- --port 3001
```

按 `Ctrl+C` 停止服务。生产模式：

```powershell
npm run build
npm run start
```

现有布局通过 `next/font/google` 加载字体，因此构建可能需要访问 Google Fonts。Mock 商品搜索本身不需要外部网络或 API Key。

## 首页操作示例

1. 保持默认关键词 `Wireless headphones`、预算 HK$500、包含运费，点击 **Search products**，当前数据集返回 10 个候选报价。
2. 找到 **Light Wireless Headphones**，点击 **Look up missing facts**，重量从未知补全为 **180 g**。
3. 对 **Travel Wireless Headphones** 执行补查，续航可补全为 **32 hours**。
4. 对 SoundPro 的任一报价点击 **Exclude product**，其全部 SKU 和报价会被移除，搜索自动重新执行。
5. 点击 **Reset exclusions** 恢复被排除的商品。
6. 展开 **Sources and identifiers** 查看事实来源、获取时间和商品身份。

部分商品的信息始终未知，补查后会显示部分结果。数据集中也保留缺货或无法配送的商品供其他模块判断；首页不会自动把这些候选当作可购买商品。

页面底部的 **Legacy purchase demo** 保留原来的独立模拟购买流程，未与新候选列表联动，不执行真实交易。

## 模块职责与调用链路

| 模块 | 职责 | 当前接入情况 |
| --- | --- | --- |
| 主 Agent | 用户对话、需求解析、维护需求版本、调度其他模块 | 尚未接入自动调度；目前由首页表单提供结构化需求 |
| A：商品搜索与数据 Agent | 搜索计划、商品召回、标准化、去重、事实补查 | 已实现 Mock 版本和首页服务端入口 |
| 推荐／决策 Agent | 判断信息是否足够、提出补查字段、评分与最终推荐 | 尚未与新搜索链路接通 |
| 支付风控 | 预算与授权校验、购买前核验及交易控制 | 尚未与新搜索链路接通 |

当前链路：

```text
首页表单 → POST 搜索接口 → A 模块 → MockProductProvider → 候选展示
候选补查按钮 → POST 补查接口 → A 模块 → Mock 详情 → 更新指定事实
```

目标链路：

```text
用户需求 → 主 Agent → A 搜索 → 决策模块
                               ↓ 信息不足
                            A 按需补查 → 决策模块重新评估
                               ↓ 信息充分
                            推荐结果 → 支付风控
```

## 两个公开接口

共享类型定义在 [types/shopping.ts](types/shopping.ts)。服务端直接调用：

```ts
import { searchCandidates, verifyFacts } from "@/services/search-agent"
import type { Requirement } from "@/types/shopping"

const requirement: Requirement = {
  taskId: "shopping-001",
  requirementVersion: 1,
  category: "Electronics",
  query: "wireless headphones",
  currency: "HKD",
  budget: { maxMinor: 50000, scope: "delivered" },
  hardConstraints: [],
  preferences: [],
  excludedProductIds: [],
  destination: "HK",
}

const result = await searchCandidates({ requirement, limit: 20 })
const candidate = result.candidates.find((item) =>
  item.missingFields.includes("attributes.weightGrams"),
)

if (candidate) {
  const updated = await verifyFacts({
    requirement,
    candidates: result.candidates,
    requests: [{
      productId: candidate.productId,
      skuId: candidate.skuId,
      offerId: candidate.offerId,
      fields: ["attributes.weightGrams"],
      reason: "决策模块需要确认商品重量",
    }],
  })
  console.log(updated)
}
```

首页对应的 HTTP 入口：

| 入口 | 请求体 | 返回 |
| --- | --- | --- |
| `POST /api/products/search` | `{ requirement, limit }` | `SearchResult` |
| `POST /api/products/verify` | `{ requirement, candidates, requests }` | `SearchResult` |

两者均返回任务 ID、需求版本、候选、状态和警告。部分结果使用 HTTP 200；失败按原因返回 400、422、503 或 504。无匹配商品但检索正常属于 `complete`，不是数据源失败。

金额示例：HK$500 表示为 `50000`；重量使用克，续航使用小时。`limit` 范围为 1～100。详细字段约定、Provider 扩展方式和状态语义见 [A 模块接口文档](docs/search-agent.md)。

## Mock 数据覆盖范围

[data/products.mock.json](data/products.mock.json) 包含 16 条电子产品记录，覆盖：

- 预算内、超预算、运费导致总价超预算，以及明确的折扣。
- 缺货、无法配送、未知运费与配送状态。
- 重量或续航缺失，详情可补全和始终无法补全两种情况。
- 完全重复记录、同商品不同 SKU、同 SKU 不同报价。
- 只有商品信息、没有 SKU 或 Offer 的记录。
- 耳机、音箱、键盘和充电宝。

所有 Mock 来源事实标记为 `source: "mock-dataset"`、`status: "mock"`。商品网址使用演示域名 `example.invalid`，不是可下单链接。配送演示事实适用于香港；其他目的地的运费和可配送状态保持未知。

## 从手动搜索到后台 Agent 搜索

目前搜索已经在服务端执行，尚需自动化的是需求生成、调用调度和补查闭环。

1. 主 Agent 将用户需求转换为 `Requirement`，确认预算和硬约束，并维护任务及需求版本。
2. 主 Agent 自动调用现有 `searchCandidates`，先使用 Mock 验证模块协作。
3. 决策模块检查候选、提出 `VerificationRequest`；主流程调度 `verifyFacts`，限制补查次数和总超时。
4. A 模块新增真实商品 Provider，对接明确的商城或商品 API，处理认证、分页、限流、SKU 映射和事实来源。
5. 决策及风控模块消费事实，完成推荐和购买前核验。

如果还要求关闭页面后继续执行、稍后恢复任务，需要另外加入持久化、任务队列、进度查询、取消和重试机制；当前 HTTP 请求链路不具备这些能力。

### A 模块是否需要 LLM

**当前不是必需依赖。** A 接收结构化需求，现有 TypeScript 规则可以完成搜索计划、过滤、标准化和补查。主 Agent 的自然语言理解不属于 A 的职责。

后续可将 LLM 用于关键词扩展、平台搜索参数转换、从非结构化描述提取有原文依据的规格。模型调用失败时应回退到规则方案，缺乏证据的价格、库存和规格必须保持未知。

优先工作是确定真实商品数据源并实现 Provider。LLM API 不能替代实时商品 API，也不能自行生成商品事实、最终推荐分数或购买授权。

**以下环境变量仅为未来接入约定，当前代码尚未读取它们；填写后不会自动启用模型或切换数据源：**

```dotenv
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
PRODUCT_DATA_MODE=mock
```

未来凭证放在服务端环境变量或本地 `.env.local`，不要使用 `NEXT_PUBLIC_` 前缀，不要写入源码或提交 Git。当前无任何环境变量也能运行 Mock。

## 主要文件

| 文件 | 用途 |
| --- | --- |
| [types/shopping.ts](types/shopping.ts) | Requirement、Candidate、Fact、SearchResult 等共享类型 |
| [data/products.mock.json](data/products.mock.json) | 演示商品与详情数据 |
| [services/product-provider.ts](services/product-provider.ts) | 数据源抽象与 Mock 实现 |
| [services/search-agent.ts](services/search-agent.ts) | 搜索计划、召回处理、事实补查 |
| [components/product-search.tsx](components/product-search.tsx) | 首页搜索交互与候选展示 |
| [app/api/products/search/route.ts](app/api/products/search/route.ts) | 搜索 HTTP 入口 |
| [app/api/products/verify/route.ts](app/api/products/verify/route.ts) | 补查 HTTP 入口 |
| [lib/product-search-http.ts](lib/product-search-http.ts) | JSON 请求处理、HTTP 状态和错误响应 |
| [docs/search-agent.md](docs/search-agent.md) | 详细接入与扩展文档 |

## 验证方法

```powershell
node --test tests/search-agent.test.mjs tests/product-search-http.test.mjs
npx tsc --noEmit
npm run lint
npm run build
```

首页功能提交 `40ddeae` 的验收结果：23 个测试通过，lint 和生产 build 通过（build 包含 TypeScript 检查）。浏览器已检查搜索、事实补查、排除及恢复、条件变更清除旧结果、空结果和部分结果提示。这里记录的是该功能提交的验收，不代表每次阅读 README 时都重新运行了检查。

## 版本更新记录

### 2026-10-03 · 文档更新（当前分支，未发布）

- 用实际项目说明替换 Next.js 初始模板 README。
- 补充 PowerShell 启动命令、首页操作示例、共享接口、模块分工和验收方法。
- 记录自动后台搜索尚缺的工作，以及 LLM 的可选用途和凭证约定。
- 项目包版本保持 `0.1.0`，未创建发布标签，也未合并首页分支。

### 2026-10-03 · 首页接入（`40ddeae`，未合并 main）

- 首页增加关键词搜索、预算范围选择、候选事实展示及 Mock 标识。
- 增加精确事实补查、整商品排除及重置排除功能。
- 增加服务端搜索／补查接口、结构化 HTTP 错误，以及客户端旧结果隔离。
- 保留原购买演示于折叠区；新增 4 个 HTTP 测试，总测试数达到 23。

### 2026-10-03 · A 模块基础实现（`d47d8e4`，已合并 main）

- 增加共享类型、确定性搜索计划、Provider 接口和 16 条 Mock 记录。
- 实现 `searchCandidates` 与 `verifyFacts`，支持标准化、去重、排除、缺失标记及事实来源。
- 增加部分失败、超时、输入校验和需求版本传递；19 个模块测试通过。

## 协作约定

功能开发使用短分支，目标约一小时内完成一个可验收阶段，及时同步主分支以减少冲突。常规开发验收后合并；`codex/search-homepage` 本次按约定保留分支，等待明确合并指令。提交只包含本次工作，保留其他成员的未提交改动。

修改 Next.js 代码前先阅读根目录 [AGENTS.md](AGENTS.md) 及 `node_modules/next/dist/docs/` 中相关版本文档。
