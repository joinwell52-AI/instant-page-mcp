import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdir, readFile, link, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const generatorPath = fileURLToPath(new URL('../../src/mcp.mjs', import.meta.url));
const publicToolName = 'weixin_request_page';
const packageToolName = 'weixin_open_work_package';
function workPackagePath(path) {
  if (typeof path !== 'string') return false;
  const parts=path.split('/');
  return parts.length===4 && parts[0]==='' && parts[1]==='w' && uuid.test(parts[2]) &&
    (parts[3]==='form' || parts[3]==='records');
}
function deliveryTarget(input) {
  if (input.page_id!==undefined && input.resource_path===undefined && uuid.test(input.page_id)) return {page_id:input.page_id};
  if (input.page_id===undefined && workPackagePath(input.resource_path)) return {resource_path:input.resource_path};
  throw Error('invalid_page_receipt');
}
const delegatedTools = new Map([
  ['weixin_describe_page_context', { downstream:'describe_page_context', description:'查看这次对话可用于生成页面的数据与操作目录。' }],
  ['weixin_get_page_result', { downstream:'get_interaction_result', description:'按页面编号查询本次已绑定范围的用户提交结果。' }]
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function response(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError };
}

// 演示发件箱只保存页面引用。一个目录只用于一个受信会话范围，真实通道由宿主注入收件人和队列。
export function localOutbox(directory) {
  return async (item) => {
    const {request_id}=item;
    if (!uuid.test(request_id)) throw Error('invalid_request_id');
    const recipientPage=deliveryTarget(item);
    if (!directory) throw Error('outbox_not_configured');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, request_id.toLowerCase() + '.json');
    const temporary = join(directory, '.pending-' + randomUUID());
    const body = JSON.stringify({ request_id: request_id.toLowerCase(), ...recipientPage, state: 'queued_local' });
    try {
      await writeFile(temporary, body, {flag: 'wx', mode: 0o600});
      try { await link(temporary, target); }
      catch (error) {
        if (error.code !== 'EEXIST' || await readFile(target,'utf8') !== body) throw Error('outbox_conflict');
      }
    } finally { await unlink(temporary).catch(() => {}); }
    return { state: 'queued_local' };
  };
}

// 真实通道把 enqueueToConversation 绑定到已确认的微信账号、员工和原会话；它要以 request_id 去重。
export function mobilePageOutbox({publicOrigin, enqueueToConversation}) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search ||
      origin.hash || origin.pathname !== '/' || typeof enqueueToConversation !== 'function') {
    throw Error('invalid_mobile_publisher');
  }
  return async item => {
    const {request_id}=item;
    if (!uuid.test(request_id)) throw Error('invalid_request_id');
    const recipientPage=deliveryTarget(item);
    const path=recipientPage.resource_path ?? '/p/'+recipientPage.page_id;
    const url=new URL(path,origin).href;
    await enqueueToConversation({request_id,...recipientPage,url});
    return {state:'queued'};
  };
}

// 这个进程对 CodeFlowMu 是 MCP 服务端，对页面生成器是 MCP 客户端。
export function createWeixinBridge({ enqueueBoundPage, pagePort, pageCapability }) {
  const upstream = new Client({name:'codeflowmu-weixin-page-client',version:'0.4.0'});
  let pending;
  async function connect() {
    if (!pending) {
      const childEnv={};
      if (pagePort) childEnv.PAGE_MCP_PORT=pagePort;
      if (pageCapability) childEnv.PAGE_MCP_CAPABILITY=pageCapability;
      const transport = new StdioClientTransport({command:process.execPath,args:[generatorPath],env:childEnv,stderr:'ignore'});
      pending=upstream.connect(transport).catch(async error=>{ await transport.close();pending=undefined;throw error; });
    }
    await pending;
  }
  const server = new Server({name:'weixin-page-bridge-example',version:'0.4.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await connect();
    const catalog=await upstream.listTools();
    const generate=catalog.tools.find(item=>item.name==='generate_interaction_page');
    if (!generate) throw Error('generate_tool_unavailable');
    const tools=[{name:publicToolName,description:'当前聊天需要页面时，调用独立生成器，并把页面引用交给本次微信对话的出站队列。',inputSchema:generate.inputSchema}];
    for (const [name, mapping] of delegatedTools) {
      const found = catalog.tools.find(item => item.name === mapping.downstream);
      if (found) tools.push({name, description:mapping.description, inputSchema:found.inputSchema});
    }
    const workPackage=catalog.tools.find(item=>item.name==='open_work_package');
    if (workPackage) tools.push({
      name:packageToolName,
      description:'向本次对话投递工作包录入表单或记录列表。每个投递请求保留原请求号。',
      inputSchema:{
        type:'object',additionalProperties:false,required:['package_ref','view','request_id'],
        properties:{
          package_ref:workPackage.inputSchema.properties.package_ref,
          view:{type:'string',enum:['form','list']},
          request_id:{type:'string',format:'uuid'}
        }
      }
    });
    return {tools};
  });
  async function queuePage(request_id,target,receipt) {
    try {
      const delivery=await enqueueBoundPage({request_id,...target});
      if (!['queued_local','queued'].includes(delivery?.state)) throw Error('invalid_delivery_receipt');
      return response({...receipt,delivery:delivery.state});
    } catch { return response({code:'outbox_unavailable',...receipt},true); }
  }
  async function requestWorkPackage(args) {
    if (!uuid.test(args.request_id) || !['form','list'].includes(args.view) ||
        Object.keys(args).some(key=>!['request_id','package_ref','view'].includes(key))) return response({code:'invalid_arguments'},true);
    let result;
    try {
      await connect();
      result=await upstream.callTool({name:'open_work_package',arguments:{package_ref:args.package_ref}});
    } catch { return response({code:'generator_unavailable'},true); }
    if (result.isError) return response({code:'generation_refused'},true);
    const descriptor=result.structuredContent;
    if (descriptor?.package_ref!==args.package_ref) return response({code:'invalid_page_receipt'},true);
    let path;
    try { path=new URL(args.view==='form'?descriptor.form_url:descriptor.list_url).pathname; }
    catch { return response({code:'invalid_page_receipt'},true); }
    if (!workPackagePath(path)) return response({code:'invalid_page_receipt'},true);
    return queuePage(args.request_id,{resource_path:path},{package_ref:args.package_ref,view:args.view});
  }
  server.setRequestHandler(CallToolRequestSchema, async ({params})=>{
    const read = delegatedTools.get(params.name);
    if (read) {
      try { await connect();return await upstream.callTool({name:read.downstream,arguments:params.arguments??{}}); }
      catch {return response({code:'generator_unavailable'},true);}
    }
    if (params.name===packageToolName) return requestWorkPackage(params.arguments??{});
    if(params.name!==publicToolName) return response({code:'unknown_tool'},true);
    const args=params.arguments??{};
    if(!uuid.test(String(args.request_id??''))) return response({code:'invalid_request_id'},true);
    let result;
    try {
      await connect();
      result=await upstream.callTool({name:'generate_interaction_page',arguments:args});
    } catch { return response({code:'generator_unavailable'},true); }
    if(result.isError) return response({code:'generation_refused'},true);
    const page=result.structuredContent;
    if(!page || typeof page.page_id!=='string' || !uuid.test(page.page_id)) return response({code:'invalid_page_receipt'},true);
    // 生产队列使用受信的手机发布域名签发访问入口。不向微信或外层模型传递带本机预览密钥的 URL。
    return queuePage(args.request_id,{page_id:page.page_id},{page_id:page.page_id});
  });
  server.onclose = () => { void upstream.close(); };
  return server;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=createWeixinBridge({enqueueBoundPage:localOutbox(process.env.CFM_WEIXIN_OUTBOX_DIR),pagePort:process.env.PAGE_MCP_PORT,pageCapability:process.env.PAGE_MCP_CAPABILITY});
  await server.connect(new StdioServerTransport());
}
