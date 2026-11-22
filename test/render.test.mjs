import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AnswerError, UnknownReference, renderPage, validateAnswer } from '../src/render.mjs';
import { validToolArguments } from '../src/schema.mjs';

function fixture(name) {return JSON.parse(readFileSync(new URL('../examples/'+name+'.json',import.meta.url),'utf8'));}
const registry=fixture('context'), fleet=fixture('page-fleet'), visit=fixture('page-other');
const options={pageId:'fdaca8f4-7660-4fd4-9987-9bb8b42d6914',state:'open',formToken:'my-form-secret'};
const full=()=>new URLSearchParams({form_token:'x',action:'record-visit','field.visit-date':'2028-02-29','field.visit-time':'14:00–15:00','field.visit-count':'2'});

test('两个真实工具请求用同一渲染器组装不同页面和原生提交表单',()=>{
  for (const x of [fleet,visit]) assert(validToolArguments('generate_interaction_page',x));
  const a=renderPage(fleet.specification,registry,options), b=renderPage(visit.specification,registry,options);
  assert.match(a,/<table>/); assert.match(a,/演示车 05/);assert.match(a,/<textarea/);assert.doesNotMatch(a,/visit-date/);
  assert.match(b,/type="date"/);assert.match(b,/<select/);assert.match(b,/type="number" step="1" min="1" max="6"/);assert.doesNotMatch(b,/<table>/);
  for (const html of [a,b]) {assert(html.includes('method="post" action="/p/'+options.pageId+'/submit"'));assert.match(html,/name="form_token"/);assert.doesNotMatch(html,/<script|https?:\/\//);}
});

test('提交严格核验声明字段，规范化数字，可省略选填项',()=>{
  const mismatch={...visit.specification,actions:[{kind:'visits.cancel_slot',reference:'record-visit'}]};
  assert.throws(()=>renderPage(mismatch,registry,options),UnknownReference);
  const answer=validateAnswer(visit.specification,registry,full());
  assert.deepEqual(answer,{action:{kind:'visits.request_slot',reference:'record-visit'},fields:{'visit-date':'2028-02-29','visit-time':'14:00–15:00','visit-count':2}});
  for (const [key,value] of [['action','record-arrangement'],['field.visit-date','2027-02-29'],['field.visit-count','223'],['field.visit-count','1.5'],['field.visit-count','Infinity'],['field.visit-time','清晨'],['field.unlisted','xx'],['field.visit-note','a'.repeat(101)],['field.visit-note','one\ntwo']]) {
    const p=full();p.set(key,value);assert.throws(()=>validateAnswer(visit.specification,registry,p),AnswerError);
  }
  const absent=full();absent.delete('field.visit-date');assert.throws(()=>validateAnswer(visit.specification,registry,absent),AnswerError);
  const dup=full();dup.append('field.visit-count','3');assert.throws(()=>validateAnswer(visit.specification,registry,dup),AnswerError);
});

test('说明文字、受信数据、用户答复和表单令牌均进行 HTML 转义；已提交页面只读',()=>{
  const payload='<img src=x onerror="alert(1)">';const s=structuredClone(fleet.specification),r=structuredClone(registry);
  s.title=payload;r.tables['fleet-gaps'].rows[0].missing=payload;s.blocks.push({kind:'narrative',text:payload});
  const a=renderPage(s,r,{...options,formToken:'"><script>alert(1)</script>'});assert(!a.includes('<img'));assert(!a.includes('<script>'));assert(a.includes('&lt;img'));assert(a.includes('&quot;&gt;&lt;script&gt;'));
  const b=renderPage(s,r,{...options,state:'submitted',submission:{action:'submit_response',reference:'record-arrangement',values:{'fleet-arrangement':payload}}});
  assert.match(b,/已记录你的选择/);assert.match(b,/<output[^>]*>&lt;img/);assert.doesNotMatch(b,/<form|type="submit"|my-form-secret/);
});

test('第三种临时组合无需新页面类型，缺失及跨页引用、重复字段、越权操作会拒绝',()=>{
  const simple={title:'现场须知',purpose:'查看当班提醒',blocks:[{kind:'narrative',text:'凭证件登记 < 10 分钟。'}],actions:[]};
  assert.match(renderPage(simple,{},{}),/&lt; 10/);
  for (const s of [
    {...simple,blocks:[{kind:'table',source_ref:'fleet-gaps',columns:['bad']}]},
    {...simple,blocks:[{kind:'facts',source_ref:'__proto__'}]},
    {...simple,blocks:[{kind:'input',field_ref:'visit-time'},{kind:'input',field_ref:'visit-time'}]},
    {...simple,actions:[{kind:'decide_approval',reference:'record-arrangement'}]},
  ]) assert.throws(()=>renderPage(s,registry,options),UnknownReference);
  assert.throws(()=>renderPage(fleet.specification,{},options),UnknownReference);
});

test('来自兼容宿主的特殊字段引用不会触发原型写入',()=>{
  const s={title:'备注',purpose:'填写备注',blocks:[{kind:'input',field_ref:'__proto__'}],actions:[{kind:'submit_response',reference:'record-arrangement'}]};
  const r={...registry,fields:JSON.parse('{"__proto__":{"label":"备注","type":"text"}}')};
  const form=new URLSearchParams({action:'record-arrangement','field.__proto__':'已核对'});
  const result=validateAnswer(s,r,form);
  assert(Object.hasOwn(result.fields,'__proto__'));assert.equal(result.fields.__proto__,'已核对');assert.equal(Object.getPrototypeOf(result.fields),Object.prototype);
});
