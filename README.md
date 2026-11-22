# 即页 · 即时交互页面生成器 MCP

即页（Instant Page MCP，简称 IPM）为数字员工提供按需出页能力。日常交流留在原对话。需要人填写、查看明细或确认决定时，为本次任务生成一张独立网页。工作包可提供版本化的页面定义，也可用同一套字段定义生成表单、记录列表和详情。

核心使用 Node.js 22 或更新版本，运行时零 npm 依赖。CodeFlowMu 与微信桥均为可选接入方。

## 独立安装

下面用 PowerShell 演示。候选包可直接从本地 tarball 安装。

```powershell
npm install -g 'E:\instant-page-mcp\release\instant-page-mcp-0.4.1.tgz'
instant-page-mcp-demo
# 退出上一个演示后运行一次性交互演示
instant-page-mcp-demo --interaction
```

演示输出本机链接。用浏览器打开录入页，提交后可以继续登记或进入列表，也可从列表打开单条详情。Ctrl+C 退出演示。发布后可用 `npm install -g instant-page-mcp@0.4.1` 安装。

## 接入独立宿主

用下列配置在本机启动持久页面服务。示例授权目录可替换为宿主为当前任务准备的 JSON。

```powershell
$pkgDir = Join-Path (npm root -g) 'instant-page-mcp'
$env:PAGE_MCP_CONTEXT_FILE = Join-Path $pkgDir 'examples/training-context.json'
$env:PAGE_MCP_DATA_DIR = Join-Path $PWD 'ipm-data'
$env:PAGE_MCP_PORT = '8765'
$env:PAGE_MCP_CAPABILITY = node -p "require('node:crypto').randomBytes(32).toString('base64url')"
instant-page-mcp-service
```

MCP 宿主按 stdio 启动 `node <pkgDir>/bin/mcp.mjs` 并通过宿主的秘密配置注入同一个 `PAGE_MCP_CAPABILITY` 和 `PAGE_MCP_PORT`。Windows 宿主可直接填写 `node` 和脚本绝对路径，避免依赖对 npm 命令 shim 的支持。使用 `PAGE_MCP_LINK_TTL_SECONDS` 可为新交互页设置浏览器访问期限。页面服务监听本机回环接口，跨设备访问使用宿主的认证 HTTPS 网关。

| 工具 | 用途 |
| --- | --- |
| `describe_page_context` | 读取当前授权目录的可用引用 |
| `open_work_package` | 用 `package_ref` 获取录入和列表地址 |
| `get_work_package_record` | 用 `package_ref` 和 `record_id` 读取指定记录 |
| `generate_interaction_page` | 用 UUID `request_id` 和页面规格生成独立页 |
| `get_interaction_page` | 按 `page_id` 获取入口与状态 |
| `get_interaction_result` | 按 `page_id` 回读用户提交 |

宿主生成页后保存页号和发起任务的关联。回读提交后，业务系统按原任务的权限和状态办理。工作包提供页面声明时，用 `instant-page-mcp/work-package/frozen-asset` 读取经摘要校验的冻结资源，再用 `instant-page-mcp/work-package/adapter` 的 `openPackageView` 按固定包版本和入口键出页。配置网关时可从 `instant-page-mcp/service` 导入 `createPageService`。

- [智能体 SKILL.md](skills/instant-page-mcp/SKILL.md)
- [交互请求](examples/page-training.json) · [授权目录](examples/training-context.json)
- [随包页面声明](integrations/work-package/example-binding.json) · [字段规范](schemas/work-package-fields-v1.schema.json)
- [开发手册与可选接入说明](通用即时页面生成器MCP-开发手册.md)

## 源码验证

在仓库根目录运行 `npm test`。可选微信桥用 `npm --prefix integrations/weixin ci --ignore-scripts --no-audit --no-fund` 安装依赖，再运行 `npm --prefix integrations/weixin test`，验证 stdio 调用和模拟投递。
