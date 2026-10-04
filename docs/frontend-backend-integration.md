# MirrorPick 前后端合并说明

## 1. 环境比较

根应用与 `frontend` 快照都使用 Next.js 16.3.8、React 19.2.8、TypeScript 5、Tailwind CSS 4 和同一份 npm 依赖。根目录是当前运行单元；`frontend` 是较早的后端快照加 MirrorPick UI，不作为第二个需要启动的服务。

本次以根目录后端为准，因为它还包含较新的 Main Agent → 商品选择 → 订单计价 → payment risk 交接类型和服务。不能把 `frontend/types`、`frontend/services` 或 `frontend/app/api` 覆盖到根目录，否则会删除这些后端能力。

根应用继续使用 App Router。根据仓库内 Next.js 16 文档，页面放在 `app/**/page.tsx`，同源接口放在 `app/api/**/route.ts`，带交互的 MirrorPick 根组件保留为 Client Component。

## 2. 文件合并

合并后的单一应用入口如下：

| 路径 | 作用 |
| --- | --- |
| `app/page.tsx` | `/` 的 MirrorPick 主界面 |
| `app/product-search/page.tsx` | 原结构化搜索调试页，保留在 `/product-search` |
| `components/mirrorpick/` | MirrorPick 交互组件和响应式样式 |
| `lib/mirrorpick.ts` | 同源 API 客户端、金额/身份展示适配 |
| `public/mirrorpick/` | 仅用于展示的静态素材 |
| `app/api/agent/**` | 原仓库 Main Agent、搜索、授权、报价和执行接口，未被旧快照覆盖 |
| `types/index.ts` | 当前共享契约唯一来源，未被 `frontend` 旧类型覆盖 |

`tsconfig.json` 和 ESLint 忽略 `frontend/`，避免备份快照作为第二个应用参与根项目的类型检查和 lint。确认合并稳定后可单独归档或删除该目录；本次没有删除原件。

## 3. 数据流合并

```text
MirrorPick Client
  → /api/agent/session
  → /api/agent/tasks + /messages + /requirements
  → /api/agent/tasks/:taskId/search
  → Main Agent → Shopping Agent (A/B) → candidates
  → /api/agent/purchases/prepare
  → checkout quote + Agent B review + payment-risk precheck
  → /api/agent/purchases/execute（必须有显式单次沙盒许可）
  → Stripe sandbox / demo merchant
  → /api/agent/purchases/state 或 recover
```

浏览器只提交会话内的任务、需求、候选三元组和显式许可，不提交密钥、价格事实或支付凭证。服务端继续负责事实来源、报价、授权版本、风险检查和最终执行。

本次修正了新旧契约的关键差异：Main Agent 的编辑表单预算是 `budget.maxHKD`（HKD 元，最多两位小数）；Offer、quote、授权限额和支付金额仍使用整数 minor units。前端不再把 `maxMinor` 写入当前 `RequirementDraft`。所有结果仍按 `taskId` 和 `requirementVersion` 校验，候选身份仍是 `(productId, skuId, offerId)`。

完整组件到接口和错误状态映射见 `docs/mirrorpick-api-map.md`。

## 4. 需要的补充

1. 从 `config/mirrorpick.env.example` 选择需要的字段复制到 `.env.local`。所有密钥必须只在服务端，不能使用 `NEXT_PUBLIC_`。
2. 结构化搜索和确定性评分无需 LLM。自然语言对话需要 `LLM_API_KEY`；Shopping LLM 评分还需要 `SHOPPING_SCORING_MODE=llm`、`LLM_API_URL` 和 `LLM_MODEL`。
3. 真实 Stripe 验收只允许 `sk_test_` 沙盒密钥，并需要对应的 webhook secret。未配置时系统会明确返回未配置，不会伪造成功。
4. `/api/agent/**`、购买桥和风险接口当前有 development-only 守卫。`npm run build` 可通过，但要生产部署 MirrorPick 必须先设计生产身份认证、CSRF、持久化、审计和支付运维策略，再显式开放这些接口。
5. `frontend` 目录目前仅作来源备份。后续若删除，应先确认其中的 QA 截图和交付说明是否需要另行归档。

## 验证记录（2026-10-04）

- `npx tsc --noEmit`：通过。
- `npm run lint`：通过。
- `npm run build`：通过，生成 `/`、`/product-search` 和 13 个静态/动态路由页面。
- MirrorPick 与 Main Agent 定向测试：37/37 业务断言通过；另一个持久化测试仅在 Windows 清理临时 SQLite 目录时报告 `EPERM`。
- 全量 `npm test`：270 项中 263 项通过；7 项均完成其业务断言后，在测试钩子删除临时 SQLite 目录时报告同一 `EPERM`。该现象在沙箱内外复现，不归因于本次前端合并，但需要单独修正测试资源关闭/Windows 清理逻辑。
