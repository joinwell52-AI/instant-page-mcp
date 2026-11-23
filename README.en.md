# Instant Page MCP (IPM) · 即页

[简体中文](README.md) · **English**

IPM gives AI agents a web page for a specific task. Use a page when people need to enter records, choose a query parameter, inspect a table, or confirm values extracted from a document. The host supplies authorized data and rules. IPM renders the page, validates submissions, and lets the host read them back. OCR, ERP queries, business writes, and approval permissions are handled by the host and its integrations.

## Examples

An agent composes each page from instructions, facts, tables, fields, and actions. The examples below show complete tool arguments and how to retrieve the result.

| Task | Generate | Read back |
| --- | --- | --- |
| Register vehicles | `open_work_package` with a new `package_ref` and a `definition` with fields, rules, and options. Returns a form and record list. | Use `get_work_package_record({package_ref, record_id})`. [Vehicle registration](examples/work-package-vehicle-registration.json) |
| Select an ERP query parameter | `generate_interaction_page` with a required `select` field populated from authorized query results. | Use `get_interaction_result({page_id})`, then combine the selection with the known query conditions. [Rent query](examples/page-rent-query.json) |
| Review extracted document fields | `generate_interaction_page` with `specification.fields` and `specification.initial_values`. The reviewer can edit, clear, or submit the prefilled values. | Use `get_interaction_result({page_id})` to read the submitted values. Cleared optional fields are omitted. [Vehicle license review with synthetic data](examples/page-license-review.json) |

Use a new UUID `request_id` per independent page and reuse it with the same specification on retry. Reopen an existing register with just its `package_ref`. Use a new reference for a changed register definition. For a read-only page, pass `actions: []`. For simple collection, an inline form can use `{"kind":"submit_response","reference":"page-submit"}`.

## Appearance, languages, and images

Set `specification.appearance` for an interaction page or `definition.appearance` when creating a register. Configuration is optional and the defaults are `default`, `stacked`, and `zh-CN`.

| Setting | Values |
| --- | --- |
| `theme` | `default` (green), `blue`, `mono` |
| `layout` | `stacked`, `grid` (two columns on wider screens), `wide` (more room for tables) |
| `locale` | `zh-CN` or `en` as the initial page language |

The language menu at the lower right switches between Simplified Chinese and English. Switching preserves current form entries and selected files. Built-in labels and messages follow the selection. Supply `appearance.translations` to switch the task title, description, or field labels, with a `zh-CN` and an `en` string for each translation. The IPM footer includes the package version.

```json
{
  "locale": "zh-CN",
  "translations": {
    "title": {"zh-CN":"信息录入","en":"Information form"},
    "fields": {"name":{"zh-CN":"名称","en":"Name"}}
  }
}
```

To accept one PNG or JPEG up to 10 MiB, add `attachment: {"label":"Product photo","required":false}` under `specification` or `definition`. The image and fields are committed together. The readback includes the filename, media type, size, and SHA-256. An authorized host can retrieve the original bytes using `POST /v1/pages/attachment` with `{page_id}` or `POST /v1/work-packages/attachment` with `{package_ref, record_id}`. Both use the page service's Bearer capability.

## Install and run locally

Requires Node.js 22 or later. The core has no npm runtime dependencies. Codex, CodeFlowMu, and the WeChat bridge are optional integrations. In Windows PowerShell, run from the repository root:

```powershell
New-Item -ItemType Directory -Force -Path release | Out-Null
npm pack --pack-destination release
npm install -g .\release\instant-page-mcp-0.4.1.tgz
instant-page-mcp-demo
```

Open the URLs printed in the terminal. Stop the demo with Ctrl+C and run `instant-page-mcp-demo --interaction` to try single-use pages.

Run a persistent browser service and a separate MCP stdio process for host integration. The bundled empty context supports the inline examples above.

```powershell
$pkgDir = Join-Path (npm root -g) 'instant-page-mcp'
$env:PAGE_MCP_CONTEXT_FILE = Join-Path $pkgDir 'examples/local-context.json'
$env:PAGE_MCP_DATA_DIR = Join-Path $PWD.Path 'ipm-data'
$env:PAGE_MCP_PORT = '8765'
$env:PAGE_MCP_CAPABILITY = node -p "require('node:crypto').randomBytes(32).toString('base64url')"

# Optional Codex registration
codex mcp add instant-page-mcp --env "PAGE_MCP_PORT=$env:PAGE_MCP_PORT" `
  --env "PAGE_MCP_CAPABILITY=$env:PAGE_MCP_CAPABILITY" -- node (Join-Path $pkgDir 'bin/mcp.mjs')

instant-page-mcp-service
```

For another host, launch `node <pkgDir>/bin/mcp.mjs` over stdio and supply the same `PAGE_MCP_PORT` and `PAGE_MCP_CAPABILITY`. The local service binds to loopback. For access from another device, publish links through an authenticated HTTPS gateway controlled by the host.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `describe_page_context` | Discover authorized fields, data references, actions, and registers |
| `open_work_package` | Open a register or define a form and record list |
| `get_work_package_record` | Read a saved record by register reference and record ID |
| `generate_interaction_page` | Create a page for the current task |
| `get_interaction_page` | Read the page URL and state by page ID |
| `get_interaction_result` | Read the submitted values and optional attachment metadata by page ID |

## Development

Run `npm test` from the repository root. For the optional WeChat bridge, run `npm --prefix integrations/weixin ci --ignore-scripts --no-audit --no-fund` and `npm --prefix integrations/weixin test`.

- [Agent usage guide](skills/instant-page-mcp/USAGE.en.md) · [Agent skill in Chinese](skills/instant-page-mcp/SKILL.md)
- [Field schema](schemas/work-package-fields-v1.schema.json) · [Versioned work package example](integrations/work-package/example-binding.json)
- [Integration manual in Chinese](通用即时页面生成器MCP-开发手册.md)
