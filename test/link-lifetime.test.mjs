import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID, randomBytes} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPageService} from '../src/service.mjs';

const example = JSON.parse(readFileSync(new URL('../examples/context.json', import.meta.url)));
const spec = {title:'登记测试',purpose:'核验链接时效',blocks:[{kind:'input',field_ref:'visit-note'}],
  actions:[{kind:'submit_response',reference:'record-arrangement'}]};
const token = html => /name="form_token" value="([^"]+)"/.exec(html)[1];

test('页面到期后保留回执和工作包列表，重试、重启与 URL 参数均不能延长期限', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'link-lifetime-'));
  const contextFile = join(directory,'context.json');
  const registry = {...example,work_packages:{notes:{label:'长期登记',parameters:['visit-note']}}};
  writeFileSync(contextFile,JSON.stringify(registry));
  const capability = randomBytes(32).toString('base64url');
  const config = {directory,contextFile,capability};
  let now = Date.now(), service, base;
  t.mock.method(Date,'now',()=>now);
  async function start(linkTtlSeconds) {
    if (service) await service.close();
    service = createPageService({...config,linkTtlSeconds});
    base = 'http://127.0.0.1:' + await service.listen(0);
  }
  t.after(async()=>{if (service) await service.close(); rmSync(directory,{recursive:true,force:true});});
  const call = async (path,args) => {
    const res = await fetch(base+'/v1/'+path,{method:'POST',headers:{
      authorization:'Bearer '+capability,'content-type':'application/json'},body:JSON.stringify(args)});
    assert.equal(res.status,200);
    return res.json();
  };
  const details = url => fetch(url).then(r=>r.text());
  const generate = id => call('pages/generate',{request_id:id,specification:spec});
  const form = value => new URLSearchParams({form_token:value,action:'record-arrangement','field.visit-note':'测试'});
  const send = (page,value) => fetch(base+'/p/'+page.page_id+'/submit',{method:'POST',redirect:'manual',
    headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:form(value)});
  for (const invalid of [-1,0.5,Infinity,NaN,'60']) {
    assert.throws(()=>createPageService({...config,linkTtlSeconds:invalid}),/invalid_link_ttl/);
  }
  await start();
  const old = await generate(randomUUID()); // Created by a configuration without a deadline.
  await start(60);
  const id = randomUUID();
  const expiring = await generate(id);
  const slow = await generate(randomUUID());
  const delayedForm = form(token(await details(slow.url))).toString();
  const accepted = await send(expiring,token(await details(expiring.url)));
  assert.equal(accepted.status,303);
  assert.equal((await fetch(expiring.url)).status,200);
  const pkg = await call('work-packages/open',{package_ref:'notes'});
  const gateway = http.createServer(service.createAuthenticatedBrowserHandler({origin:'https://example.test',authenticate:async()=>registry}));
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>gateway.close(resolve)));
  const published = 'http://127.0.0.1:'+gateway.address().port+new URL(slow.url).pathname;
  assert.equal((await fetch(published)).status,200);
  now += 59_999;
  assert.equal((await fetch(expiring.url)).status,200);
  // The submit starts in time. Hold back its body until the exact millisecond of expiry.
  const reading = once(service.server,'request');
  const pending = http.request(base+'/p/'+slow.page_id+'/submit',{method:'POST',
    headers:{origin:base,'content-type':'application/x-www-form-urlencoded'}});
  const completed = once(pending,'response');
  pending.write(delayedForm.slice(0,10));
  await reading;
  now += 1;
  pending.end(delayedForm.slice(10));
  const [rejected] = await completed;
  assert.equal(rejected.statusCode,410);
  rejected.resume();
  assert.equal((await fetch(expiring.url+'&expires_at=99999999999999')).status,410);
  assert.equal((await fetch(published)).status,410);
  assert.equal((await send(expiring,'invalid')).status,410);
  assert.equal((await fetch(pkg.form_url)).status,200);
  assert.equal((await fetch(pkg.list_url)).status,200);
  assert.equal((await call('pages/result',{page_id:slow.page_id})).state,'open');
  assert.equal((await call('pages/result',{page_id:expiring.page_id})).state,'submitted');
  const fresh = await generate(randomUUID());
  assert.equal((await fetch(fresh.url)).status,200);
  now += 60_000;
  assert.equal((await fetch(fresh.url)).status,410);
  await start(0); // Prevent the new process from assigning or extending old deadlines.
  const again=await generate(id);
  assert.equal(again.page_id,expiring.page_id);
  assert.equal((await fetch(again.url)).status,410);
  const older=await call('pages/read',{page_id:old.page_id});
  assert.equal((await fetch(older.url)).status,200);
});
