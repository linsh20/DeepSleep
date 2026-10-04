# 多平台护肤品 Demo：团队交接入口

本目录供演示主持人、前端和 Agent 开发成员交接使用。仅演示两个细分类别：**Moisturizer（保湿面霜/乳液）**与 **Toner（爽肤水/化妆水）**。

## 先拿到正确版本

代码及数据库位于远端分支 `feat/multiplatform-skincare-main`。请从该分支获取文件，不要只复制单个 `.db`：读取 `product_offers` 的适配代码也在同一分支。不要把本演示库覆盖到原始 `data/watson/data/products.db`。

| 阅读顺序 | 文件 | 用途 |
| --- | --- | --- |
| 1 | [两个授权表案例与需求转录值](DEMO_CASES.md) | 按授权表格式展示模拟填写结果，并转录到当前 `/agent` 表单 |
| 2 | [数据与字段交接](DATA_AND_CONTRACT.md) | 数据范围、启动、Agent 字段、核验边界 |
| 3 | [原始调用说明](../../data/watson/MULTIPLATFORM_DEMO.md) | API 命令、重建 SQL、验证命令 |

## 五分钟启动

前置：Node.js 满足本仓库 `package.json` 的 `>=24.13.0`，依赖已通过 `npm ci` 安装。在仓库根目录运行：

```powershell
.\data\watson\run_multiplatform_demo.ps1
```

脚本设置 `WATSONS_DB_PATH`，服务默认在 `http://localhost:3000`。它使用 `data/watson/data/products.demo-multiplatform.db`，不修改原始数据库。

1. 打开 `http://localhost:3000/agent`，点“开始新任务”。
2. 按 [DEMO_CASES.md](DEMO_CASES.md) 填写第一个需求，保存并运行 Shopping 搜索与审核。
3. 重新点“开始新任务”，按第二个案例填写并运行。不要在同一需求版本里把面霜改成爽肤水来充当两个独立案例。
4. 若需快速检查三平台数据，可使用文档中的两个 `/api/products/search` 请求样例。

## 演示时必须说清

- SaSa、Mannings 报价是**模拟数据**，不是实时商城抓价；Watsons 也是历史快照，不是结账价。
- 跨平台同一商品应保留相同 `productId`、`skuId`，由不同 `offerId` 区分报价。
- 缺少实时运费、可配送性和结账总价时，`needs_verification` 是预期结果；不能宣称三个平台均可直接购买。
- `/agent-risk` 的有限授权只覆盖独立的沙盒测试商品 `sandbox-lotion`；这两种护肤品需求**不要**提交为支付授权或执行付款。
