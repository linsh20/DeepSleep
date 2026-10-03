# DeepSleep · WalletAgent

一个使用 Next.js 和 TypeScript 开发的购物 Agent 原型。项目将搜索与商品事实交给 Agent A，将候选评估、约束判断和购买前风控交给 Agent B，并提供主 Agent 可调用的 A/B 编排入口。

当前使用本地 Mock 商品数据，不需要 LLM API Key、数据库、Python 或 Docker。首页已经接入 Agent A 的搜索与事实补查；Agent B 和 A/B 编排已在服务端实现，但推荐结果与购买风控尚未接入页面，也没有真实下单模块。

## 当前能力

| 模块 | 已实现 | 当前限制 |
| --- | --- | --- |
| Agent A | 搜索计划、候选召回、标准化、去重、排除、事实补查 | 使用 Mock 数据，未连接真实商城 |
| Agent B | 硬约束过滤、偏好评分、推荐解释、补查请求、购买前检查 | Mock 事实不能当作已核验事实；没有授权数据库 |
| A/B 编排 | 搜索 → 评估 → 最多 2 轮补查 → 重新评估 | `needsSearch` 交回主 Agent，不会自动放宽需求 |
| Web 首页 | 搜索候选、查看事实、补查字段、排除商品 | 暂未展示 B 的推荐与风控结果 |
| 购买 | 只提供 `checkPurchase` 风控接口 | 不执行真实交易 |

统一字段及接口约定见 [A/B 接入文档](docs/agent-integration.md)。重量统一使用 `weightGrams`，金额使用整数最小货币单位，商品身份分别保存 `productId`、`skuId` 和 `offerId`。

## 本地运行需要的环境

推荐在 Windows 10/11 上准备：

- [Git for Windows](https://git-scm.com/download/win)：用于拉取和更新代码；如果代码已经在本地，仅运行项目时不是必需项。
- [Node.js](https://nodejs.org/) **22.18 或更高版本**：官方安装包会同时安装 `npm`。Node.js 24 也已验证可用。
- 一个现代浏览器，例如 Chrome、Edge 或 Firefox。

Next.js 16 本身要求 Node.js 20.9 或更高版本；本项目测试脚本还会直接运行 TypeScript 测试文件，因此统一推荐 Node.js 22.18 或更高版本。

不需要安装：

- Python
- Docker
- 数据库
- 全局 Next.js
- LLM 或商城 API Key

## Windows 安装与启动

### 1. 安装并检查 Node.js

从 [Node.js 官网](https://nodejs.org/) 安装符合版本要求的版本。安装完成后关闭并重新打开 PowerShell，然后执行：

```powershell
node --version
npm --version
```

两条命令都应显示版本号。

如果出现“无法将 `npm` 项识别为 cmdlet”，说明当前 PowerShell 没有找到正式安装的 Node.js。请安装或重新安装 Node.js，并重开终端；可用以下命令检查实际路径：

```powershell
where.exe node
where.exe npm
```

如果 PowerShell 的执行策略阻止 `npm.ps1`，可以直接使用同一安装目录下的 `npm.cmd`：

```powershell
npm.cmd --version
```

### 2. 进入并更新项目

如果已经有当前项目文件夹：

```powershell
cd C:\Users\13661\Desktop\HackU_codes\DeepSleep
git switch main
git pull --ff-only origin main
```

第一次获取项目时：

```powershell
cd C:\Users\13661\Desktop\HackU_codes
git clone git@github.com:linsh20/DeepSleep.git
cd DeepSleep
```

SSH 克隆需要 GitHub SSH 权限；没有配置 SSH 时，也可以使用仓库页面提供的 HTTPS 地址。

### 3. 安装依赖并启动开发服务器

```powershell
npm ci
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。终端显示 `Ready` 后即可使用；按 `Ctrl+C` 停止服务。

如果默认端口被占用，可指定其他端口：

```powershell
npm run dev -- --port 3001
```

如果使用 `npm.cmd` 规避 PowerShell 脚本策略，对应命令为：

```powershell
npm.cmd ci
npm.cmd run dev
```

`npm ci` 会严格按 `package-lock.json` 安装依赖，首次运行、依赖变化或 `node_modules` 不完整时都应执行。

## 测试与生产构建

运行全部 Agent A、Agent B、HTTP 接口和跨模块联调测试：

```powershell
npm test
```

其他常用检查：

```powershell
npm run lint
npx tsc --noEmit
npm run build
```

本地运行生产构建：

```powershell
npm run build
npm run start
```

当前完整测试集共 39 个测试。页面使用 `next/font/google`，首次开发或生产构建可能需要访问 Google Fonts；Mock 商品搜索本身不需要外部网络。

## 首页操作示例

1. 保持默认关键词 `Wireless headphones`、预算 HK$500、包含运费，点击 **Search products**。
2. 对缺少重量或续航的候选点击 **Look up missing facts**。
3. 点击 **Exclude product** 可排除同一 `productId` 的全部 SKU 和报价。
4. 点击 **Reset exclusions** 恢复被排除的商品。
5. 展开 **Sources and identifiers** 查看来源、获取时间和商品身份。

页面底部的 **Legacy purchase demo** 是独立模拟流程，没有与候选列表联动，也不会执行真实交易。

## A/B 调用链路

```text
Requirement
    ↓
Agent A: searchCandidates
    ↓
Agent B: evaluateCandidates
    ├─ ready ───────────────→ 返回推荐
    ├─ needsSearch ─────────→ 返回 searchHints 给主 Agent
    └─ needsVerification ───→ Agent A: verifyFacts
                                  ↓
                              Agent B 重新评估
```

服务端主 Agent 可以直接调用：

```ts
import { checkPurchase, runShoppingTask } from "@/services/shopping-agent"

const result = await runShoppingTask({ requirement, limit: 20 })

const purchaseCheck = await checkPurchase(
  { requirement, candidate, quantity: 1, authorization },
  {
    getAuthorizationById: (authorizationId) =>
      authorizationStore.findById(authorizationId),
  },
)
```

`runShoppingTask` 默认最多补查 2 轮，并保留部分搜索结果。`checkPurchase` 只进行购买前检查；授权必须来自后端保存的真实记录，缺少价格、运费、库存、配送信息或授权时不会返回 `approved`。

Agent A 的 HTTP 入口：

| 入口 | 请求体 | 返回 |
| --- | --- | --- |
| `POST /api/products/search` | `{ requirement, limit }` | `SearchResult` |
| `POST /api/products/verify` | `{ requirement, candidates, requests }` | `SearchResult` |

接口详细说明见 [Agent A 文档](docs/search-agent.md) 和 [A/B 接入文档](docs/agent-integration.md)。

## 数据与运行时约定

- 公共类型唯一来源是 [types/index.ts](types/index.ts)；[types/shopping.ts](types/shopping.ts) 为兼容现有导入路径而重导出。
- 重量统一使用 `attributes.weightGrams`，单位为克。
- 续航使用 `attributes.batteryLifeHours`，单位为小时。
- 金额使用整数最小货币单位，例如 HK$500 表示为 `50000`。
- 缺失事实使用 `null` 或缺失字段，不能用 `0` 代替。
- 每次需求修改应递增 `requirementVersion`，旧版本结果不能覆盖新版本。
- 商品事实包含来源、获取时间和状态；`mock` 不等于经过真实来源核验。
- 搜索、评估和风控接口都不会直接下单。

Mock 数据位于 [data/products.mock.json](data/products.mock.json)，包含预算、运费、折扣、缺货、无法配送、未知字段、多 SKU、多报价和重复数据等测试场景。演示网址使用 `example.invalid`，不能用于真实购买。

## 主要目录

| 路径 | 用途 |
| --- | --- |
| [types/index.ts](types/index.ts) | A/B 共用类型 |
| [services/search-agent.ts](services/search-agent.ts) | Agent A 搜索与事实补查 |
| [services/product-provider.ts](services/product-provider.ts) | 商品数据源抽象和 Mock Provider |
| [lib/agent-b/index.ts](lib/agent-b/index.ts) | Agent B 评估和购买前风控 |
| [services/shopping-agent.ts](services/shopping-agent.ts) | 主 Agent 可调用的 A/B 编排入口 |
| [components/product-search.tsx](components/product-search.tsx) | 首页商品搜索交互 |
| [app/api/products](app/api/products) | 搜索和补查 HTTP 接口 |
| [tests](tests) | Agent A、HTTP 和跨模块测试 |
| [docs](docs) | 接口与集成说明 |

## 协作约定

多人开发时，每项功能从最新 `main` 新建短分支，目标在约一小时内完成一个可验收阶段并合并，以减少长期分支冲突：

```powershell
git switch main
git pull --ff-only origin main
git switch -c feature/简短功能名
```

合并前运行与改动范围相符的测试，并再次同步 `main` 检查冲突。提交只包含本次工作，不覆盖其他成员的修改。

修改 Next.js 代码前，请先阅读根目录 [AGENTS.md](AGENTS.md) 和当前安装版本的 `node_modules/next/dist/docs/` 文档。
