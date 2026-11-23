# 即页 · 即时交互页面生成器 MCP

即页（Instant Page MCP，简称 IPM）把数字员工手头这一项任务变成一张能查看、填写或确认的网页。日常问答留在聊天里。需要人录入资料、核对图片识别结果、从查询结果里选条件，或在 ERP 缺少现成列表时展示明细，数字员工可以用一次 MCP 调用出页，再用记录号或页号把提交接回原任务。

宿主提供已授权的数据、字段规则和业务动作。即页负责渲染、校验、保存与回读。图片识别、ERP 查询、正式审批和业务写入由宿主或接入系统执行。核心可独立安装，CodeFlowMu、微信桥和 Codex 都是可选接入方。

## 三种页面怎么用

| 场景 | 一次出页调用 | 用户提交后 |
| --- | --- | --- |
| 车辆登记 | `open_work_package` 接收字段、规则和下拉选项，返回表单与列表 | 按 `record_id` 读回一条登记记录 |
| ERP 二次查询 | `generate_interaction_page` 把查询候选项放进一次性选择页 | 按 `page_id` 读回选择，由宿主继续查询 |
| 图片识别核对 | `generate_interaction_page` 把识别结果预填到可编辑字段 | 按 `page_id` 读回最终提交的值 |

以下 JSON 文件是工具的 `arguments`。同一份登记定义可以重开。每次新的一次性交互页请换一个 UUID `request_id`，重试则沿用原来的请求号和规格。

### 1. 一次调用生成车辆登记表

调用 `open_work_package`，传一个新的 `package_ref` 和 `definition`。`definition.fields` 按录入顺序排列，每项指定字段标识、类型和校验规则。`list_columns` 指定列表显示哪些字段。示例包含车牌、车型、发动机号、车架号、长宽高、备注，以及黑色、红色、白色三个颜色选项。

打开返回的 `form_url` 可连续登记。打开 `list_url` 可看记录列表和单条详情。宿主从详情取得 `record_id`，调用 `get_work_package_record({package_ref, record_id})` 读取类型化的提交值。

在同一授权快照中，重开时只传 `package_ref` 即可。重传相同定义也会打开原登记册。修改字段规则或选项时使用新引用。宿主已有随版本发布的工作包页面时，可以通过适配器按固定版本打开。

[可直接调用的车辆登记请求](examples/work-package-vehicle-registration.json)

### 2. 从 ERP 查询结果生成一次性选择页

例如，第一次查询得到三块候选车牌，下一步要查张三某个月的租金收入。数字员工把司机、月份和指标展示在页面上，请用户只选车牌。

调用 `generate_interaction_page`，在 `specification.fields` 中用 `type: "select"`、`options` 和 `required` 描述候选与规则，再用输入区块的 `field_ref` 放置下拉框。用户提交时，服务端校验必填和选项是否在本次允许的范围内。

宿主保存 `page_id` 与原查询的关联。调用 `get_interaction_result({page_id})` 读回 `submission.values.plate`，将它与已知的司机、月份和指标合并，再调用 ERP 查询。

如果还需要显示 ERP 缺少的列表，宿主可把已授权的行和列放入上下文的 `tables`，在同一页添加 `table` 区块，用 `source_ref` 引用。纯展示页可将 `actions` 设为空数组。

[可直接调用的租金查询选择页请求](examples/page-rent-query.json)

### 3. 把图片识别结果放进可编辑的核对页

例如，数字员工从行驶证照片读出车辆所有人、车牌、车架号和尺寸，交给即页预填，让用户对照原件修改。识别不清的发动机号可以留空。

调用 `generate_interaction_page`，在 `specification.fields` 定义输入字段，将识别值按字段标识放入 `specification.initial_values`。所有预填值都可直接在对应输入框修改。核对无误可直接提交，清空选填项会省略该字段。

用 `get_interaction_result({page_id})` 读到的 `submission.values` 是最终提交值。例如把车辆所有人改为「示例运输二部」、清空选填备注，回执就包含更正后的所有人，且省略备注。

[可直接调用的行驶证核对页请求（合成数据）](examples/page-license-review.json)

一次性表单可用 `{"kind":"submit_response","reference":"page-submit"}` 收集答复。正式业务动作由宿主授权。

## 本机安装与接入

需要 Node.js 22 或更新版本。核心运行时零 npm 依赖。下面在 Windows PowerShell 中从本仓库根目录打包并安装。

```powershell
New-Item -ItemType Directory -Force -Path release | Out-Null
npm pack --pack-destination release
npm install -g .\release\instant-page-mcp-0.4.1.tgz
instant-page-mcp-demo
```

演示在终端打印车辆表单和记录列表链接。按 Ctrl+C 停止后，可用 `instant-page-mcp-demo --interaction` 体验一次性页面。

实际接入分为持续运行的页面服务和按 stdio 启动的 MCP 进程。以下用空的示例授权目录启动服务，README 中三个内联请求都可在这个范围内运行。

```powershell
$pkgDir = Join-Path (npm root -g) 'instant-page-mcp'
$env:PAGE_MCP_CONTEXT_FILE = Join-Path $pkgDir 'examples/local-context.json'
$env:PAGE_MCP_DATA_DIR = Join-Path $PWD.Path 'ipm-data'
$env:PAGE_MCP_PORT = '8765'
$env:PAGE_MCP_CAPABILITY = node -p "require('node:crypto').randomBytes(32).toString('base64url')"

# 使用 Codex 时，可在启动页面服务前注册 MCP
codex mcp add instant-page-mcp --env "PAGE_MCP_PORT=$env:PAGE_MCP_PORT" `
  --env "PAGE_MCP_CAPABILITY=$env:PAGE_MCP_CAPABILITY" -- node (Join-Path $pkgDir 'bin/mcp.mjs')

instant-page-mcp-service
```

其他 MCP 宿主也可按 stdio 启动 `node <pkgDir>/bin/mcp.mjs`，给子进程注入同一个 `PAGE_MCP_PORT` 和 `PAGE_MCP_CAPABILITY`。服务监听本机回环地址。跨设备交付页面时，宿主通过已认证的 HTTPS 网关发布。

## 六个工具

| 工具 | 用途 |
| --- | --- |
| `describe_page_context` | 查看当前授权范围内的字段、数据引用、动作和登记册 |
| `open_work_package` | 按 `package_ref` 打开登记册，或传 `definition` 创建表单与列表 |
| `get_work_package_record` | 按 `package_ref` 和 `record_id` 读取一条记录 |
| `generate_interaction_page` | 按 `request_id` 和 `specification` 生成本次独立页 |
| `get_interaction_page` | 按 `page_id` 查看页面入口和状态 |
| `get_interaction_result` | 按 `page_id` 读取提交状态和最终值 |

## 开发与验证

在仓库根目录运行 `npm test`。可选微信桥用 `npm --prefix integrations/weixin ci --ignore-scripts --no-audit --no-fund` 安装依赖，再运行 `npm --prefix integrations/weixin test`，验证 stdio 调用和模拟投递。

- [开发手册与可选接入说明](通用即时页面生成器MCP-开发手册.md)
- [数字员工使用技能](skills/instant-page-mcp/SKILL.md) · [字段规范](schemas/work-package-fields-v1.schema.json) · [版本化工作包页面声明](integrations/work-package/example-binding.json)
- [工作包适配器](integrations/work-package/adapter.mjs) · [经过摘要校验的冻结资源](integrations/work-package/frozen-asset.mjs)
