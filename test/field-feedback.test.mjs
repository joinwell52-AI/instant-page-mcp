import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPageService } from '../src/service.mjs';

const label = '联系电话 <设备> & 客服';
const escapedLabel = '联系电话 &lt;设备&gt; &amp; 客服';
const invalidValue = 'private-input-only-for-test';
const token = html => /name="form_token" value="([^"]+)"/.exec(html)[1];

for (const mode of ['工作包表单','一次性交互表单']) {
  test(mode + '能定位字段校验错误、返回表单修正，同值不写入错误页', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'field-feedback-'));
    const contextFile = join(dir, 'context.json');
    const capability = randomBytes(32).toString('base64url');
    const registry = {
      principal:'clerk', workspace:'example', task:'feedback',
      facts:{}, tables:{}, fields:{phone:{type:'text', label, required:true, format:'cn_mobile'}},
      work_packages:{contact:{label:'联系登记',parameters:['phone']}},
      actions:{save:{label:'登记',kind:'submit_response'}}
    };
    await writeFile(contextFile, JSON.stringify(registry));
    const service = createPageService({directory:dir,contextFile,capability});
    const base = 'http://127.0.0.1:' + await service.listen(0);
    t.after(async () => {
      await service.close();
      await rm(dir, {recursive:true,force:true});
    });
    async function call(path, data) {
      const result = await fetch(base+path, {method:'POST',
        headers:{authorization:'Bearer '+capability,'content-type':'application/json'},body:JSON.stringify(data)});
      assert.equal(result.status, 200);
      return result.json();
    }
    const pkg = mode==='工作包表单';
    const page = pkg ? await call('/v1/work-packages/open',{package_ref:'contact'}) :
      await call('/v1/pages/generate',{request_id:randomUUID(),specification:{title:'联系登记',purpose:'登记联系方式',
        blocks:[{kind:'input',field_ref:'phone'}],actions:[{kind:'submit_response',reference:'save'}]}});
    const url = pkg ? page.form_url : page.url;
    const action = pkg ? url : base+'/p/'+page.page_id+'/submit';
    const original = await (await fetch(url)).text();
    async function post(value, accept) {
      const form = new URLSearchParams({form_token:token(original),'field.phone':value});
      if (!pkg) form.set('action','save');
      return fetch(action, {method:'POST',redirect:'manual',headers:{origin:base,
        'content-type':'application/x-www-form-urlencoded',accept},body:form});
    }
    const bad = await post(invalidValue, 'text/html');
    assert.equal(bad.status, 400);
    assert.ok(bad.headers.get('content-type').includes('text/html'));
    const feedback = await bad.text();
    assert.ok(feedback.includes(escapedLabel));
    assert.ok(!feedback.includes(label));
    assert.ok(!feedback.includes(invalidValue));
    assert.ok(feedback.includes('11 位中国大陆手机号码'));
    const retry = /href="([^"]+)"><span[^>]*>重新打开表单<\/span><\/a>/.exec(feedback)[1].replaceAll('&amp;', '&');
    assert.equal((await fetch(new URL(retry,base))).status, 200);

    const json = await post(invalidValue, 'application/json');
    assert.equal(json.status, 400);
    assert.deepEqual(await json.json(), {code:'invalid_answer', reason:'phone_format', field_ref:'phone'});

    if (pkg) assert.ok((await (await fetch(page.list_url)).text()).includes('暂无录入记录'));
    else assert.equal((await call('/v1/pages/result',{page_id:page.page_id})).state,'open');
    assert.equal((await post('13800000000', 'text/html')).status, 303);
  });
}
