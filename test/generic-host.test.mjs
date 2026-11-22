import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createPageService} from '../src/service.mjs';

const local = path => fileURLToPath(new URL(path,import.meta.url));

test('通用培训宿主按手册完成 MCP 发现、页面生成、表单提交及报名意向回读', {timeout:10000}, async () => {
  const temp=await mkdtemp(join(tmpdir(),'training-host-'));
  // The submit-stage path exceeds Windows MAX_PATH even with a short temp root.
  const directory=join(temp,'host-storage-'.repeat(7),'page-data-'.repeat(6));
  const capability=randomBytes(32).toString('base64url');
  const service=createPageService({directory,contextFile:local('../examples/training-context.json'),capability});
  let child;
  let exited;
  try {
    const port=await service.listen(0);
    const env={...process.env,PAGE_MCP_PORT:String(port),PAGE_MCP_CAPABILITY:capability};
    delete env.CFM_PAGE_PORT;
    delete env.CFM_PAGE_CAPABILITY;
    child=spawn(process.execPath,[local('../bin/mcp.mjs')],{env,stdio:['pipe','pipe','inherit'],windowsHide:true});
    exited=once(child,'exit');
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    const send=message=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
    let serial=0;
    async function request(method,params) {
      const id=++serial;
      send({id,method,params});
      const message=await lines.next();
      assert.equal(message.done,false);
      const envelope=JSON.parse(message.value);
      assert.equal(envelope.id,id);
      assert.ok(envelope.result);
      return envelope.result;
    }
    async function tool(name,args={}) {
      const result=await request('tools/call',{name,arguments:args});
      assert.equal(result.isError,false);
      return result.structuredContent;
    }
    await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'training-host',version:'1'}});
    send({method:'notifications/initialized'});
    const description=await tool('describe_page_context');
    assert.deepEqual(description,{
      facts:[{ref:'course',label:'课程安排'}],tables:[],
      fields:[{ref:'shift',label:'参加班次',type:'select'}],
      actions:[{reference:'apply',label:'提交报名意向',kind:'training.apply'}],
    });
    const spec=JSON.parse(await readFile(local('../examples/page-training.json'),'utf8'));
    const page=await tool('generate_interaction_page',spec);
    assert.equal(page.title,'选择本次培训班次');
    assert.equal(page.state,'open');
    const id={page_id:page.page_id};
    assert.deepEqual(await tool('get_interaction_page',id),page);
    assert.deepEqual(await tool('get_interaction_result',id),{...id,state:'open'});
    const response=await fetch(page.url);
    assert.equal(response.status,200);
    const html=await response.text();
    assert.match(html,/客户沟通实务/);
    assert.match(html,/<select[^>]+name="field\.shift"/);
    assert.match(html,/value="周四下午"/);
    const formAction=/<form method="post" action="([^"]+)"/.exec(html)[1];
    const formToken=/name="form_token" value="([^"]+)"/.exec(html)[1];
    const origin=new URL(page.url).origin;
    const receipt=await fetch(new URL(formAction,origin),{
      method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({form_token:formToken,action:'apply','field.shift':'周四下午'}),
    });
    assert.equal(receipt.status,303);
    assert.deepEqual(await tool('get_interaction_result',id),{
      ...id,state:'submitted',submission:{action:'training.apply',reference:'apply',values:{shift:'周四下午'}},
    });
    assert.equal((await tool('get_interaction_page',id)).state,'submitted');
  } finally {
    if(child) { child.stdin.end();await exited; }
    await service.close();
    await rm(temp,{recursive:true,force:true});
  }
});
