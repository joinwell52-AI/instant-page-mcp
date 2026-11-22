import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const secret = randomBytes(32).toString('base64url');
const entry = fileURLToPath(new URL('../src/mcp.mjs', import.meta.url));
function client(t, port, token = secret, version = '2025-11-25', envOverrides = null) {
  const env = { ...process.env };
  for (const key of ['PAGE_MCP_PORT','PAGE_MCP_CAPABILITY','CFM_PAGE_PORT','CFM_PAGE_CAPABILITY']) delete env[key];
  Object.assign(env, envOverrides ?? { PAGE_MCP_PORT:port, PAGE_MCP_CAPABILITY:token });
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  const stopped = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', x => { stderr += x; });
  const waiting = new Map();
  const reader = createInterface({ input: child.stdout, terminal: false });
  reader.on('line', line => {
    const msg = JSON.parse(line);
    assert.equal(msg.jsonrpc, '2.0');
    assert(!line.includes(secret), 'MCP output exposed token');
    assert(waiting.has(msg.id), 'Unexpected response or unsolicited notification');
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  });
  let seq = 0;
  const send = obj => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  const rpc = (method, params = {}) => new Promise(resolve => {
    const id = ++seq;
    waiting.set(id, resolve);
    send({ method, params, id });
  });
  t.after(async () => {
    child.stdin.end();
    await stopped;
    assert.equal(stderr, '');
    assert.equal(waiting.size, 0);
  });
  return {
    rpc,
    async init() {
      const { result } = await rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
      send({ method: 'notifications/initialized' });
      return result;
    },
    async call(name, args) {
      const response = await rpc('tools/call', { name, arguments: args });
      assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
      return response.result;
    }
  };
}
async function mock(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const args = JSON.parse(raw);
    calls.push({ path: req.url, args, method: req.method, auth: req.headers.authorization });
    await handler(req, res, args);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: String(server.address().port), calls };
}
const json = (res, payload, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};
const opts = { timeout: 10000 };

const spec = {
  title:'核对费用', purpose:'查看数据与预算的关系。',
  blocks:[
    {kind:'narrative',text:'正常条件为 3 < 5。\n这是文字里的 <em>，应按原样显示。'},
    {kind:'table',source_ref:'bill_lines',columns:['item','amount']},
    {kind:'facts',source_ref:'budget'},
    {kind:'input',field_ref:'comment'}
  ],
  actions:[{kind:'submit_response',reference:'ack_1'}]
};
test('stdio connects, lists six tools, builds/reads page and returns user result',opts,async t => {
  const id = randomUUID();
  const request = randomUUID();
  const local = await mock(t,(req,res,args) => {
    assert.equal(req.method,'POST');
    assert.equal(req.headers.authorization,'Bearer ' + secret);
    assert.equal(req.headers.host,'127.0.0.1:' + local.port);
    if (req.url === '/v1/pages/result') {
      return json(res,{page_id:id,state:'submitted',submission:{action:'submit_response',reference:'ack_1',values:{comment:'已核对'},extra:'ignored'},raw:secret});
    }
    if (req.url === '/v1/pages/generate') assert.deepEqual(args,{request_id:request,specification:spec});
    else assert.deepEqual(args,{page_id:id});
    json(res,{page_id:id,state:'open',title:'核对费用',url:'http://127.0.0.1:' + local.port + '/p/display-ticket',apiSecret:secret});
  });
  const c=client(t,local.port);
  assert.equal((await c.rpc('tools/list')).error.code,-32002);
  assert.equal((await c.init()).protocolVersion,'2025-11-25');
  assert.deepEqual((await c.rpc('ping')).result,{});
  const names=(await c.rpc('tools/list')).result.tools.map(tool=>tool.name).sort();
  assert.deepEqual(names,['describe_page_context','generate_interaction_page','get_interaction_page','get_interaction_result','get_work_package_record','open_work_package']);
  const made=await c.call('generate_interaction_page',{request_id:request,specification:spec});
  assert.equal(made.isError,false);
  assert.equal(made.structuredContent.page_id,id);
  const page=await c.call('get_interaction_page',{page_id:id});
  assert.deepEqual(page.structuredContent,made.structuredContent);
  const result=await c.call('get_interaction_result',{page_id:id});
  assert.deepEqual(result.structuredContent,{page_id:id,state:'submitted',submission:{action:'submit_response',reference:'ack_1',values:{comment:'已核对'}}});
  assert.deepEqual(local.calls.map(c=>c.path),['/v1/pages/generate','/v1/pages/read','/v1/pages/result']);
});
test('invalid specs, tool fields and unknown tools never reach page service',opts,async t=>{
  const local=await mock(t,(_req,res)=>json(res,{}));
  const c=client(t,local.port,secret,'2025-06-18');
  assert.equal((await c.init()).protocolVersion,'2025-06-18');
  const id=randomUUID();
  const bad=[
    {...spec,blocks:[]}, {...spec,actions:undefined}, {...spec,recipient:'direct'},
    {...spec,blocks:[{kind:'html',html:'markup'}]},
    {...spec,blocks:[{kind:'table',source_ref:'sql/x',columns:['x']}]},
    {...spec,blocks:[{kind:'table',source_ref:'a',columns:['x','x']}]},
    {...spec,blocks:[{kind:'table',source_ref:'a',query:'SELECT *'}]},
    {...spec,blocks:[{kind:'input',field_ref:'comment',value:'42'}]},
    {...spec,actions:[{kind:'decide_approval',reference:'ok',decision:'approve'}]},
    {...spec,actions:[{kind:'send_to_url',reference:'ok'}]}
  ];
  for(const specification of bad) {
    const x=await c.call('generate_interaction_page',{request_id:id,specification});
    assert.equal(x.isError,true);
    assert.equal(x.structuredContent.code,'invalid_arguments');
  }
  assert.equal((await c.call('get_interaction_page',{page_id:id,access:'other'})).structuredContent.code,'invalid_arguments');
  assert.equal((await c.call('get_interaction_result',{page_id:'invalid'})).structuredContent.code,'invalid_arguments');
  assert.equal((await c.rpc('tools/call',{name:'submit_decision',arguments:{}})).error.code,-32602);
  assert.equal(local.calls.length,0);
});
test('unconfigured server can be discovered while business calls fail closed',opts,async t=>{
  const local=await mock(t,(_req,res)=>json(res,{}));
  for(const [port,token] of [[local.port,''],['65536',secret],['remote.test:80',secret]]) {
    const c=client(t,port,token,'2099-01-01');
    assert.equal((await c.init()).protocolVersion,'2025-11-25');
    assert.equal((await c.rpc('tools/list')).result.tools.length,6);
    assert.equal((await c.call('get_interaction_page',{page_id:randomUUID()})).structuredContent.code,'connector_unavailable');
  }
  assert.equal(local.calls.length,0);
});
test('trusted output exposes only display links and validates identities, states and submission records',opts,async t=>{
  const target=await mock(t,(_q,r)=>json(r,{}));
  const id=randomUUID();
  const bad=[
    {page_id:randomUUID(),state:'open',url:'https://example.org/p/k'},
    {page_id:id,state:'broken',url:'https://example.org/p/k'},
    {page_id:id,state:'open',url:'http://example.org/p/k'},
    {page_id:id,state:'open',url:'javascript:alert(1)'},
    {page_id:id,state:'open',url:'https://john:pw@example.org/p/k'},
    {page_id:id,state:'open',url:'https://example.org/p/' + secret},
    {page_id:id,state:'open',url:'http://127.0.0.1:' + target.port + '/p/k'}
  ];
  let next;
  const local=await mock(t,(_req,res)=>json(res,next));
  const c=client(t,local.port);
  await c.init();
  for(const payload of bad) {
    next=payload;
    const x=await c.call('get_interaction_page',{page_id:id});
    assert.equal(x.structuredContent.code,'invalid_companion_response');
  }
  next={page_id:id,state:'open',url:'https://example.org/p/k'};
  assert.equal((await c.call('get_interaction_page',{page_id:id})).structuredContent.url,next.url);
  next={page_id:id,state:'open',submission:null};
  assert.deepEqual((await c.call('get_interaction_result',{page_id:id})).structuredContent,{state:'open',page_id:id});
  for(const submission of [{}, {action:'bad',reference:'r',values:{}}, {action:'submit_response',reference:'r',values:{note:{nested:true}}}]) {
    next={page_id:id,state:'submitted',submission};
    assert.equal((await c.call('get_interaction_result',{page_id:id})).structuredContent.code,'invalid_companion_response');
  }
  assert.equal(target.calls.length,0);
});
test('service error and redirect never leak raw detail or follow outbound destinations',opts,async t=>{
  const target=await mock(t,(_q,r)=>json(r,{}));
  let code=307;
  const local=await mock(t,(_q,r)=>{
    r.writeHead(code,{'content-type':'application/json',location:'http://127.0.0.1:' + target.port + '/private'});
    r.end(JSON.stringify({details:secret}));
  });
  const c=client(t,local.port);
  await c.init();
  for(const [status,expected] of [[307,'companion_unavailable'],[403,'scope_denied'],[404,'not_found'],[409,'conflict'],[422,'invalid_specification']]) {
    code=status;
    assert.equal((await c.call('get_interaction_page',{page_id:randomUUID()})).structuredContent.code,expected);
  }
  assert.equal(target.calls.length,0);
});
test('generic and legacy launch envs interoperate, mismatched dual configuration stays offline',opts,async t=>{
  const id=randomUUID();
  const local=await mock(t,(_req,res)=>json(res,{page_id:id,state:'open',url:'http://127.0.0.1:' + local.port + '/p/a'}));
  const legacy={CFM_PAGE_PORT:local.port,CFM_PAGE_CAPABILITY:secret};
  const both={...legacy,PAGE_MCP_PORT:local.port,PAGE_MCP_CAPABILITY:secret};
  for(const overrides of [legacy,both]){
    const c=client(t,local.port,secret,'2025-11-25',overrides);
    await c.init();
    assert.equal((await c.call('get_interaction_page',{page_id:id})).structuredContent.page_id,id);
  }
  for(const overrides of [{...both,PAGE_MCP_PORT:'65535'}, {...both,PAGE_MCP_CAPABILITY:randomBytes(32).toString('hex')}]){
    const c=client(t,local.port,secret,'2025-11-25',overrides);
    await c.init();
    assert.equal((await c.call('get_interaction_page',{page_id:id})).structuredContent.code,'connector_unavailable');
  }
  assert.equal(local.calls.length,2);
});

test('scoped catalogue strips data, offers namespaced actions and rejects invalid metadata',opts,async t=>{
  const context={
    facts:[{ref:'visit',label:'预约信息',items:[{value:secret}]}],
    tables:[{ref:'slots',label:'时间',columns:[{id:'date',label:'日期',value:secret}],rows:[[secret]]}],
    fields:[{ref:'name',label:'来访人',type:'text',default:secret},
      {ref:'mobile',label:'联系电话',type:'text',format:'cn_mobile',default:secret}],
    actions:[{reference:'slot',label:'登记预约意向',kind:'visits.request_slot',handler:'secret'}],
    auth:secret
  };
  const id=randomUUID();
  const local=await mock(t,(req,res,args)=>{
    if(req.url==='/v1/pages/context') {
      assert.deepEqual(args,{});
      return json(res,context);
    }
    if(req.url==='/v1/pages/generate'){
      assert.equal(args.specification.actions[0].kind,'visits.request_slot');
      return json(res,{page_id:id,state:'open',url:'http://127.0.0.1:' + local.port + '/p/ticket'});
    }
    return json(res,{page_id:id,state:'submitted',submission:{action:'visits.request_slot',reference:'slot',values:{name:'来访人'}}});
  });
  const c=client(t,local.port);
  await c.init();
  const discovered=await c.call('describe_page_context',{});
  assert.deepEqual(discovered.structuredContent,{
    facts:[{ref:'visit',label:'预约信息'}],tables:[{ref:'slots',label:'时间',columns:[{id:'date',label:'日期'}]}],
    fields:[{ref:'name',label:'来访人',type:'text'},
      {ref:'mobile',label:'联系电话',type:'text',format:'cn_mobile'}],
    actions:[{reference:'slot',label:'登记预约意向',kind:'visits.request_slot'}]
  });
  const specification={...spec,actions:[{kind:'visits.request_slot',reference:'slot'}]};
  assert.equal((await c.call('generate_interaction_page',{request_id:randomUUID(),specification})).structuredContent.page_id,id);
  assert.equal((await c.call('get_interaction_result',{page_id:id})).structuredContent.submission.action,'visits.request_slot');
  const count=local.calls.length;
  assert.equal((await c.call('describe_page_context',{tenant:'other'})).structuredContent.code,'invalid_arguments');
  for(const kind of ['visits..submit','custom','visits/submit','visits.submit!','visits.doWork']){
    assert.equal((await c.call('generate_interaction_page',{request_id:randomUUID(),specification:{...spec,actions:[{kind,reference:'slot'}]}})).structuredContent.code,'invalid_arguments');
  }
  assert.equal(local.calls.length,count);
  context.fields[1].format='unrecognized';
  assert.equal((await c.call('describe_page_context',{})).structuredContent.code,'invalid_companion_response');
  context.fields[1].format='cn_resident_id';
  context.fields[0].type='unrecognized';
  assert.equal((await c.call('describe_page_context',{})).structuredContent.code,'invalid_companion_response');
});


test('工作包入口只返回本机同包展示页，记录回读核对工作包、记录编号和字段类型',opts,async t=>{
  const ref='test-form', pathId=randomUUID(), recordId=randomUUID(), key=randomBytes(32).toString('base64url');
  let payload;
  const service=await mock(t,(_req,res)=>json(res,payload));
  const session=client(t,service.port);
  await session.init();
  const base='http://127.0.0.1:'+service.port+'/w/'+pathId;
  const links={package_ref:ref,title:'参数录入',form_url:base+'/form?k='+key,list_url:base+'/records?k='+key};
  payload={...links,private:'ignore'};
  assert.deepEqual((await session.call('open_work_package',{package_ref:ref})).structuredContent,links);
  for (const bad of [
    {...links,list_url:links.list_url.replace(pathId,randomUUID())},
    {...links,form_url:links.form_url+'&session=other'},
    {...links,list_url:links.list_url.replace('http://127.0.0.1:'+service.port,'https://other.example')},
    {...links,title:secret}, {...links,package_ref:'other'}
  ]) {
    payload=bad;
    assert.equal((await session.call('open_work_package',{package_ref:ref})).structuredContent.code,'invalid_companion_response');
  }
  const args={package_ref:ref,record_id:recordId}, row={...args,values:{plate:'浙A',mileage:120.5}};
  payload={...row,metadata:'ignored'};
  assert.deepEqual((await session.call('get_work_package_record',args)).structuredContent,row);
  for (const bad of [{...row,package_ref:'other'}, {...row,record_id:randomUUID()}, {...row,values:{bad:{nested:true}}}]) {
    payload=bad;
    assert.equal((await session.call('get_work_package_record',args)).structuredContent.code,'invalid_companion_response');
  }
  assert.equal((await session.call('get_work_package_record',{...args,unbound:'x'})).structuredContent.code,'invalid_arguments');
});
