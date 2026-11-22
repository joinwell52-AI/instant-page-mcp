import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPageService } from '../../src/service.mjs';
import { openPackageView } from './adapter.mjs';
import { readFrozenPageAsset } from './frozen-asset.mjs';

const manifest = JSON.parse(await readFile(new URL('./example-binding.json', import.meta.url), 'utf8'));
const expectedPackage = {package_id: manifest.package_id, package_version: manifest.package_version, work_id: manifest.work_id};
const contextPath = new URL('../../examples/work-package-context.json', import.meta.url);
const mcpPath = fileURLToPath(new URL('../../bin/mcp.mjs', import.meta.url));

async function startHost(t) {
  const directory = await mkdtemp(join(tmpdir(), 'package-views-'));
  const contextFile = join(directory, 'context.json');
  const registry = JSON.parse(await readFile(contextPath, 'utf8'));
  registry.actions['record-review'] = {kind: 'handover.review', label: '记录核对意见'};
  await writeFile(contextFile, JSON.stringify(registry));
  const capability = randomBytes(32).toString('base64url');
  const service = createPageService({directory, contextFile, capability});
  const port = await service.listen(0);
  const child = spawn(process.execPath, [mcpPath], {
    env: {PAGE_MCP_PORT: String(port), PAGE_MCP_CAPABILITY: capability},
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true
  });
  const stopped = once(child, 'exit');
  const reader = createInterface({input: child.stdout})[Symbol.asyncIterator]();
  t.after(async () => {
    child.stdin.end();
    await stopped;
    await service.close();
    await rm(directory, {recursive: true, force: true});
  });
  const send = msg => child.stdin.write(JSON.stringify({jsonrpc: '2.0', ...msg}) + '\n');
  let sequence = 0;
  async function rpc(method, params) {
    const id = ++sequence;
    send({id, method, params});
    const {done, value} = await reader.next();
    assert.equal(done, false);
    const reply = JSON.parse(value);
    assert.equal(reply.id, id);
    assert.ok(reply.result, JSON.stringify(reply.error));
    return reply.result;
  }
  await rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'package-views-test', version: '1'}
  });
  send({method: 'notifications/initialized'});
  const calls = [];
  const callTool = args => {
    calls.push(args);
    return rpc('tools/call', args);
  };
  return {
    calls, callTool,
    open: input => openPackageView({manifest, expectedPackage, callTool, ...input}),
    async read(name, args) {
      const result = await callTool({name, arguments: args});
      assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
      return result.structuredContent;
    }
  };
}

async function html(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  return response.text();
}

async function submitForm(url, values) {
  const page = await html(url);
  const formPath = page.match(/<form\b[^>]*\baction="([^"]+)"/i)?.[1];
  const formToken = page.match(/name="form_token" value="([^"]+)"/)?.[1];
  assert.ok(formPath && formToken);
  const action = new URL(formPath.replaceAll('&amp;', '&'), url);
  const receipt = await fetch(action, {
    method: 'POST', redirect: 'manual', headers: {origin: action.origin},
    body: new URLSearchParams({form_token: formToken, ...values})
  });
  assert.equal(receipt.status, 303);
  return new URL(receipt.headers.get('location'), action).href;
}

test('包内录入和列表共用登记册，可按原记录编号读取经校验的参数', {timeout: 12000}, async t => {
  const host = await startHost(t);
  const assetPath = 'assets/pages/handover.json';
  const bytes = await readFile(new URL('./example-binding.json', import.meta.url));
  const frozenBinding = readFrozenPageAsset({
    manifest: {schema:'codeflowmu.team-workpack/v1', id:'vehicle-handover', version:'1.0.0',
      jobs:{handover:{}}, assets:[assetPath]},
    packageId:'vehicle-handover',packageVersion:'1.0.0',workId:'handover',assetPath,
    assets:new Map([[assetPath,bytes]]), hashes:{[assetPath]:'e3b5ab03ae4bafce9c73bfa8cd74dba6a5604a9128c8243f2d77ba3ec9e6ea24'}
  });
  const form = await host.open({manifest:frozenBinding,viewKey:'intake'});
  const list = await host.open({manifest:frozenBinding,viewKey:'entries'});
  assert.equal(form.kind, 'form');
  assert.equal(list.kind, 'list');
  assert.equal(form.collection_ref, list.collection_ref);
  assert.equal(list.collection_ref, 'vehicle-intake');
  assert.deepEqual(host.calls.map(c => c.name), ['open_work_package', 'open_work_package']);
  assert.match(await html(list.url), /暂无录入记录/);
  const saved = await submitForm(form.url, {
    'field.plate': '样车甲', 'field.branch': '城南店', 'field.intake-date': '2026-11-22', 'field.mileage': '4500'
  });
  assert.equal(saved, list.url);
  const page = await html(list.url);
  assert.match(page, /共 1 条记录/);
  assert.match(page, /样车甲/);
  const detailPath = page.match(/href="([^"]+\/records\/[0-9a-f-]+[^"]*)"/)?.[1];
  assert.ok(detailPath);
  const detail = new URL(detailPath, list.url);
  assert.match(await html(detail), /4500/);
  const record = await host.read('get_work_package_record', {
    package_ref: list.collection_ref, record_id: detail.pathname.split('/').at(-1)
  });
  assert.strictEqual(record.values.mileage, 4500);
  assert.equal(record.values.plate, '样车甲');
});

test('随包单次页可直接创建并幂等重试，回执和登记册分别回读', {timeout: 12000}, async t => {
  const host = await startHost(t);
  const requestId = randomUUID();
  const review = await host.open({viewKey: 'review', requestId});
  assert.equal(review.package_version, expectedPackage.package_version);
  assert.equal(review.work_id, expectedPackage.work_id);
  assert.equal(review.view_key, 'review');
  assert.equal(review.kind, 'interaction');
  assert.match(await html(review.url), /车辆交接核对说明/);
  const replay = await host.open({viewKey: 'review', requestId});
  assert.equal(replay.page_id, review.page_id);
  const fresh = await host.open({viewKey: 'review', requestId: randomUUID()});
  assert.notEqual(fresh.page_id, review.page_id);
  assert.deepEqual(host.calls.map(c => c.name), Array(3).fill('generate_interaction_page'));

  const withDecision = structuredClone(manifest);
  withDecision.package_version = '1.1.0';
  withDecision.views.confirm = {kind: 'interaction', specification: {
    title: '核对意见', purpose: '填写本次交车意见。',
    blocks: [{kind: 'input', field_ref: 'note'}],
    actions: [{kind: 'handover.review', reference: 'record-review'}]
  }};
  const decision = await host.open({manifest: withDecision,
    expectedPackage: {...expectedPackage, package_version: withDecision.package_version},
    viewKey: 'confirm', requestId: randomUUID()});
  await submitForm(decision.url, {action: 'record-review', 'field.note': '交车前再核一次'});
  const receipt = await host.read('get_interaction_result', {page_id: decision.page_id});
  assert.equal(receipt.state, 'submitted');
  assert.deepEqual(receipt.submission.values, {note: '交车前再核一次'});
  const register = await host.open({viewKey: 'entries'});
  assert.match(await html(register.url), /暂无录入记录/);
});

test('必须匹配宿主锁定的包与版本；仅省略视图时才可指定默认行为', {timeout: 12000}, async t => {
  const host = await startHost(t);
  const fallback = {fallback: 'list', defaultCollectionRef: 'vehicle-intake'};
  const mismatched = [
    {viewKey: 'does-not-exist', ...fallback},
    {viewKey: 'intake', expectedPackage: {...expectedPackage, package_version: '2.0.0'}, ...fallback},
    {viewKey: 'intake', expectedPackage: {...expectedPackage, package_id: 'unrelated'}, ...fallback},
    {viewKey: 'intake', expectedPackage: {...expectedPackage, work_id: 'another-work'}, ...fallback},
    {defaultCollectionRef: 'vehicle-intake'},
    {fallback: 'form'}
  ];
  for (const args of mismatched) await assert.rejects(() => host.open(args));
  assert.equal(host.calls.length, 0);
  const defaultList = await host.open(fallback);
  const defaultForm = await host.open({...fallback, fallback: 'form'});
  assert.equal(defaultList.view_key, null);
  assert.equal(defaultList.url, (await host.open({viewKey: 'entries'})).url);
  assert.equal(defaultForm.url, (await host.open({viewKey: 'intake'})).url);
  await assert.rejects(() => host.open({...fallback, defaultCollectionRef: 'unbound-collection'}));
});
