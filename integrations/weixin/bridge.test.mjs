import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPageService } from '../../src/service.mjs';
import { mobilePageOutbox } from './bridge.mjs';
const at=p=>fileURLToPath(new URL(p,import.meta.url));

test('宿主通过微信 MCP 的客户端调用独立 MCP；原请求重试只产生一个页面与投递项', async () => {
  const directory=await mkdtemp(join(tmpdir(),'wechat-page-chain-'));
  const capability=randomBytes(32).toString('base64url');
  const outbox=join(directory,'outbox');
  const service=createPageService({directory:join(directory,'pages'),contextFile:at('../../examples/context.json'),capability});
  const port=await service.listen(0);
  const client=new Client({name:'chain-integration-test',version:'1'});
  try {
    const env={PAGE_MCP_PORT:String(port),PAGE_MCP_CAPABILITY:capability,CFM_WEIXIN_OUTBOX_DIR:outbox};
    const transport=new StdioClientTransport({command:process.execPath,args:[at('./bridge.mjs')],env,stderr:'pipe'});
    await client.connect(transport);
    const available=(await client.listTools()).tools;
    assert.deepEqual(available.map(item=>item.name).sort(),['weixin_describe_page_context','weixin_get_page_result','weixin_open_work_package','weixin_request_page']);
    const [tool]=available;
    assert.equal(tool.name,'weixin_request_page');
    const metadata=await client.callTool({name:'weixin_describe_page_context',arguments:{}});
    assert.equal(metadata.isError,false);
    assert(metadata.structuredContent.fields.some(x=>x.ref==='visit-date'));
    const args=JSON.parse(await readFile(at('../../examples/page-other.json'),'utf8'));
    const run=async a=>client.callTool({name:tool.name,arguments:a});
    const first=await run(args);
    assert.equal(first.isError,false,JSON.stringify(first.structuredContent));
    assert.equal(first.structuredContent.delivery,'queued_local');
    const second=await run(args);
    assert.deepEqual(first.structuredContent,second.structuredContent);
    const items=await readdir(outbox);
    assert.equal(items.length,1);
    const saved=JSON.parse(await readFile(join(outbox,items[0]),'utf8'));
    assert.equal(saved.page_id,first.structuredContent.page_id);
    assert.deepEqual(Object.keys(saved).sort(),['page_id','request_id','state']);
    const response=await fetch('http://127.0.0.1:'+port+'/v1/pages/read',{method:'POST',headers:{'Content-Type':'application/json',authorization:'Bearer '+capability},body:JSON.stringify({page_id:saved.page_id})});
    const descriptor=await response.json();
    assert.equal(descriptor.title,args.specification.title);
    const resultArgs={page_id:saved.page_id};
    const queryResult=async records=>client.callTool({name:'weixin_get_page_result',arguments:records});
    const pending=await queryResult(resultArgs);
    assert.equal(pending.isError,false);
    assert.deepEqual(pending.structuredContent,{...resultArgs,state:'open'});
    const formResponse=await fetch(descriptor.url);
    assert.equal(formResponse.status,200);
    const html=await formResponse.text();
    const origin=new URL(descriptor.url).origin;
    const action=html.match(/<form method="post" action="([^"]+)"/)?.[1];
    const token=html.match(/name="form_token" value="([^"]+)"/)?.[1];
    assert(action && token,'generated HTML should expose its own valid form');
    const change=await fetch(new URL(action,origin),{
      method:'POST',redirect:'manual',headers:{origin},
      body:new URLSearchParams({
        form_token:token,action:'record-visit',
        'field.visit-count':'2','field.visit-date':'2027-02-09','field.visit-time':'09:00–10:00'
      })
    });
    assert.equal(change.status,303);
    const receipt=await queryResult(resultArgs);
    assert.equal(receipt.isError,false);
    assert.deepEqual(receipt.structuredContent,{
      ...resultArgs,state:'submitted',
      submission:{action:'visits.request_slot',reference:'record-visit',
        values:{'visit-count':2,'visit-date':'2027-02-09','visit-time':'09:00–10:00'}}
    });
    assert.equal((await queryResult({...resultArgs,principal:'other'})).isError,true);
    assert.equal((await queryResult({page_id:'11111111-1111-4111-8111-111111111111'})).structuredContent.code,'not_found');
    assert(!JSON.stringify(receipt).includes(capability));
    assert(!JSON.stringify(first).includes('127.0.0.1'));
    assert.equal((await run({...args,specification:{...args.specification,title:'同键不同页'}})).isError,true);
    assert.equal((await readdir(outbox)).length,1);
  } finally { await client.close();await service.close();await rm(directory,{recursive:true,force:true}); }
});

test('微信 MCP 分别投递同一工作包的录入入口与记录列表',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'wechat-work-package-'));
  const capability=randomBytes(32).toString('base64url');
  const outbox=join(directory,'outbox');
  const service=createPageService({directory:join(directory,'data'),contextFile:at('../../examples/work-package-context.json'),capability});
  const port=await service.listen(0);
  const client=new Client({name:'work-package-bridge-test',version:'1'});
  try {
    const env={PAGE_MCP_PORT:String(port),PAGE_MCP_CAPABILITY:capability,CFM_WEIXIN_OUTBOX_DIR:outbox};
    await client.connect(new StdioClientTransport({command:process.execPath,args:[at('./bridge.mjs')],env,stderr:'pipe'}));
    const tools=(await client.listTools()).tools;
    assert(tools.some(t=>t.name==='weixin_open_work_package'));
    const describe=await client.callTool({name:'weixin_describe_page_context',arguments:{}});
    const {ref}=describe.structuredContent.work_packages[0];
    const dispatch=(view,request_id,extra={})=>client.callTool({name:'weixin_open_work_package',arguments:{package_ref:ref,view,request_id,...extra}});
    const ids=[randomUUID(),randomUUID()];
    for (const [index,view] of ['form','list'].entries()) {
      const sent=await dispatch(view,ids[index]);
      assert.equal(sent.isError,false);
      assert.deepEqual(sent.structuredContent,{package_ref:ref,view,delivery:'queued_local'});
      assert.deepEqual((await dispatch(view,ids[index])).structuredContent,sent.structuredContent);
    }
    assert.equal((await dispatch('list',ids[0])).structuredContent.code,'outbox_unavailable');
    assert.equal((await dispatch('form',randomUUID(),{recipient:'unbound'})).isError,true);
    assert.equal((await readdir(outbox)).length,2);
    const rows=await Promise.all(ids.map(async id=>JSON.parse(await readFile(join(outbox,id+'.json'),'utf8'))));
    const firstPath=rows[0].resource_path;
    assert.match(firstPath,/^\/w\/[a-f0-9-]+\/form$/);
    assert.equal(rows[1].resource_path,firstPath.slice(0,-4)+'records');
    for (const row of rows) {
      const messages=[];
      const publish=mobilePageOutbox({publicOrigin:'https://pages.example',enqueueToConversation:async item=>messages.push(item)});
      await publish(row);
      assert.equal(messages[0].url,'https://pages.example'+row.resource_path);
      assert(!JSON.stringify(messages[0]).includes('?'));
    }
  } finally {await client.close();await service.close();await rm(directory,{recursive:true,force:true});}
});

test('手机发布扩展只向已绑定的出站队列提交受信 HTTPS 下的页面地址',async()=>{
  const got=[];
  const enqueue=mobilePageOutbox({publicOrigin:'https://pages.example',enqueueToConversation:async row=>got.push(row)});
  const id='20ac6e54-6796-43be-8888-c33c6329c380';
  const result=await enqueue({page_id:id,request_id:id});
  assert.equal(result.state,'queued');assert.equal(got[0].url,'https://pages.example/p/'+id);
  for(const publicOrigin of ['http://pages.example','https://user:pass@pages.example','https://pages.example/path']){
    assert.throws(()=>mobilePageOutbox({publicOrigin,enqueueToConversation:async()=>{}}));
  }
});
