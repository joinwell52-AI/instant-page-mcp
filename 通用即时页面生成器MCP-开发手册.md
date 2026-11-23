# 通用即时页面生成器 MCP 开发手册

版本 0.4.0 · 面向 CodeFlowMu、工作包和消息渠道的开发者

## 1　人什么时候需要一张页面

员工在微信里问“城南店今天交了几辆车？”，数字员工可以直接回答。接着对方说“再登记一辆”，数字员工就在**这段对话**发一张填写页。员工点开，填完车牌、门店和里程，提交后能在登记册看到刚才那辆车。过一会儿他说“给我看今天还要核对的三辆车”，数字员工可以把本轮获准查看的三行记录和需要确认的问题组合成另一张独立页面。手机打开的是此次操作的具体页面。

| 对话中的需求 | 员工看到什么 | 结果回到哪里 |
|---|---|---|
| 日常问答 | 原聊天中的文字回复 | 原任务对话 |
| 查看进度 | 简短情况直接回复；数据较多时，生成带更新时间、选定列和明细的只读页 | 用户查看即可。进度以宿主提供的快照为准 |
| 工作包登记 | 录入表单；以后可以直接打开列表并查看单条详情 | 本次输入取得记录号，进入原登记册 |
| 审批 | 当前待办的材料、差异、意见字段和允许的决定按钮 | 页面记下所选动作，审批系统复核权限与待办版本，回写办理结果 |
| 发起任务 | 在发起对话中生成确认页，补齐负责人、截止日等必填项 | CodeFlowMu 按启动请求创建任务，把新任务号回到发起对话 |

每项任务可以有自己的聊天。宿主在出页时就记录对话与任务的关联，用户办理期间切换到另一项任务，结果仍回到发起处。下面以车辆交接介绍登记册，再用培训报名说明另一类工作如何使用同一套工具。

## 2　工作包已有页面模板，或只有输入参数

**工作包已有正式页面模板时，随包发布。** 包维护者在工作清单里声明资源，例如 `assets/pages/handover.json`。相对路径由各工作包约定，宿主按该包清单读取并校验文件，把解析后的声明交给适配器。宿主固定包标识、包版本和工作标识，再按当前步骤选择入口。同一工作可提供多个入口。页面定义发生变化时，维护者随新包版本发布；已经发出的页面和重试使用原来固定的资源。

```json
{
  "contract_version": "1.0",
  "package_id": "vehicle-handover",
  "package_version": "1.0.0",
  "work_id": "handover",
  "views": {
    "intake":  {"kind": "form", "collection_ref": "vehicle-intake"},
    "entries": {"kind": "list", "collection_ref": "vehicle-intake"}
  }
}
```

`intake` 和 `entries` 是工作包约定的入口键。两者共享 `collection_ref`，所以录入页新增的记录会出现在对应列表。第三种入口 `interaction` 接受完整的 `specification`，可以声明专用核对页及其操作。[完整的三入口声明](integrations/work-package/example-binding.json) · [页面声明 Schema 1.0](schemas/work-package-views-v1.schema.json)

**工作包只有输入参数时，直接生表。** 宿主把这一步需要人填的参数投影到字段目录，选定登记册，然后指定默认录入或列表。已有的项目配置、系统可取得的值和以后步骤才产生的材料，由各自来源补齐。若包只提供自然语言说明，包维护者先明确字段和规则。已指名的页面资源缺失、版本不符或入口键拼错，属于集成错误，宿主应报告原错误；只有原步骤没有指定入口时，才使用显式配置的默认入口。

**对话中已明确本次登记字段时，可直接传定义。** 使用新的 `package_ref`，把 `label`、有序 `fields` 和可选 `list_columns` 作为 `definition` 一次交给 `open_work_package`。同一授权快照内，定义随登记册持久保存，重复提交相同定义会返回原登记册。使用新引用可另建不同定义的登记册。已指定工作包入口时仍按固定版本和入口键打开。[车辆登记请求](examples/work-package-vehicle-registration.json)

**临时核对按本轮需要生成。** 数字员工从当前任务允许的事实、表格、字段、动作中选择内容，再交给 `generate_interaction_page`。例如一次只看交车门店和里程，另一次可以同时展示异常说明和“确认／退回”按钮。此次输入和决定形成这张页面的回执，归发起任务；需要写入登记册时，由宿主显式关联记录并完成写入。

| 谁持有 | 持有什么 | 何时使用 |
|---|---|---|
| 工作包 | 随包版本发布的步骤、页面资源和入口声明 | 每次执行固定版本的工作 |
| 页面服务 | 当前授权范围的页面实例、表单记录和提交回执 | 浏览器打开页面、宿主按编号回读 |
| CodeFlowMu 或原业务系统 | 任务、登记册的业务归属、审批状态，以及页面／记录与原对话的对应关系 | 启动任务、办理审批、查询业务结果、回复发起人 |

## 3　字段怎样变成表单、列表和详情

字段定义写一次。字典 `fields` 的键是稳定字段标识；每个条目给出显示名、数据类型及规则。`parameters` 决定该登记册采用哪些字段和录入顺序，`list_columns` 决定列表展示哪些摘要列。查看一行的详情时，显示该记录的全部参数，敏感字段按格式掩码。

例如“预约登记”要求日期和人数必填，受理人还需能联系到预约人。下面是一份能直接作为 `PAGE_MCP_CONTEXT_FILE` 使用的最小目录。手机被纳入表单，列表只显示日期和人数。

```json
{
  "field_spec_version": "1.0",
  "principal": "demo-agent",
  "workspace": "demo-operations",
  "task": "appointment-register",
  "facts": {}, "tables": {}, "actions": {},
  "fields": {
    "day": {"label": "预约日期", "type": "date", "required": true},
    "people": {"label": "人数", "type": "number", "integer": true, "min": 1, "max": 20, "required": true},
    "phone": {"label": "联系手机", "type": "text", "format": "cn_mobile", "required": true}
  },
  "work_packages": {
    "appointments": {
      "label": "预约登记",
      "parameters": ["day", "people", "phone"],
      "list_columns": ["day", "people"]
    }
  }
}
```

| 要收集的数据 | 目录写法 | 服务端接受什么 |
|---|---|---|
| 名称、代码、说明 | `text`、`textarea` | `required` 控制必填，`min_length`、`max_length` 控制字符长度。含前导零的编号用文本 |
| 数量、里程 | `number` | 有限数值；`integer: true` 限定安全整数，`min`、`max` 均含端点，数值 0 保留 |
| 日期 | `date` | `YYYY-MM-DD` 的真实日历日期，可设日期上下界；2028-02-29 合法，2027-02-29 会提示错误 |
| 门店、班次、状态 | `select` 加 `options` | 一次选一个已登记的字符串；可选范围取自当前授权目录 |
| 中国大陆手机号 | `text` 加 `format: cn_mobile` | 校验号码格式，接受支持的 +86 和分隔写法，存为 +86 加 11 位数字。需要确认号码可接收短信时，由业务方另行验证 |
| 中国大陆 18 位公民身份号码 | `text` 加 `format: cn_resident_id` | 检查结构、真实出生日期及 MOD 11-2 校验位，尾位 x 统一为 X。证件状态和持有人身份由有权限的业务服务核验 |

页面提交时重新校验，失败时指出首个出错字段，用户可返回修改。选填项留空时结果省略该键。手机号和身份证号的规范化原值存在受保护的服务端目录；默认列表省略这些列，显式选择时使用掩码，详情、提交回执和 MCP 读取结果也使用掩码。宿主提供的普通文本、事实与数据表需要在进入授权目录前完成筛选和脱敏。

新目录声明 `field_spec_version: "1.0"` 后，拼错的规则、类型不匹配、重复参数、无效字段引用和不属于表单的列表列均在加载时报告错误。JSON Schema 描述配置形状，日期、校验位和引用关系由程序执行。若新增金额、文件、多选或跨字段规则，先定义值的表示、适用校验和存储，再扩展 Schema、渲染和提交验证。例如精确金额可先用带币种说明的最小货币单位整数表示。[字段 Schema 1.0](schemas/work-package-fields-v1.schema.json) · [含证件字段的可运行目录](examples/contact-intake-context.json)

## 4　CodeFlowMu 怎样调用页面 MCP

宿主先确定已认证的主体 `principal`、工作区 `workspace` 和关联对象 `task`。已有任务用任务上下文；从聊天创建任务时，可以先绑定启动请求，创建成功后补上正式任务号。数据目录中，`facts` 提供键值事实，`tables` 提供允许显示的数据行与列，`fields` 定义输入，`actions` 定义按钮引用和机器动作名。数字员工从当前目录作选择，业务系统决定谁能看到什么、能做什么。

### 六个工具

| 工具 | 输入 | 返回或用途 |
|---|---|---|
| `describe_page_context` | `{}` | 发现当前范围的资料、表格列、字段、动作和可用登记册。返回引用及元数据，原始数据行留在服务端 |
| `open_work_package` | `package_ref`，可选 `definition` | 返回 `form_url` 和 `list_url`。这里传入入口声明中的 `collection_ref`，例如 `vehicle-intake` |
| `get_work_package_record` | `package_ref`、`record_id` | 获取指定记录的类型化参数 `values` |
| `generate_interaction_page` | `request_id`、`specification` | 返回 `page_id`、`state`、`url` 和标题。每个独立请求使用新的 UUID |
| `get_interaction_page` | `page_id` | 重新取得该页的描述、状态和入口 |
| `get_interaction_result` | `page_id` | 返回状态；提交后附带动作、引用和已填值 |

专用页的 `specification` 有标题、用途、按顺序排列的 `blocks` 和 `actions`。区块 `narrative` 显示纯文本，`facts` 通过 `source_ref` 引用事实，`table` 可指定已授权的 `columns`，`input` 用 `field_ref` 放置字段。每个输入在同页出现一次。操作须同时匹配登记的 `kind` 和 `reference`。只读页面把 `actions` 设为空数组。

**查询结果可以直接作本页的候选项。** 把已授权的候选值放入 `specification.fields` 的 `select` 字段，用 `field_ref` 在页面上放置它。一次性收集答复可显式使用 `{"kind":"submit_response","reference":"page-submit"}`。宿主按页号把最终选择关联到原查询条件，再发起业务查询。[租金二次查询页面请求](examples/page-rent-query.json)

**图片识别后的核对页。** 宿主把识别字段和规则放进 `specification.fields`，把已识别的值放进 `specification.initial_values`。用户可直接修改或清空对应输入框，核对无误可直接提交。按页号回读的 `submission.values` 反映最终提交内容，空的选填项会省略。[行驶证核对请求（合成数据）](examples/page-license-review.json)

下面的工具参数可与随包的培训目录直接配合。换成车辆核对或审批时，宿主换一份授权目录，数字员工据此组合页面。[培训目录](examples/training-context.json) · [完整请求](examples/page-training.json)

```json
{
  "request_id": "9e9e12f0-584e-4b26-90b4-dc96758aa09b",
  "specification": {
    "title": "选择本次培训班次",
    "purpose": "核对课程并提交个人报名意向。",
    "blocks": [
      {"kind": "facts", "source_ref": "course"},
      {"kind": "input", "field_ref": "shift"}
    ],
    "actions": [{"kind": "training.apply", "reference": "apply"}]
  }
}
```

### 从工作步骤找到正确的资源

1. 解析已选工作包清单，固定 `package_id`、`package_version`、`work_id`。按工作与步骤取得页面文件和入口键。已开批次使用冻结资源及对应文件摘要；启动前收参，使用已选安装版本和可信文件摘要。
2. 通过已授权的连接调用适配器。入口声明版本为 `1.0`，适配器核对三项身份标识。声明了 `viewKey` 就精确查找；需要默认页时，省略 `viewKey`，显式传 `fallback`（`form` 或 `list`）和 `defaultCollectionRef`。交互页另需 `requestId`。
3. 宿主保存原会话、启动请求／任务、步骤、包版本、资源摘要与入口键。同一登记册的入口可反复使用，每个独立交互请求则有自己的 `page_id`。对需要执行工作的登记提交，把特定 `record_id` 关联到这次运行。正式办理依据该记录，避免用“最新一条”推测是哪位员工刚填的。

以下调用放在宿主已经取得 `approvedPageBinding` 和已授权 `pageClient` 的位置。适配器返回入口种类、归属以及对应 URL。[工作包适配器](integrations/work-package/adapter.mjs) · [冻结资源读取示例](integrations/work-package/frozen-asset.mjs)

```js
import { openPackageView } from "./integrations/work-package/adapter.mjs";

const receipt = await openPackageView({
  manifest: approvedPageBinding,
  expectedPackage: {
    package_id: "vehicle-handover", package_version: "1.0.0", work_id: "handover"
  },
  viewKey: "entries",
  callTool: request => pageClient.callTool(request)
});
// receipt.kind 为 "list"，receipt.collection_ref 为 "vehicle-intake"。
```

## 5　页面办完以后，数据到哪里

| 对象 | 打开、提交与重试 | 后续处理 |
|---|---|---|
| 临时只读页 | 打开即可阅读，状态为 `open` | 随任务保留页面引用，浏览器入口可设期限 |
| 一次性交互页 | 第一次有效提交后为 `submitted`，再打开可看回执。相同提交可重试，答案不同会返回冲突 | 宿主用 `page_id` 取回这次选择，业务系统复核权限、对象版本和办理条件 |
| 登记册表单 | 同一份表单重试返回原记录。重新打开空白表单并有效提交，会产生新记录 | 每条记录有自己的 `record_id`；宿主用它关联工作或启动请求 |
| 登记册列表／详情 | 打开、刷新和查看详情只读取数据 | 在相同授权范围及兼容字段合同下可持续累积。改变标签或摘要列可继续看旧记录；改变字段类型、范围或选项集合会得到独立记录集 |

员工选“周四下午”并提交后，`get_interaction_result` 可以返回以下结构。页面收到报名意向后，培训系统再检查剩余席位；只有获得业务回执，聊天才告知“报名成功”。

```json
{
  "page_id": "43c91c03-4951-4940-8821-8f8964ea7abd",
  "state": "submitted",
  "submission": {
    "action": "training.apply",
    "reference": "apply",
    "values": {"shift": "周四下午"}
  }
}
```

在同一授权快照及持久目录内，同一 `request_id` 配相同规格重试会返回同一页；配不同规格会冲突。配置 `PAGE_MCP_LINK_TTL_SECONDS`（或创建服务时提供 `linkTtlSeconds`）可给新建的一次性页面设置访问秒数，缺省或 0 表示不设期限。到期后浏览器打开和提交均返回 HTTP 410。提交记录仍按原授权范围回读，登记册留存由宿主管理。修改上下文会改变快照，原快照要能支持在途任务直至办理结束；提供多版本快照和撤权能力属于部署方职责。

参考实现提供查询回执的工具。CodeFlowMu 接入时可轮询等待中的页面，把“用户已提交”“业务已办理”“原会话已通知”分别记录。审批或发起任务时，用页号／启动请求作为业务去重依据。业务办理成功后回信失败，按已经取得的业务回执重新投递即可。

## 6　微信怎样交付单独的页面

微信 MCP 可以同时承担两个角色。对 CodeFlowMu 它是服务端，对页面生成器它通过 MCP 客户端发起调用。两段连接由微信桥显式建立。网页生成器可以由其他渠道独立调用。[微信桥实现](integrations/weixin/bridge.mjs)

| 微信桥工具 | 在原对话中做什么 |
|---|---|
| `weixin_describe_page_context` | 获取本次授权的数据、字段和动作目录 |
| `weixin_request_page` | 委托生成本次的独立页，将页号与请求号交给当前会话的出站队列 |
| `weixin_open_work_package` | 传 `package_ref`、`view`（`form` 或 `list`）和 UUID `request_id`，把相应登记入口交给队列 |
| `weixin_get_page_result` | 按 `page_id` 读取决定或补充内容，再由宿主推进原任务 |

**手机访问。** 生产宿主在自己的认证 HTTPS 域名上挂载 `/p/<page_id>`（交互页）和 `/w/…`（登记页、列表、详情）。微信收到一条指向具体页面的消息，点击后可直接在微信浏览器内办理。PWA、桌面端和其他渠道也可以打开经同一网关授权的页面。页面服务可在聊天模型结束后继续运行。

```js
// pages 是 createPageService(...) 创建的实例；以下两个身份函数由宿主提供。
const pageHandler = pages.createAuthenticatedBrowserHandler({
  origin: "https://pages.example.com",
  authenticate: async req => {
    const session = await verifiedLoginSession(req);
    return session ? resolvePageScope(session, req.url) : null;
  }
});
// HTTPS 网关把 /p/ 和 /w/ 请求交给 pageHandler(req, res)。
```

每次浏览和提交均由宿主核验主体、工作区和任务范围。工具内的回环 URL 及其访问密钥用于本机预览。对手机发页，使用 `mobilePageOutbox({publicOrigin, enqueueToConversation})`，由预先配置的域名和受信资源路径生成访问地址，队列按原请求号去重。转发消息的人仍需通过页面网关认证。

**真实投递是单独的接入点。** 本包的 `localOutbox` 会返回 `queued_local`，说明页面引用已写入本机队列。部署方须将 `enqueueToConversation` 绑定到经核验的账号和原微信会话，接入所选腾讯渠道的实际发送能力，按该渠道支持的消息形态和发送条件投递，再记录发送结果。入队、平台接受、用户打开是不同事件。普通微信、公众号和企业微信的账号条件由各渠道决定。验收应使用预定账号类型和真实手机打开、完成提交、收到原会话回信。

## 7　本机运行与接入验收

使用 Node.js 22 或更新版本。在本包根目录运行第一条命令即可体验车辆登记；其余命令分别运行一次性交互、字段验证和测试。三个演示应逐个运行，按 Ctrl+C 退出后再启动下一项。演示使用临时目录，退出后清理数据。

```sh
node bin/demo.mjs
node bin/demo.mjs --interaction
node bin/demo.mjs --fields
npm test
```

核心无外部 npm 依赖。微信桥依赖 MCP SDK，解压后在包根目录另外运行以下命令。桥接测试使用真实 stdio 连接、HTTP 页面、提交和回读，以及模拟投递队列。

```sh
npm --prefix integrations/weixin ci --ignore-scripts --no-audit --no-fund
npm --prefix integrations/weixin test
```

**接入宿主。** 由服务管理器启动 `node src/service.mjs`，MCP 宿主通过 stdio 启动 `node bin/mcp.mjs`。`PAGE_MCP_PORT` 和 `PAGE_MCP_CAPABILITY` 注入两个进程，端口指向同一本机回环服务，能力凭据来自宿主的秘密配置。仅页面服务需要 `PAGE_MCP_CONTEXT_FILE`（授权目录的绝对路径）和 `PAGE_MCP_DATA_DIR`（受保护的持久目录）。服务持有页面与记录，MCP 子进程可单独重启。当前参考实例一次绑定一份上下文，多员工部署按已认证范围路由。

CodeFlowMu 可把 `bin/mcp.mjs` 注册为授权角色的外部 stdio 工具，也可只注册微信桥，令其连接下游。既有安装器生成 `.codeflowmu/runtime/external-mcp.json`，结构名为 `codeflowmu.external-mcp/v1`。持久安装应把条目并入安装清单，由宿主选择工作目录、子进程凭据和角色。接入示例对应下列固定源码版本，实际部署时核对所在版本。[CodeFlowMu 安装器](https://github.com/joinwell52-AI/codeflowmu/blob/794123058b8db012ca0da189b43fdf0c5ec2ff04/scripts/install-capability-tools.mjs) · [工作包冻结实现](https://github.com/joinwell52-AI/codeflowmu/blob/794123058b8db012ca0da189b43fdf0c5ec2ff04/codeflowmu-shell/src/work-applications/workpack.ts)

| 验收场景 | 通过条件 |
|---|---|
| 登记与查询 | 连续登记两辆车，列表有两行。重复提交和刷新不会多一行，两个详情和按编号回读的参数对应正确 |
| 正式工作包资源 | 表单和列表共用登记册。错误入口键、版本、工作标识或冻结文件摘要均被拒绝 |
| 临时交互与审批 | 同一请求重试取得同一页。读回的是本页动作和输入；再次提交不同答案被拒绝。上游业务幂等办理并返回正式结果 |
| 身份与访问期限 | 另一主体不能打开或提交。链接到期返回 410，已提交结果仍可由原授权宿主查询 |
| 手机与发起任务 | 在原微信对话收到具体页面，手机打开并提交。切换对话不会改变归属。重复投递或重复消费只创建一个任务，原发起对话收到任务号 |

开发包提供生成、渲染、持久化、查询和微信桥参考实现。CodeFlowMu 的任务启动、审批办理、线上身份网关与真实微信通道由接入方连通后，才能验收最后一项。
