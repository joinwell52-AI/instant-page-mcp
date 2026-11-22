---
name: instant-page-mcp
description: 用即页 MCP 为当前任务生成填写、明细查看、核对或审批页面，或按固定版本打开工作包页面并回读提交。简短问答直接在聊天中回复。
---

# 即页（IPM）

- 简短信息在原对话中答复。需要填写字段、查看较多明细或明确作决定时，再为当前任务出页。
- 调用 `describe_page_context({})` 发现已授权引用。只使用当前授权目录中的字段、事实、表格列和动作。宿主在数据进入目录前完成筛选和脱敏。

## 工作包登记

- 工作包指明页面入口时，宿主用冻结包资源和可信摘要读取页面声明，调用 `openPackageView`，传入固定的包、版本、工作标识和入口键。资源缺失、版本或入口不匹配时报告错误。适配器入口见项目 README。
- 工作包只声明参数时，由宿主配置 `fields` 与 `work_packages`，调用 `open_work_package({package_ref})`，按需要交付 `form_url` 或 `list_url`。列表可打开单条详情。
- 业务处理用本次提交的 `record_id` 调用 `get_work_package_record({package_ref, record_id})`。把登记册引用和记录号一起绑定到原任务。

## 当前任务的独立页面

1. 给本次操作创建 UUID `request_id`。调用 `generate_interaction_page({request_id, specification})`。规格提供 `title`、`purpose`、有序 `blocks` 和 `actions`。可用区块为 `narrative`、`facts`、`table`、`input`。每个字段只放一次。动作使用目录中的 `kind` 和 `reference`，只读页用空动作数组。
2. 保存 `page_id` 到原任务或启动请求的映射，把该页链接发回发起处。同一请求重试沿用原 UUID 和规格。`get_interaction_page({page_id})` 可重新取得入口。本机回环链接用于本机浏览器，其他设备使用宿主的认证 HTTPS 网关。
3. 用原授权范围调用 `get_interaction_result({page_id})`。`open` 表示等待，`submitted` 返回 `submission.action`、`reference` 和 `values`。按保存的映射处理并回复原会话。业务系统复核权限和对象版本，按页号去重办理，取得业务回执后再告知办理结果。

[交互请求样例](../../examples/page-training.json) · [对应授权目录](../../examples/training-context.json) · [接入说明](../../README.md)
