// 独立交互页面工具与页面服务共享声明和校验，可无副作用导入。
const uuidPattern = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$';
const refPattern = '^[A-Za-z0-9_一-鿿][A-Za-z0-9_.一-鿿-]{0,127}$';
const uuid = { type: 'string', format: 'uuid', pattern: uuidPattern };
const reference = { type: 'string', pattern: refPattern, description: '宿主提供的业务引用标识。' };

const objectSchema = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false
});
// 这里只接收结构化说明。文字交给宿主作为文本节点渲染，源数据、动作及授权需重新解析。
// 内容只作为普通文字呈现，允许比较符、换行和对代码的文字讨论。
const plainPattern = String.raw`^(?=[\s\S]*\S)[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$`;
const plain = (maxLength) => ({ type: 'string', minLength: 1, maxLength, pattern: plainPattern });
const kind = (value) => ({ type: 'string', const: value });
const column = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' };
const block = { oneOf: [
  objectSchema({ kind: kind('narrative'), text: plain(1000) }, ['kind', 'text']),
  objectSchema({ kind: kind('facts'), source_ref: reference }, ['kind', 'source_ref']),
  objectSchema({
    kind: kind('table'), source_ref: reference,
    columns: { type: 'array', items: column, minItems: 1, maxItems: 8, uniqueItems: true }
  }, ['kind', 'source_ref']),
  objectSchema({ kind: kind('input'), field_ref: reference }, ['kind', 'field_ref'])
] };
const actionKind = {
  type: 'string',
  pattern: '^(?:submit_task_draft|decide_approval|submit_response|ask_followup|[a-z][a-z0-9_]{0,31}(?:\\.[a-z][a-z0-9_]{0,31}){1,3})$'
};
const action = objectSchema({
  kind: actionKind,
  reference
}, ['kind', 'reference']);
const specification = objectSchema({
  title: plain(80), purpose: plain(300),
  blocks: { type: 'array', items: block, minItems: 1, maxItems: 16 },
  actions: { type: 'array', items: action, minItems: 0, maxItems: 4 }
}, ['title', 'purpose', 'blocks', 'actions']);
const pageSchema = objectSchema({ specification, request_id: uuid }, ['specification', 'request_id']);

export const tools = [
  { name:'describe_page_context', description:'查看当前范围内可用于编制页面的数据源、列、输入字段、已登记动作和可用的工作包。', inputSchema:objectSchema({}) },
  { name:'open_work_package', description:'打开当前工作包的参数录入表单与记录列表。表单可重复用于新增独立记录，列表可以查看每条记录。', inputSchema:objectSchema({package_ref:reference}, ['package_ref']) },
  { name:'get_work_package_record', description:'读取当前工作包的一条已保存记录，按工作包参数名返回类型化的值；声明为手机号或身份证的值仅返回掩码。', inputSchema:objectSchema({package_ref:reference,record_id:uuid}, ['package_ref','record_id']) },
  { name:'generate_interaction_page', description:'按本轮对话组合本次页面，生成可供用户打开的网页。说明文字按原样显示，数据、输入及动作引用必须在当前页面服务登记。重复同一生成请求须沿用 request_id。', inputSchema:pageSchema },
  { name:'get_interaction_page', description:'按页面 ID 读取页面状态及访问链接。', inputSchema:objectSchema({page_id:uuid}, ['page_id']) },
  { name:'get_interaction_result', description:'按页面 ID 读取已记录的用户选择及提交值，手机号和身份证字段仅返回掩码。未提交时仅返回状态。', inputSchema:objectSchema({page_id:uuid}, ['page_id']) }
];
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// 本实现仅解释本文件实际使用的 JSON Schema 子集；属性和长度均来自对外公布的同一份规则。
const toolSchemas = new Map(tools.map(tool => [tool.name, tool.inputSchema]));
function matches(schema, value) {
  if (schema.oneOf) return schema.oneOf.filter(variant => matches(variant, value)).length === 1;
  if (schema.type === 'object') {
    return isObject(value) && schema.required.every(key => Object.hasOwn(value, key)) &&
      Object.keys(value).every(key => Object.hasOwn(schema.properties, key) && matches(schema.properties[key], value[key]));
  }
  if (schema.type === 'array') {
    return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems &&
      (!schema.uniqueItems || new Set(value).size === value.length) && value.every(item => matches(schema.items, item));
  }
  if (schema.type !== 'string' || typeof value !== 'string') return false;
  const length = [...value].length;
  return (schema.const === undefined || value === schema.const) &&
    (schema.minLength === undefined || length >= schema.minLength) &&
    (schema.maxLength === undefined || length <= schema.maxLength) &&
    (!schema.pattern || new RegExp(schema.pattern, 'u').test(value));
}

export function validToolArguments(name, args) {
  const schema = toolSchemas.get(name);
  return schema !== undefined && matches(schema, args);
}
export function validPageSpecification(value) {
  return matches(specification, value);
}
export const validPageId = value => matches(uuid, value);
export const validReference = value => matches(reference, value);
export const validAction = value => matches(action, value);
export const validColumnId = value => matches(column, value);

