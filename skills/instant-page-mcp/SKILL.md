---
name: instant-page-mcp
description: 用即页 MCP 为当前任务生成填写、明细查看、核对或审批页面，或按固定版本打开工作包页面并回读提交。简短问答直接在聊天中回复。
---

# 即页（IPM）

- 简短信息在原对话中答复。需要填写字段、查看较多明细或明确作决定时，再为当前任务出页。
- 调用 `describe_page_context({})` 发现已授权引用。从当前授权目录选取共享字段、事实、表格列和业务动作。宿主在数据进入目录前完成筛选和脱敏。

## 工作包登记

- 工作包指明页面入口时，宿主用冻结包资源和可信摘要读取页面声明，调用 `openPackageView`，传入固定的包、版本、工作标识和入口键。资源缺失、版本或入口不匹配时报告错误。适配器入口见项目 README。
- 对话中已经明确了要登记的字段时，给本次登记册选一个新的 `package_ref`，调用 `open_work_package({package_ref, definition})`。`definition` 提供 `label`、按顺序排列的 `fields`（每项含 `ref`、`label`、`type` 和对应规则）及可选 `list_columns`。下拉字段用 `type: "select"` 和 `options`。重开原登记册时只传引用。修改定义时另选引用。见[车辆登记请求](../../examples/work-package-vehicle-registration.json)。
- 工作包只声明参数时，由宿主配置 `fields` 与 `work_packages`，调用 `open_work_package({package_ref})`，按需要交付 `form_url` 或 `list_url`。列表可打开单条详情。
- 业务处理用本次提交的 `record_id` 调用 `get_work_package_record({package_ref, record_id})`。把登记册引用和记录号一起绑定到原任务。

## 当前任务的独立页面

1. 给本次操作创建 UUID `request_id`。调用 `generate_interaction_page({request_id, specification})`。规格提供 `title`、`purpose`、有序 `blocks` 和 `actions`。可用区块为 `narrative`、`facts`、`table`、`input`。每个字段只放一次。业务动作使用目录中的 `kind` 和 `reference`，只读页用空动作数组。
2. 保存 `page_id` 到原任务或启动请求的映射，把该页链接发回发起处。同一请求重试沿用原 UUID 和规格。`get_interaction_page({page_id})` 可重新取得入口。本机回环链接用于本机浏览器，其他设备使用宿主的认证 HTTPS 网关。
3. 用原授权范围调用 `get_interaction_result({page_id})`。`open` 表示等待，`submitted` 返回 `submission.action`、`reference` 和 `values`。按保存的映射处理并回复原会话。业务系统复核权限和对象版本，按页号去重办理，取得业务回执后再告知办理结果。

- 上一步查询已返回候选项时，可在 `specification.fields` 放入本页的 `select` 字段、`options` 和校验规则，并用输入区块引用字段。一次性收集答复可显式使用 `{"kind":"submit_response","reference":"page-submit"}`。宿主用页号关联已知查询条件，将回读的选择与这些条件合并后调用业务查询。见[二次查询示例](../../examples/page-rent-query.json)。

- 需要用户核对照片或文件识别结果时，用 `specification.initial_values` 预填识别值，让用户直接修改对应字段。保留拿不准的字段供人工核对；以提交回执作为确认结果。见[行驶证核对示例](../../examples/page-license-review.json)。

[交互请求样例](../../examples/page-training.json) · [对应授权目录](../../examples/training-context.json) · [接入说明](../../README.md)
