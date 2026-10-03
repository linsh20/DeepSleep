# Watsons 香港护肤品全字段抓取

范围固定为此前确定的 **Skin Care → Face Treatment，类目 010200**。
不包括全部护肤品、其他类目、全部商品详情接口或评论接口。

Python 3.10+，仅标准库，无需 pip 安装、API Key、LLM、浏览器。当前项目把 `data/products.db` 作为默认搜索快照；抓取器本身仍可独立运行并生成新的时间戳目录。

## 运行

先完整解压，不能在压缩包预览中运行。Windows 双击 `run_online.bat`。
默认每次真正联网，创建独立快照，**不默认复用样例，也不覆盖旧快照**。

终端运行（Windows 用 `py -3`，macOS/Linux 用 `python3`）：

```powershell
py -3 crawl.py
py -3 crawl.py --output "D:\watsons-data"
```

Linux/macOS 也可 `bash run_online.sh`。逐页显示进度，单线程、每页间隔1秒，
每次请求30秒超时、最多尝试3次。401/403/429会停止，不尝试绕过限制。
抓取前应检查网站条款、robots 和数据使用许可；能访问接口不等于获得数据再利用许可。

## 断点续抓 / 离线导出

程序失败会打印已保存目录；复制该目录即可续抓。它只补抓缺页，不刷新已有页。
若商品总数在抓取中变化，程序拒绝把不完整结果标成成功；重新启动一个新快照。

```powershell
py -3 crawl.py --run-dir "data\20261003T120000Z_abcd1234"
py -3 crawl.py --offline --run-dir "data\20261003T120000Z_abcd1234"
```

若旧版在 Windows 最后报 `WinError 32 ... products.db.tmp`，12页原始数据没有丢失。
换用本版后直接恢复同一目录，例如：

```powershell
py -3 crawl.py --run-dir "E:\Code\watsons_full_fields\data\20261003T122707Z_4f06af85"
```

程序会读取已经保存的12页并重新导出，不会重新下载。如果仍提示文件被占用，
关闭 DB Browser、VS Code 的数据库预览、Excel 或其他正在查看 `products.db` 的程序后重试。

仓库中的 `data/` 是已完成的实际快照，不是运行时新抓取。
双击 `run_offline.bat` 或运行下列命令，可完全离线验证导出流程：

```powershell
py -3 crawl.py --offline --run-dir data
```

## 保存方式

每次联网建立 `data/UTC时间_随机后缀/`，其中文件：

| 文件 | 用途 |
|---|---|
| `raw/page_000.json` 等 | 完整分页 JSON；新抓取时保留返回字节，包含商品、分类、筛选项和分页信息 |
| `products.json` | 按 code 去重的全部商品对象：所有字段和嵌套数组/对象原样保留 |
| `products.db` | SQLite，常用列便于查询，`raw_json` 保存完整商品对象 |
| `products_confirmed_category.json` | 仅包含分类编号/名称明确属于 Face Treatment 的商品，独立严格视图 |
| `category_review.json` | 泛护肤类或分类不一致/缺失记录的审核名单；不自动删除 |
| `fields.json` | 全部顶层字段名、类型、存在率、非空率；0、false算有效值 |
| `manifest.json` | 类目、语言、抓取时间、每页哈希、数量、状态、来源页及异常信息 |

`products.json` 和 SQLite 中的 `raw_json` 是完整数据，不仅限于22个旧字段。
新增API字段会自动被保存，不需要改表。JSON保留 null、false、0、空数组等区别。
销量/评分等零值不代表缺失；成分字段有内容也不保证是完整INCI成分表。

不硬凑351件：接口类目页可能返回泛类目套装、跨类目推广品和缺失分类记录。
全部保留在完整输出，严格视图另存；此前筛成351件是启发式处理，不是API官方总数。
重复 code 的合并输出使用最后一条；各次完整出现记录仍在 raw 中，来源页写入 manifest。

## 数据读取

```python
import json
import sqlite3

with open("sample_snapshot/products.json", encoding="utf-8") as f:
    products = json.load(f)
print(products[0].get("elabIngredients"))

with sqlite3.connect("sample_snapshot/products.db") as db:
    for code, raw in db.execute("SELECT code, raw_json FROM products WHERE price <= ?", (250,)):
        product = json.loads(raw)  # 全字段，包括成分、促销、配送、全部图片
```

不要将完整原始数据都发给LLM；此程序负责保存，后续搜索时再挑所需字段。

## 限制与验证

“全字段”仅指所请求商品列表接口返回的全部字段，不是网站所有隐藏信息。
不抓评论正文，不下载图片文件（保留全部图片链接），不编造完整肤质或成分。
翻页非事务快照，网站并发上下架仍可能造成重复/遗漏；程序核对页数与返回条数、
记录重复数量并验证SQLite完整对象往返，但不能保证外部网站在抓取期间不变。
保存历史快照可追溯价格/库存，但不能当作实时购买凭据。

运行测试：`py -3 -m unittest discover -s tests -v`。

## 本次执行结果

已在 2026-10-03 实际联网运行，集成快照位于 `data/`：

- 12页，355个唯一商品编码，94个顶层字段。
- 349件分类明确匹配、2件泛护肤类套装、4件分类不一致或缺失。
- 所有355件原始对象均保留；未用固定数量截断或自动删除。
- 每页原始字节与哈希已保存，JSON/SQLite完整对象一致。
- 11项测试通过，涵盖未知字段、嵌套结构、离线、续抓、缺页、权限限制与分页变化。
