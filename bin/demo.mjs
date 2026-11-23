#!/usr/bin/env node
// 本机演示使用包内合成数据，真实运行 MCP 协议，不需要 npm 安装。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createPageService } from '../src/service.mjs';
import { version } from '../src/version.mjs';

const at = path => fileURLToPath(new URL(path,import.meta.url));
const mode=process.argv[2];
if (process.argv.length > 3 || (mode !== undefined && mode !== '--interaction' && mode !== '--fields')) {
  console.error('用法：node bin/demo.mjs [--interaction | --fields]');
  process.exit(2);
}
const showInteractions=mode==='--interaction';
const fieldMode=mode==='--fields';
const context=fieldMode?'../examples/contact-intake-context.json':
  showInteractions?'../examples/context.json':'../examples/work-package-context.json';
const dir=await mkdtemp(join(tmpdir(),'instant-page-demo-'));
const capability=randomBytes(32).toString('base64url');
const service=createPageService({directory:dir,contextFile:at(context),capability});
let child;
let endClient;
let closing=false;
async function close(){
  if(closing) return;
  closing=true;
  if (child) child.stdin.end();
  if (endClient) await endClient;
  await service.close();
  await rm(dir,{recursive:true,force:true});
}
try {
  const port=await service.listen(0);
  child=spawn(process.execPath,[at('../src/mcp.mjs')],{
    env:{...process.env,PAGE_MCP_PORT:String(port),PAGE_MCP_CAPABILITY:capability},
    stdio:['pipe','pipe','inherit'],windowsHide:true
  });
  endClient=once(child,'exit');
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const write = value => child.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  let sequence=0;
  async function rpc(method,params){
    const id=++sequence;write({id,method,params});
    const next=await lines.next();
    if(next.done) throw Error('MCP 进程已退出');
    const msg=JSON.parse(next.value);
    if(msg.id!==id || !msg.result) throw Error('MCP 请求未完成');
    return msg.result;
  }
  await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'instant-page-demo',version}});
  write({method:'notifications/initialized'});
  const catalog=await rpc('tools/list',{});
  console.log('可用工具：'+catalog.tools.map(t=>t.name).join('、'));
  const pages=[];
  if (showInteractions) {
    for (const path of ['../examples/page-fleet.json','../examples/page-other.json']) {
      const args=JSON.parse(await readFile(at(path),'utf8'));
      const out=await rpc('tools/call',{name:'generate_interaction_page',arguments:args});
      if (out.isError) throw Error('生成失败：'+out.structuredContent?.code);
      pages.push(out.structuredContent);
      console.log(args.specification.title+'\n'+out.structuredContent.url);
    }
    console.log('提交后在终端按回车查询结果。按 Ctrl+C 结束演示。');
  } else {
    const out=await rpc('tools/call',{name:'open_work_package',arguments:{package_ref:fieldMode?'contact-intake':'vehicle-intake'}});
    if (out.isError) throw Error('打开工作包失败：'+out.structuredContent?.code);
    const data=out.structuredContent;
    console.log(data.title+' · 新增记录\n'+data.form_url);
    console.log(data.title+' · 查看记录\n'+data.list_url);
    console.log('可连续录入两条，再从列表打开任一条详情。按 Ctrl+C 结束本次临时演示。');
  }
  process.once('SIGINT',()=>{void close();});
  process.once('SIGTERM',()=>{void close();});
  if(process.stdin.isTTY){
    const terminal=createInterface({input:process.stdin});
    let chain=Promise.resolve();
    terminal.on('line',()=>{chain=chain.then(async()=>{
      if(closing) return;
      for(const page of pages){
        const out=await rpc('tools/call',{name:'get_interaction_result',arguments:{page_id:page.page_id}});
        console.log(page.title,JSON.stringify(out.structuredContent));
      }
    }).catch(()=>console.error('读取演示结果未成功。'));});
    endClient.then(()=>terminal.close());
  }
} catch(error){console.error(error.message);await close();process.exitCode=1;}
