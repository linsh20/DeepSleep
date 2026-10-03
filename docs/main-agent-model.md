# 第二阶段：真实模型需求理解与 ShoppingStub

第一阶段提交 `47c4a87` 保留。本轮分支从该提交延续，不合并其他分支。现有状态转换表、TaskRepository、ShoppingStub 保持使用；没有真实 Shopping、授权、订单或支付。

## 已核实的协议和未完成的连通验收

2026-10-03 检查供应商官方 [使用指南](https://bigbigapi.com/app/guides) 的「OpenAI 协议（SDK / curl）」章节：

- 根地址 `https://api.bigbigapi.com`。
- `POST /chat/completions`，不额外加 `/v1`。文档另列兼容旧路径 `/openai/v1/chat/completions`，本实现不使用或自动探测旧路径。
- Bearer 鉴权、JSON 请求、`messages` 数组、`choices[0].message.content` 响应。
- 使用用户指定的 `gpt-6.1-sol-plus`，不依据模型名字或密钥前缀选择协议，不自动换模型。
- `stream:false`，不使用 SDK、原生 tool calling 或未经供应商确认的 response_format 参数。模型结构输出通过提示词和运行时校验实现。

核实路径：公开首页导航脚本链接 `/app/docs`，其 SPA 重定向 `/guides`；公开指南资源 `https://bigbigapi.com/app/assets/GuidesView-C2WR32bM.js` 展示上述请求示例。资源文件哈希可能变化，应以指南为准。

本机当前没有 `.env.local`。已执行一次 `node scripts/check-llm.mjs`，结果 `MODEL_NOT_CONFIGURED`，没有发送带鉴权请求。因此尚未实际确认供应商接受该模型 ID，也没有真实模型对话成功证据。不能将单元测试替身称为真实连通。

用户在项目根目录本地创建 `.env.local`：

```dotenv
LLM_API_KEY=在本机填写供应商密钥
```

该文件已被仓库 `.gitignore` 忽略，不要把密钥发到聊天或提交。运行：

```sh
node scripts/check-llm.mjs
npm run dev -- --hostname 127.0.0.1 --webpack
```

短测试仅请求一次「Reply only OK.」，20 秒超时，非流式；只输出通过/错误码/HTTP 状态，不输出鉴权头、密钥或供应商响应体。失败后不自动重试或换模型。配置后重启 dev，再打开 `/agent`。Next 仅在服务端通过 `process.env.LLM_API_KEY` 读取；不使用 NEXT_PUBLIC_。真实少量验收应先运行短测试，再执行下方四轮对话。

## 文件和接口

| 文件 | 职责 |
|---|---|
| `services/main-agent/model-interpreter.ts` | BigBigAPI 传输、连接状态、模型解释器、严格输出校验、带证据的变更合并、上下文裁剪 |
| `services/main-agent/money.ts` | HKD 十进制元与整数港仙的确定性转换 |
| `services/main-agent/requirement-interpreter.ts` | 输入补充 currentIntent；保留原解释器接口与开发表单适配器 |
| `services/main-agent/orchestrator.ts` | 新增 message；原状态转换与 apply 逻辑复用，模型不调用工具 |
| `services/main-agent/types.ts` | 向后兼容的 messages / conversationRevision 可选字段 |
| `services/main-agent/http.ts`、`runtime.ts` | 演示会话校验、模型装配、共享连接状态 |
| `app/api/agent/messages/route.ts` | 消息写接口 |
| `app/api/agent/model/route.ts` | 只读连接状态，绝不触发探测或模型调用 |
| `components/agent-debug.tsx` | 聊天与结构化表单两个明确区域、HKD 元输入、消息错误与连接状态 |
| `scripts/check-llm.mjs` | 本地读取 .env.local 的一次非流式连通测试 |
| `tests/main-agent-model.test.mjs` | 模型替身、传输替身、竞争、错误、金额与 HTTP 验收 |

新增消息 API（沿用 HttpOnly 演示会话和同源请求校验）：

```http
POST /api/agent/messages
Content-Type: application/json
```

```json
{
  "requestId": "message_0001",
  "taskId": "服务端创建的任务ID",
  "expectedVersion": 2,
  "message": "预算改成 180，其他不变"
}
```

返回 `{task: MainTask}`，包含当前草稿、版本、结果及消息。输入/归属/初始版本错误用 400/404/409；已接收消息的模型失败保存在 `task.messages[].errorCode`，该请求仍返回任务快照 HTTP 200，便于展示失败且不丢已有需求。不要只凭 HTTP 200 认定模型成功。相同 requestId 重发返回原快照，不再次追加或调用；同键换内容返回 409。用新 requestId 表示主动重试。

`GET /api/agent/model`：`{model:{state,model,checkedAt?,code?}}`。state 为 missing_config / untested / connected / error。connected 仅在真实传输得到完整、未拒绝的响应后设置，表示最近一次连接成功，仍不保证模型结构和语义合格；结构错误在消息中展示。GET 无模型调用和搜索副作用。调试接口仍仅 development 开放。

## 解释器与金额契约

解释器输入是当前消息、currentIntent、currentDraft、近期上下文；不发送 taskId、userId、事件、环境配置、密钥或 Shopping 商品文本。最多取 8 条近期消息，每条 1500 字符，总计 6000 字符；当前消息上限 2000 字符。明显密钥/鉴权头/支付卡号模式在发送前拒绝，包括从表单带入的草稿；不是完整 DLP，勿输入支付或其他敏感资料。

内部模型 JSON 使用**变更集**，外部 `RequirementInterpreter` 仍返回完整 `requirementDraft`，原 requirements API 仍为完整替换：

```json
{
  "intent": "purchase",
  "intentEvidence": null,
  "requirementDraft": { "budget": { "amountHKD": "180" } },
  "evidence": { "budget.amountHKD": "预算改成 180" },
  "missingFields": [],
  "clarificationQuestions": []
}
```

未提到的字段省略并保留原值；明确删除使用 null，必须提供当前消息原文证据。金额数字必须出现在证据中，代码用十进制拆分转换为港仙，`200→20000`、`180→18000`、`0.29→29`，不让模型乘 100，也不接受 maxMinor 模型字段。预算 scope 未提及则保留；用户明确删除预算则不补默认值。query 修改部分规格时要求模型保留既有其他规格；真实模型的语义质量仍待实测。

运行时白名单校验意图、草稿、证据和两个字符串数组；多余权限/状态/身份字段、非法 JSON、缺失证据、虚构金额、非法范围全部拒绝。解析失败不记录原始模型文本。编排器再次用 clarify / completeRequirement 校验完整性，模型声称 missingFields=[] 无权授予就绪状态。最终澄清与结果回复由服务端生成，不冒充模型自由文本回复。

## 并发和故障

复用 TaskRepository.once：请求在异步模型调用前占用去重键。接受新消息时增加 conversationRevision，保存一次用户消息；解释返回时同时检查需求版本与对话序号。后来的消息即使没有改变需求，旧模型响应也不能覆盖它。结构化表单先修改需求时，旧模型输出同样拒绝。

模型每条消息只调用一次、20 秒超时并取消；无修复循环、无自动重试。错误显示 MODEL_NOT_CONFIGURED / MODEL_TIMEOUT / MODEL_REFUSED / MODEL_INVALID_RESPONSE / MODEL_INVALID_OUTPUT / MODEL_HTTP_ERROR / MODEL_UNAVAILABLE / MODEL_SUPERSEDED。保存错误助手消息，原草稿/版本/有效结果不受模型失败影响。

草稿完整且为 ready_to_search 时，代码调用原 search 方法；需求不变且已有结果时复用，包括无匹配、待核验或失败结果。用户可用原调试运行按钮显式重试失败的 Stub。需求更新立即清除旧结果并递增版本。正在执行的旧工具结果继续由第一阶段版本门禁丢弃。模型、商品文本均没有状态或交易写权限。

TaskError 使用跨路由包共享的 Symbol 标记，避免 Next.js 多个路由包中不同类实例导致配置缺失/归属错误丢失错误码；已加入回归测试。

内存限制不变：进程重启清空，无多实例/持久化保证，不用于授权、预算或支付去重。旧的第一阶段内存任务通过可选消息字段兼容。

## 验收记录

下列是**可控模型测试替身**的实际对话验收，不是真实模型输出：

| 用户输入 | 实际断言 |
|---|---|
| 帮我看看粉底 | compare、query=粉底；澄清预算等；不发明品牌/预算；0 次搜索 |
| 帮我买测试牌粉底02色30ml正装，一件，预算200港币含运费，配送香港 | purchase；20000 港仙；result_ready；调用一次 Stub |
| 预算改成 180，其他不变 | 保留商品/规格/数量/配送/scope；18000 港仙；版本+1；重新搜索 |
| 只是比较，先不要买 | compare；无交易；模型无交易接口 |
| 同 requestId 并发重发 | 只保存一对消息；只调用一次模型；已有方案不重新搜索 |
| 并发消息、表单修改、旧响应迟到 | 新版本或新对话获胜；旧解释 MODEL_SUPERSEDED |
| 超时、配置缺失、非法 JSON/结构/证据 | 明确错误；不破坏既有需求/结果；无新增搜索 |

全套 `npm test`：79/79（原 60 + 本轮 19）；`npm run lint`、`npx tsc --noEmit` 通过。默认 `npm run build` 提升权限后仍因 Turbopack 内部端口绑定 EPERM 失败，属于第一阶段已存在的环境限制；`npm run build -- --webpack` 通过。未修改脚本、依赖或有效校验。

浏览器实测：模型状态显示 missing_config；发送“帮我看看粉底”保存一对消息，助手准确显示 MODEL_NOT_CONFIGURED，需求仍为 v0/needs_clarification。随后通过保留的表单填写 180 HKD，成功保存为 v1，界面显示 180.00 元；运行 Stub 返回 result_ready / development_mock。截图见 `agent-model-acceptance.png`。

真实验收待用户本地配置密钥后完成。未接入真实 Shopping、授权、订单或任何支付；不部署、不合并、不推进后续阶段。
