# Main Agent：Shopping 请求契约升级

2026-10-03。本轮基于 `4e06969` 创建 `feat/main-agent-contract`，保留 `47c4a87` 及后续工作，不重新基于 main 丢弃前两阶段。输入约定来自 `../outputs/shopping-contract-template.mjs`（仓库外）；其正文没有 `clarificationSpec` 字段，采用本轮用户明确给出的必填/停止追问规则。

## 文件及共享增量

- `types/index.ts`：Constraint 可选 id；containsAny/notContainsAny；Preference 可选 id/conditions；Requirement 可选 allowAlternativeProducts。旧对象仍可赋值；旧消费者的穷尽 switch 需要适配，见下。
- `services/main-agent/conditions.ts`：请求侧字段/操作符/值白名单、范围/集合/文本互斥检查、目标组替换和删除、偏好提升去重。不实现商品评价，不通过字符串路径写对象。
- `types.ts`、`requirement-interpreter.ts`：草稿携带硬条件、偏好、排除项和替代许可；完整 Requirement 真实传递它们。类别可生成 query；不要求重复填写商品。
- `model-interpreter.ts`：提示词、目标编辑 Schema、来源证据、合并和重要歧义处理。模型只输出需求，不接受任务身份、版本、状态、权限。HKD 元用十进制字符串提取，再确定性转港仙。
- `orchestrator.ts`：保留原状态机，记录当前版本实际 ShoppingPort 请求；修改需求清除结果和请求快照。模型超时调整为有限 60 秒，无自动重试。
- `components/agent-debug.tsx`：只读条件、偏好、预算/数量/配送、实际请求 JSON；表单保留未编辑的新字段，用户金额显示 HKD 元。
- `tests/main-agent-contract.test.mjs`、`tests/fixtures/contract.mjs`：直接捕获 ShoppingPort 请求，验证 A–G 和额外边界。
- `scripts/check-contract-model.mjs`：手动真实验收，最多五轮；仅读取 `.env.local` 的 LLM_API_KEY。`--diagnostic` 只输出 Schema 形状，不含字段值或上游鉴权。无密钥时不发请求。
- `main-agent-contract-live.json`：真实模型五轮任务/请求记录，无密钥、用户身份或会话凭据。

## 接口与合并

HTTP 消息接口不变：`POST /api/agent/messages`，服务端演示会话归属校验；输入 `{requestId, taskId, expectedVersion, message}`。响应为现有 task；已接受消息的解释失败写入助手 errorCode，保留旧有效需求/结果，不能据旧结果误认新消息成功。

模型内部 wire 的 requirementDraft 是变更集，解释器输出和 `/requirements` 仍是**完整草稿**。缺省保留；标量 null 显式清除（仍需要当前消息证据）。硬条件/偏好使用目标组编辑，不把模型自由字段作为路径：

```json
{
  "intent": "compare",
  "intentEvidence": null,
  "requirementDraft": {
    "hardConstraints": [{
      "field": "attributes.volumeMl",
      "replace": [
        {"field":"attributes.volumeMl","op":"gte","value":200},
        {"field":"attributes.volumeMl","op":"lte","value":300}
      ]
    }]
  },
  "evidence": {"hardConstraints":"容量改成200到300ml"},
  "missingFields": [],
  "clarificationQuestions": []
}
```

`replace:[]` 删除该字段组，其他字段不变。可增加 `id` 精确选择同字段的一个目标（替换项须保留相同 id）。偏好编辑的 replace 是完整 Preference 数组，需要 conditions。同一偏好被更强的同目标硬条件覆盖时移除软目标；不把文本匹配当作功效证明。

支持字段：attributes.brand/series/productName/shade/packageType/volumeMl；offer.deliverable/stock；text.searchable；quote.estimatedDeliveryAtMs。文本字段 eq/in/notIn；容量/期限 eq/gte/lte；deliverable eq 布尔；searchable containsAny/notContainsAny 非空字符串数组。包装 regular/refill/sample/set；stock available/unavailable。数字色号拒绝，`"02"` 保留。容量以 ml 表达，不能从 g 转换。期限为 UTC 毫秒，相对时间/单位重要歧义要澄清。

新主 Agent 不接收没有目标 conditions 的偏好，明确错误；共享 Preference.conditions 仍可选以兼容旧类型。条件冲突或重要歧义返回 CONDITION_CONFLICT / NEEDS_CLARIFICATION；无效字段、操作符、Schema 返回清晰错误，均不应用到现有任务。缺失可选品牌等不能阻止完整需求搜索；运费/库存未知属于 Shopping 商品事实，不向用户追问。

`ShoppingPort.search` 仍只收到 `{requirement,quantity}`；身份和版本仅由服务端生成并进入 Requirement。完整请求不包含 intent、userId、消息或密钥。版本竞争、请求幂等、无变化结果复用沿用原逻辑；GET 没有搜索副作用。UI 的 shoppingRequest 是当前版本实际发出的参数快照，未发出时为 null/缺省。

## 验收结果

| 场景 | 可控模型替身 | 真实模型 |
|---|---|---|
| A 完整乳液需求 | 检查实际请求：1件、20000、两条容量、正装、保湿偏好 | 通过，v1，1次搜索 |
| B 容量改200–300ml | 两条范围替换，其他条件保留 | 通过，v2，2次搜索 |
| C 容量不限，预算180 | 删除容量，18000，保留包装/偏好 | 通过，v3，3次搜索 |
| D 保湿必须满足 | 转文本硬条件，去除重复软目标 | 通过，v4，4次搜索 |
| E 不限定品牌 | 既有品牌可删除；没有品牌时不虚构/不搜索 | 无既有品牌，维持v4和4次搜索 |
| F 冲突/非法操作符/Schema | 明确错误，既有需求/结果不破坏 | 修复提示词前捕获非法结构且没有搜索；恶意/矛盾输入未再消耗真实调用 |
| G 重复/并发/迟到 | 直接检查新版本实际请求；模型/Shopping晚到都不覆盖；重复不搜索 | 使用可控替身，未用不可控网络模拟并发 |

真实协议沿用第二阶段已核实的 BigBigAPI Chat Completions：`POST https://api.bigbigapi.com/chat/completions`，Bearer，stream:false，模型请求 ID `gpt-6.1-sol-plus`。本轮短连通测试成功。最初复杂需求30秒超时，随后严格校验拒绝模型混用全量偏好与嵌套证据；未放松校验，添加合法 JSON 示例并统一60秒上限后，五轮真实对话全部通过。记录在 `main-agent-contract-live.json`，每轮状态/请求、版本、搜索次数已实际断言。

浏览器额外真实首轮同样到达 result_ready，显示已连接、条件、偏好及实际请求，仍标 development_mock。随后通过表单将预算改为180 HKD，v2保留全部三个硬条件及保湿偏好、清空旧结果，再运行Stub正确发送18000港仙并返回v2模拟结果。截图见 `agent-contract-acceptance.png`。真实首轮单独请求见 `main-agent-shopping-request.json`。

## 检查与边界

最终 `npm test` 88/88 通过（原79 + 新增9项测试），`npm run lint` 无错误或警告，`git diff --check` 通过。`npx tsc --noEmit` 唯一错误：`lib/agent-b/index.ts:564` 的旧操作符 switch 不穷尽（TS2366）。这是**本轮扩展共享操作符触发的跨组兼容阻塞**，不能称为原本已有的 TS 错误。用户明确选择“不修改，交付时记录该类型检查阻塞”。因此未改 Agent B，也未关闭类型检查。

`npm run build` 再现前两阶段已有的 Turbopack 内部端口绑定 EPERM；`npm run build -- --webpack` 编译通过，随后同一 TS2366 阻塞类型阶段。没有删除有效校验或通过 ignoreBuildErrors 绕过检查。

Shopping 组仍需适配两个文本操作符（NFKC/大小写归一、未知事实不能当满足）、偏好 conditions 的 AND 与词数组 OR、相对权重、可选 id、allowAlternativeProducts、全数量 budget.scope 与期限字段。主 Agent 校验范围不表示现有 Agent A/B 已支持这些字段；真实 Shopping 接入前须实现或明确拒绝，不能静默忽略。新增 Candidate/merchant/quote/diagnostics 返回结构不在本轮实现范围。

ShoppingStub 不评估真实商品是否满足条件；只有开发流程模拟，价格保持 null/mock。没有真实 Shopping、授权、下单、支付、数据库迁移或部署。内存仓储重启丢失，不用于授权、预算或支付去重。

## 启动

在项目目录 `npm run dev`，打开 `/agent`，开始新任务，使用自然语言模式；结构化表单用于修正标量字段。服务端 `.env.local` 填写 LLM_API_KEY，修改配置需重启服务；不要粘贴密钥到聊天。真实检查手动运行 `node scripts/check-contract-model.mjs`，默认测试不访问模型服务。
