import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {createPageService} from '../src/service.mjs';

const fixture=name=>JSON.parse(readFileSync(new URL('../examples/'+name,import.meta.url),'utf8'));
async function setup(t) {
  const directory=mkdtempSync(join(tmpdir(),'instant-pages-'));
  const contextFile=join(directory,'context.json');
  const context={...fixture('context.json'),principal:'员工甲',workspace:'项目一',task:'任务A'};
  const setContext=registry=>writeFileSync(contextFile,JSON.stringify(registry));
  setContext(context);
  const secret=()=>randomBytes(32).toString('base64url');
  let capability=secret(),service,base;
  const start=async()=>{
    service=createPageService({directory,contextFile,capability});
    base='http://127.0.0.1:'+await service.listen(0);
  };
  await start();
  t.after(async()=>{await service.close();rmSync(directory,{recursive:true,force:true});});
  const api=(op,data,header='Bearer '+capability)=>fetch(base+'/v1/pages/'+op,{
    method:'POST',headers:{authorization:header,'content-type':'application/json'},body:JSON.stringify(data)
  });
  return { directory,context,contextFile,setContext,api,get base(){return base;},get service(){return service;},get capability(){return capability;},
    restart:async(rotate=false)=>{await service.close();if(rotate)capability=secret();await start();}};
}
const token=html=>/name="form_token" value="([^"]+)"/.exec(html)[1];
const submit=(base,id,fields,origin=base)=>fetch(base+'/p/'+id+'/submit',{
  method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)
});
test('按需生成与幂等，两种实际 HTML、正式提交回读以及重启恢复',async t=>{
  const site=await setup(t);
  const a=fixture('page-fleet.json'),b=fixture('page-other.json');
  const page=await(await site.api('generate',a)).json();
  assert.equal(page.state,'open');
  const other=await(await site.api('generate',b)).json();
  assert.notEqual(other.page_id,page.page_id);
  const html=await(await fetch(page.url)).text();
  const different=await(await fetch(other.url)).text();
  assert.ok(html.includes(a.specification.title));
  assert.ok(different.includes(b.specification.title));
  assert.ok(!html.includes(b.specification.title));
  assert.equal(page.url,(await(await site.api('generate',a)).json()).url);
  assert.equal((await site.api('generate',{...a,specification:b.specification})).status,409);
  assert.equal((await site.api('read',{page_id:page.page_id},'Bearer invalid')).status,403);
  const fetchWithoutKey=await fetch(site.base+'/p/'+page.page_id);
  assert.equal(fetchWithoutKey.status,403);
  const fields={form_token:token(html),action:'record-arrangement','field.fleet-arrangement':'下午补齐 <x> & 核对'};
  assert.equal((await submit(site.base,page.page_id,fields,'https://wrong.example')).status,403);
  assert.equal((await submit(site.base,page.page_id,{...fields,form_token:'bad'})).status,403);
  assert.equal((await submit(site.base,page.page_id,{...fields,action:'record-visit'})).status,400);
  assert.equal((await submit(site.base,page.page_id,fields)).status,303);
  assert.equal((await submit(site.base,page.page_id,fields)).status,303);
  assert.equal((await submit(site.base,page.page_id,{...fields,'field.fleet-arrangement':'另一个答案'})).status,409);
  const receipt=await(await site.api('result',{page_id:page.page_id})).json();
  assert.equal(receipt.state,'submitted');
  assert.equal(receipt.submission.action,'submit_response');
  assert.equal(receipt.submission.reference,'record-arrangement');
  assert.equal(receipt.submission.values['fleet-arrangement'],fields['field.fleet-arrangement']);
  const submittedHTML=await(await fetch(page.url)).text();
  assert.match(submittedHTML,/&lt;x&gt; &amp;/);
  assert.ok(!submittedHTML.includes('name="form_token"'));
  const pageDirs=readdirSync(join(site.directory,'contexts'));
  assert.equal(pageDirs.length,1);
  assert.equal(readFileSync(join(site.directory,'contexts',pageDirs[0],a.request_id,'open.html'),'utf8'),html);
  await site.restart();
  const restored=await(await site.api('read',{page_id:page.page_id})).json();
  assert.equal(restored.page_id,page.page_id);
  assert.equal(new URL(restored.url).search,new URL(page.url).search);
  assert.deepEqual(await(await site.api('result',{page_id:page.page_id})).json(),receipt);
  assert.equal((await site.api('read',{page_id:randomUUID()})).status,404);
});
test('未授权引用失败，身份与任务变更后旧页面、回执和能力均受隔离',async t=>{
  const site=await setup(t);
  const args=fixture('page-fleet.json');
  const invalid={...args,specification:{...args.specification,blocks:[{kind:'facts',source_ref:'not-granted'}]}};
  assert.equal((await site.api('generate',invalid)).status,404);
  const page=await(await site.api('generate',args)).json();
  const oldURL=new URL(page.url);
  site.setContext({...site.context,task:'任务B'});
  assert.equal((await fetch(page.url)).status,403);
  assert.equal((await site.api('result',{page_id:page.page_id})).status,403);
  assert.throws(()=>createPageService({directory:site.directory,contextFile:site.contextFile,capability:site.capability}),/capability_bound/);
  await site.restart(true);
  assert.equal((await site.api('result',{page_id:page.page_id})).status,404);
  assert.equal((await fetch(site.base+oldURL.pathname+oldURL.search)).status,404);
  const inNewScope=await(await site.api('generate',args)).json();
  assert.notEqual(inNewScope.page_id,page.page_id);
});
test('HTTPS 网关可用受信认证回调挂载纯浏览器接口，GET 和 POST 都要校验身份',async t=>{
  const site=await setup(t);
  const page=await(await site.api('generate',fixture('page-fleet.json'))).json();
  let identity={...site.context,principal:'未获授权'};
  const publicOrigin='https://pages.example';
  const gateway=http.createServer(site.service.createAuthenticatedBrowserHandler({
    origin:publicOrigin,authenticate:async()=>identity,
  }));
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>gateway.close(resolve)));
  const address='http://127.0.0.1:'+gateway.address().port;
  const path='/p/'+page.page_id;
  assert.equal((await fetch(address+path)).status,403);
  assert.equal((await fetch(address+'/v1/pages/read')).status,404);
  identity=site.context;
  const html=await(await fetch(address+path)).text();
  assert.ok(!html.includes(new URL(page.url).searchParams.get('k')));
  const fields={form_token:token(html),action:'record-arrangement','field.fleet-arrangement':'今天下午'};
  identity={...site.context,workspace:'另一个工作区'};
  assert.equal((await submit(address,page.page_id,fields,publicOrigin)).status,403);
  identity=site.context;
  assert.equal((await submit(address,page.page_id,fields,address)).status,403);
  const sent=await submit(address,page.page_id,fields,publicOrigin);
  assert.equal(sent.status,303);assert.equal(sent.headers.get('location'),path);
});
test('发现上下文只返回标签和引用，数据及身份留在服务端',async t=>{
  const site=await setup(t);
  const response=await site.api('context',{});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(Object.keys(body).sort(),['actions','facts','fields','tables']);
  assert.deepEqual(body.tables[0].columns[0],{id:'branch',label:'门店'});
  assert.deepEqual(Object.keys(body.actions[0]).sort(),['kind','label','reference']);
  assert.ok(!JSON.stringify(body).includes('样例城南店'));
  assert.ok(!JSON.stringify(body).includes('员工甲'));
  assert.ok(!JSON.stringify(body).includes('09:00'));
  assert.equal((await site.api('context',{foo:true})).status,400);
  assert.equal((await site.api('context',{},'Bearer invalid')).status,403);
  site.setContext({...site.context,principal:'他人'});
  assert.equal((await site.api('context',{})).status,403);
});
test('命名空间动作仅记录，普通预约结果没有业务执行副作用',async t=>{
  const site=await setup(t);
  const args=fixture('page-other.json');
  const page=await(await site.api('generate',args)).json();
  const html=await(await fetch(page.url)).text();
  const fields={form_token:token(html),action:'record-visit','field.visit-date':'2026-11-24',
    'field.visit-time':'09:00–10:00','field.visit-count':'3'};
  assert.equal((await submit(site.base,page.page_id,fields)).status,303);
  const body=await(await site.api('result',{page_id:page.page_id})).json();
  assert.equal(body.submission.action,'visits.request_slot');
  assert.equal(body.submission.values['visit-count'],3);
  assert.deepEqual(Object.keys(body).sort(),['page_id','state','submission']);
});

test('身份证和手机号在工作包列表、单条详情、一次性页面回执及结果回读中按声明处理', async t => {
  const site = await setup(t);
  const fields = {
    phone:{label:'联系电话',type:'text',format:'cn_mobile',required:true},
    identity:{label:'身份证号',type:'text',format:'cn_resident_id',required:true}
  };
  const both = {label:'示例登记',parameters:['identity','phone']};
  site.setContext({...site.context,fields,work_packages:{
    private:both,explicit:{...both,list_columns:['phone','identity']}
  }});
  await site.restart();
  const rawPhone='13800001234', canonicalPhone='+86'+rawPhone;
  const rawId='11010519491231002X';
  const phoneMask='+86138****1234', idMask='110'+'*'.repeat(12)+'02X';
  const values={'field.phone':rawPhone,'field.identity':rawId};
  const internal = async (operation,args) => {
    const response=await fetch(site.base+'/v1/work-packages/'+operation,{
      method:'POST',headers:{authorization:'Bearer '+site.capability,'content-type':'application/json'},body:JSON.stringify(args)
    });
    assert.equal(response.status,200);
    return response.json();
  };
  for (const ref of ['private','explicit']) {
    const descriptor=await internal('open',{package_ref:ref});
    const page=await(await fetch(descriptor.form_url)).text();
    const body=new URLSearchParams({form_token:token(page),...values});
    const saved=await fetch(descriptor.form_url,{method:'POST',redirect:'manual',headers:{origin:site.base},body});
    assert.equal(saved.status,303);
    const list=await(await fetch(descriptor.list_url)).text();
    assert.ok(!list.includes(rawPhone) && !list.includes(rawId));
    assert.equal(list.includes('联系电话'),ref==='explicit');
    assert.equal(list.includes('身份证号'),ref==='explicit');
    assert.equal(list.includes(phoneMask),ref==='explicit');
    assert.equal(list.includes(idMask),ref==='explicit');
    const path=list.match(/href="([^"]+\/records\/([a-f0-9-]+)\?k=[^"]+)"/);
    assert.ok(path);
    const detail=await(await fetch(new URL(path[1],site.base))).text();
    assert.ok(detail.includes(phoneMask) && detail.includes(idMask));
    assert.ok(!detail.includes(rawPhone) && !detail.includes(rawId));
    const row=await internal('record',{package_ref:ref,record_id:path[2]});
    assert.deepEqual(row.values,{phone:phoneMask,identity:idMask});
  }
  const request={request_id:randomUUID(),specification:{title:'核对信息',purpose:'示例',
    blocks:[{kind:'input',field_ref:'phone'},{kind:'input',field_ref:'identity'}],
    actions:[{kind:'submit_response',reference:'record-arrangement'}]}};
  const page=await(await site.api('generate',request)).json();
  const html=await(await fetch(page.url)).text();
  const answer={...values,form_token:token(html),action:'record-arrangement'};
  assert.equal((await submit(site.base,page.page_id,answer)).status,303);
  const receipt=await(await site.api('result',{page_id:page.page_id})).json();
  assert.deepEqual(receipt.submission.values,{phone:phoneMask,identity:idMask});
  const contextDir=readdirSync(join(site.directory,'contexts')).find(name=>{
    return readdirSync(join(site.directory,'contexts',name)).includes(request.request_id);
  });
  const answerDir=join(site.directory,'contexts',contextDir,request.request_id,'answer');
  const stored=JSON.parse(readFileSync(join(answerDir,'answer.json'),'utf8'));
  assert.deepEqual(stored.values,{phone:canonicalPhone,identity:rawId});
  // A previously cached receipt cannot override the active presentation policy.
  writeFileSync(join(answerDir,'submitted.html'),rawId);
  const masked=await(await fetch(page.url)).text();
  assert.ok(masked.includes(phoneMask) && masked.includes(idMask));
  assert.ok(!masked.includes(rawId) && !masked.includes(rawPhone));
});

test('一次性查询页随请求定义候选车牌，校验选择并在重启后回读', async t => {
  const site = await setup(t);
  const args = fixture('page-rent-query.json');
  const {specification} = args;
  const [plate] = specification.fields;
  const changed = patch => ({...args, specification:{...specification, ...patch}});
  assert.equal((await site.api('generate', changed({fields:[plate, plate]}))).status, 404);
  assert.equal((await site.api('generate', changed({fields:[plate, {...plate, ref:'visit-time'}]}))).status, 404);
  assert.equal((await site.api('generate', changed({fields:[plate, {...plate, ref:'unused'}]}))).status, 404);
  assert.equal((await site.api('generate', changed({
    actions:[{kind:'rent.query', reference:'page-submit'}]
  }))).status, 404);
  assert.equal((await site.api('generate', changed({
    fields:undefined, blocks:[{kind:'narrative', text:'旧接口不得绕开动作授权'}]
  }))).status, 404);
  const opened = await site.api('generate', args);
  assert.equal(opened.status, 200);
  const page = await opened.json();
  const id = {page_id:page.page_id};
  assert.deepEqual(await (await site.api('generate', args)).json(), page);
  assert.equal((await site.api('generate', changed({
    fields:[{...plate, options:['苏A123456']}]
  }))).status, 409);
  const context = await (await site.api('context', {})).json();
  assert.ok(!context.fields.some(field => field.ref === 'plate'));

  const html = await (await fetch(page.url)).text();
  assert.match(html, /<select[^>]+name="field\.plate"[^>]+required/);
  assert.deepEqual([...html.split('<footer')[0].matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), plate.options);
  const form = {form_token:token(html), action:'page-submit'};
  assert.equal((await submit(site.base, page.page_id, form)).status, 400);
  assert.equal((await submit(site.base, page.page_id, {...form, 'field.plate':'苏A000000'})).status, 400);
  assert.deepEqual(await (await site.api('result', id)).json(), {...id, state:'open'});
  assert.equal((await submit(site.base, page.page_id, {...form, 'field.plate':'苏A432345'})).status, 303);
  assert.match(await (await fetch(page.url)).text(), /苏A432345/);
  await site.restart();
  const receipt = await (await site.api('result', id)).json();
  assert.deepEqual(receipt.submission.values, {plate:'苏A432345'});
  assert.equal(receipt.submission.action, 'submit_response');
  assert.equal(receipt.submission.reference, 'page-submit');
  assert.equal(receipt.state, 'submitted');
});

test('一次性页的请求字段继续使用字段长度校验和敏感格式掩码', async t => {
  const site = await setup(t);
  const definition = fixture('page-rent-query.json');
  const {specification} = definition;
  specification.blocks = [
    {kind:'input', field_ref:'vin'},
    {kind:'input', field_ref:'mobile'}
  ];
  specification.fields = [
    {ref:'vin', label:'车架号', type:'text', required:true, min_length:17, max_length:17},
    {ref:'mobile', label:'联系手机', type:'text', format:'cn_mobile', required:true}
  ];
  const page = await (await site.api('generate', definition)).json();
  const html = await (await fetch(page.url)).text();
  const form = {form_token:token(html), action:'page-submit', 'field.mobile':'13800138000'};
  assert.equal((await submit(site.base, page.page_id, {...form, 'field.vin':'TOO-SHORT'})).status, 400);
  assert.equal((await submit(site.base, page.page_id, {...form, 'field.vin':'TEST0000000000001'})).status, 303);
  const receipt = await (await site.api('result', {page_id:page.page_id})).json();
  assert.equal(receipt.submission.values.vin, 'TEST0000000000001');
  assert.equal(receipt.submission.values.mobile, '+86138****8000');
  const submitted = await (await fetch(page.url)).text();
  assert.ok(submitted.includes('+86138****8000'));
  assert.ok(!submitted.includes('13800138000'));
});

test('一次性核对页预填可编辑字段，并按实际提交值生成回执', async t => {
  const site = await setup(t);
  const fields = [
    {ref:'owner', label:'所有人', type:'text'},
    {ref:'height', label:'车高（毫米）', type:'number', integer:true, min:1},
    {ref:'date', label:'注册日期', type:'date'},
    {ref:'color', label:'颜色', type:'select', options:['黑色','白色']},
    {ref:'notes', label:'备注', type:'textarea'}
  ];
  const args = {request_id:randomUUID(), specification:{
    title:'行驶证识别核对', purpose:'修正有误的预填值后提交。',
    blocks:fields.map(({ref}) => ({kind:'input', field_ref:ref})),
    fields, actions:[{kind:'submit_response', reference:'page-submit'}],
    initial_values:{owner:'A" <单位>', height:1496, date:'2018-12-29', color:'白色', notes:'原件\n备注'}
  }};
  const invalid = initial_values => ({...args, specification:{...args.specification, initial_values}});
  assert.equal((await site.api('generate', invalid({unknown:'无输入控件'}))).status, 404);
  assert.equal((await site.api('generate', invalid({color:'未登记选项'}))).status, 400);
  assert.equal((await site.api('generate', invalid({height:1.5}))).status, 400);
  const response = await site.api('generate', args);
  assert.equal(response.status, 200);
  const page = await response.json();
  const html = await (await fetch(page.url)).text();
  assert.match(html, /name="field\.owner"[^>]+value="A&quot; &lt;单位&gt;"/);
  assert.match(html, /name="field\.height"[^>]+value="1496"/);
  assert.match(html, /name="field\.date"[^>]+value="2018-12-29"/);
  assert.match(html, /<option value="白色" selected>白色<\/option>/);
  assert.match(html, /<textarea[^>]*>原件\n备注<\/textarea>/);
  assert.equal((await site.api('generate', invalid({owner:'其他值'}))).status, 409);

  const form = {form_token:token(html), action:'page-submit', 'field.owner':'更正的所有人',
    'field.height':'1496', 'field.date':'2018-12-29', 'field.color':'白色', 'field.notes':''};
  assert.equal((await submit(site.base, page.page_id, form)).status, 303);
  const id = {page_id:page.page_id};
  const receipt = await (await site.api('result', id)).json();
  assert.deepEqual(receipt.submission.values, {owner:'更正的所有人', height:1496, date:'2018-12-29', color:'白色'});
  const finalHtml = await (await fetch(page.url)).text();
  assert.match(finalHtml, /更正的所有人/);
  assert.doesNotMatch(finalHtml, /A&quot;|原件\n备注/);
});

test('带样式的图片核对页原子保存输入和原图，授权宿主可按页号取回', async t => {
  const site = await setup(t);
  const template = fixture('page-license-review.json');
  const specification = {...template.specification, appearance:{theme:'blue',layout:'grid'},
    attachment:{label:'识别原图',required:true}};
  const args = {...template, specification};
  const response = await site.api('generate',args);
  assert.equal(response.status,200);
  const page = await response.json();
  const id = {page_id:page.page_id};
  const html = await (await fetch(page.url)).text();
  assert.match(html, /<main class="layout-grid">/);
  assert.match(html, /background:#eef5fd/);
  assert.match(html, /enctype="multipart\/form-data"/);
  assert.match(html, /name="attachment" type="file"[^>]*required/);
  const form_token = token(html);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/1WQAAAAASUVORK5CYII=', 'base64');
  const send = (file, filename='sample.png') => {
    const body = new FormData();
    body.set('form_token',form_token);
    body.set('action','page-submit');
    body.set('field.owner','已核对的示例所有人');
    if (file) body.set('attachment',file,filename);
    return fetch(site.base+'/p/'+page.page_id+'/submit',{
      method:'POST', redirect:'manual', headers:{origin:site.base}, body
    });
  };
  const missing = await send();
  assert.equal(missing.status,400);
  assert.match(await missing.text(), /请附上原图/);
  const invalid = await send(new Blob(['fake'],{type:'image/png'}));
  assert.equal(invalid.status,400);
  assert.match(await invalid.text(), /PNG 或 JPEG/);
  assert.equal((await site.api('attachment',id)).status,404);
  const png = new Blob([image],{type:'image/png'});
  assert.equal((await send(png)).status,303);
  assert.equal((await send(png)).status,303);
  assert.equal((await send(png,'different.png')).status,409);
  const receipt = await (await site.api('result',id)).json();
  assert.equal(receipt.state,'submitted');
  assert.deepEqual(receipt.submission.values,{owner:'已核对的示例所有人'});
  assert.equal(receipt.submission.attachment.filename,'sample.png');
  assert.equal(receipt.submission.attachment.content_type,'image/png');
  assert.equal(receipt.submission.attachment.size,image.length);
  assert.match(receipt.submission.attachment.sha256,/^[0-9a-f]{64}$/);
  assert.match(await (await fetch(page.url)).text(), /已保存图片附件：<\/span>sample\.png/);
  assert.equal((await site.api('attachment',id,'Bearer invalid')).status,403);
  await site.restart();
  const original = await site.api('attachment',id);
  assert.equal(original.status,200);
  assert.equal(original.headers.get('content-disposition'),'attachment');
  assert.deepEqual(Buffer.from(await original.arrayBuffer()),image);
  assert.deepEqual(await (await site.api('result',id)).json(),receipt);
});
