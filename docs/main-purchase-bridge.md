# 主 Agent 与沙盒购买桥接

## 权威来源与身份

主 Agent 的 `deepsleep_demo` HttpOnly / SameSite=Strict cookie 是服务端随机生成的演示会话（30天）。SQLite 只保存其 SHA256；该散列作为任务归属。所有桥接接口复用此 cookie，不接受 userId、任务快照、价格、商户或支付凭证。它仍是本地开发会话，不是生产用户认证。

`main_tasks` 是桥接任务唯一权威来源，保存完整任务、需求版本、对话、搜索状态和事件。`SqliteTaskRepository` 实现原 TaskRepository；修改在短 `BEGIN IMMEDIATE` 事务中复核版本。原状态机、模型 conversationRevision 和迟到 Shopping 结果检查保留。

同一 `.data/sandbox-purchase.sqlite` 新增：

- main_sessions：持久化会话散列。
- main_tasks：主任务及归属。
- main_requests：请求指纹、完成响应或安全错误；同进程共享未完成 Promise，跨进程以唯一键先认领，避免重复追加消息或工具调用。
- main_purchase_links：taskId / owner / requirementVersion / planId，任务版本唯一。
- main_purchase_requests：准备请求去重；同 requestId 改任务或版本拒绝。

进程崩溃中断的请求不会被自动重放：返回 REQUEST_PENDING，先读取当前任务；这不是后台恢复调度器。旧内存会话不能仅凭旧 cookie 获得新持久化任务权限，且没有可从重启后内存恢复的历史。新 SQLite 任务不再随服务重启丢失。

原 sandbox_* 表和历史交易全部保留。为兼容原订单表外键，会写入 sandbox_tasks 历史投影，但该投影**不是桥接执行授权来源**。支付服务新增可选 currentTask 读取口：执行入口、创建付款前和确认付款前读取 main_tasks。主 Agent 桥接及 Webhook runtime 均注入该读取口。没有 main_purchase_links 的旧 CLI/独立沙盒案例保持原路径，绝不转移给浏览器。

所有关联可追溯：main task → link.plan_id → plan / quote.quoteId → operation.operationId → order.orderId / paymentId。需求变化使旧方案标为 stale，拒绝发起付款；GET、主动核对和商户恢复仍能读取旧交易事实，不把已支付订单变成取消。

## 服务端方案来源

当前 `sandboxSource` 只接受以下明确测试需求：category="沙盒测试乳液"、query="测试乳液 200ml"、quantity=1、currency=HKD、destination="香港"（也接受既有模拟配送地区文本）。这是虚拟商品，无真实购买。

独立服务器 fixture：productId=sandbox-lotion、skuId=sandbox-lotion-200ml、merchantId=demo-merchant；报价商品17000港仙+运费1000港仙=18000港仙，有效15分钟。预算按原 gate 检查。排除该商品返回 NO_MATCH。

任意额外硬条件或偏好均返回 NEEDS_VERIFICATION，不声称测试商品已满足品牌/功效等事实；不支持的商品、数量或地区也停止。ShoppingStub 的未知价格完全不参与报价。未来在该 source 位置接入**服务端已保存**的 Shopping 方案，提供事实校验及可追溯报价；不能从客户端提交快照。

一个任务版本只有一个方案/操作；报价过期不偷偷重新报价或新建支付。已有旧版本支付创建后仍未确定结果时，准备新版本返回 PRIOR_PAYMENT_UNRESOLVED，先恢复原操作。付款与订单状态分开，unknown 不转换成 failed。

## 前端接口

先通过既有 POST /api/agent/session 和主任务接口创建/保存需求。新接口全部在 `/api/agent/purchases/`，沿用同源 POST 和服务端会话；仅 development 开放，GET 无支付或查询 Stripe 的业务副作用。请求体白名单、4KB限制。

| 方法及路径 | 请求 | 响应 / 作用 |
| --- | --- | --- |
| POST prepare | taskId, expectedVersion, requestId | 只准备固定测试方案和报价，无付款 |
| POST execute | taskId, planId, expectedVersion, requestId, testPermission:true | 原 PurchaseExecutionService 执行/恢复同一操作 |
| GET state?taskId=… | 任务ID | 只读本地关联和订单/付款事实，包含旧版本历史 |
| POST recover | taskId, planId, requestId | 显式查询已有 Stripe 对象/恢复商户；不创建或确认新的付款 |

准备示例：

```json
{"taskId":"c11ea1ed-f23c-4201-b0f0-c55fb39a601d","expectedVersion":1,"requestId":"prepare-example-001"}
```

执行示例（方案 ID 必须来自服务端 prepare；不要再次执行示例交易）：

```json
{"taskId":"c11ea1ed-f23c-4201-b0f0-c55fb39a601d","planId":"4a6f70da-92fd-477c-916b-91cc69df5217","expectedVersion":1,"requestId":"execute-example-001","testPermission":true}
```

响应形状（下面是实际浏览器测试摘要；完整接口另含 plan、quote、events、testPermission 等）：

```json
{
  "taskId":"c11ea1ed-f23c-4201-b0f0-c55fb39a601d",
  "requirementVersion":1,
  "intent":"purchase",
  "purchases":[{
    "mode":"sandbox_only",
    "merchantEnvironment":"simulated",
    "paymentEnvironment":"stripe_sandbox",
    "operation":{
      "operationId":"b5e4ee18-eb34-494d-9073-6ba6b1d92a15",
      "requirementVersion":1,
      "paymentId":"pi_3UMX1HBbhxBsCzjY1lCSkoRh",
      "paymentStatus":"succeeded",
      "errorCode":null
    },
    "order":{"orderId":"demo_049dcb83-bb22-4acb-a373-197fd12e54f8","status":"confirmed"},
    "stale":false,
    "quoteExpired":false
  }]
}
```

支付状态沿用原模块：无operation显示not_started；creating/confirming/processing为处理阶段；requires_action为需验证；unknown为结果未知；failed/canceled/succeeded分别显示原始事实。requires_confirmation表示对象已创建但尚未确认。订单独立为无订单、pending_payment、confirmed、confirmation_failed。成功付款不写入搜索状态机。

错误统一为 `{error:{code,message}}`。常见：SESSION_REQUIRED、NOT_FOUND、STALE_VERSION、COMPARE_NOT_EXECUTABLE、NEEDS_VERIFICATION、NO_MATCH、OVER_BUDGET、QUOTE_EXPIRED、REQUEST_CONFLICT、PRIOR_PAYMENT_UNRESOLVED。超时后请查询原任务并主动恢复，不创建另一个任务掩盖未知支付。

## 调试页面与验收

启动：Node >=24.13，保留已有 .env.local，`npm run dev -- --hostname 127.0.0.1 --port 3000`，打开 `/agent`。

1. 开始新任务，在结构化表单填写上述测试需求，意图purchase，预算200 HKD含运费。
2. 保存需求；在独立购买面板准备方案，检查报价180 HKD。
3. 勾选一次沙盒测试许可，点击运行沙盒购买。
4. 用只读查询看到同任务的 payment succeeded / order confirmed。
5. 刷新和服务重启后，页面用 localStorage 中任务ID配合服务端持久会话恢复原任务；任务ID本身不赋予权限。再点击只读查询恢复订单。历史CLI记录不可见。

2026-10-04 浏览器真实验收：当前浏览器会话新建上述任务，v1，方案4a6f70da-…，报价d559630b-72de-4a93-94ef-699c21d48698。实际Stripe PaymentIntent为pi_3UMX1HBbhxBsCzjY1lCSkoRh；180 HKD测试金额，订单demo_049dcb83-… confirmed。不使用旧CLI pi_3UMVxL…冒充。本轮用结构化表单形成主任务，不额外调用真实模型；模型仅理解需求，不拥有付款工具。服务重启和浏览器刷新后，同一cookie恢复原任务及订单；再次执行同一方案仍只有一次payment_create和一次payment_confirm。随后将预算改为180 HKD，主任务变成v2，v1成功交易仍完整展示。真实Webhook两个事件均processed=1，其中一个并发待处理事件经Stripe官方重投完成。截图见 main-purchase-bridge-acceptance.png。

测试：130/130通过（新增11个桥接测试），覆盖所有本轮要求及未确定旧付款阻止替代方案、持久化请求认领、迟到模型响应。原支付测试覆盖拒付、需验证、超时、通知去重和乱序。

lint通过；tsc只有既有 `lib/agent-b/index.ts:564 TS2366`。默认Turbopack build仍遇到绑定端口EPERM；Webpack编译通过，随后同一Agent B类型错误阻塞。未关闭检查，未修改Shopping组代码。

## 范围

未接真实Shopping、生产认证、持续授权、正式风控、退款或物流。正式ExecutionGate仍在原支付模块的gate接口替换，production缺策略仍拒绝。支付SDK、幂等键、超时恢复、通知验签/去重逻辑未重写。app/shop和components/shop由前端组维护，本轮未修改。
