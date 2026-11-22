import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPageService } from '../src/service.mjs';

const example = new URL('../examples/work-package-context.json', import.meta.url);
const executable = fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url));
const pkg = { package_ref: 'vehicle-intake' };

async function startHost(directory, contextFile, capability) {
  const service = createPageService({ directory, contextFile, capability });
  const port = await service.listen(0);
  const child = spawn(process.execPath, [executable], {
    env: { PAGE_MCP_PORT: String(port), PAGE_MCP_CAPABILITY: capability },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true
  });
  const exit = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let serial = 0;
  const write = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  async function request(method, params) {
    const id = ++serial;
    write({ id, method, params });
    const next = await lines.next();
    assert.equal(next.done, false, 'MCP 子进程未响应');
    const reply = JSON.parse(next.value);
    assert.equal(reply.id, id);
    assert.ok(reply.result, JSON.stringify(reply.error));
    return reply.result;
  }
  await request('initialize', {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'work-package-test', version: '1' }
  });
  write({ method: 'notifications/initialized' });
  return {
    service,
    request,
    tool: (name, args = {}) => request('tools/call', { name, arguments: args }),
    async close() {
      child.stdin.end();
      await exit;
      await service.close();
    }
  };
}

function attrs(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)]
    .map(([, key, value]) => [key, value.replaceAll('&amp;', '&')]));
}

async function html(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  return response.text();
}

async function openForm(url) {
  const page = await html(url);
  const form = attrs(page.match(/<form\b[^>]*>/i)?.[0] ?? '');
  assert.equal(form.method?.toLowerCase(), 'post');
  const action = new URL(form.action ?? url, url);
  const hidden = new URLSearchParams();
  for (const [tag] of page.matchAll(/<input\b[^>]+>/gi)) {
    const input = attrs(tag);
    if (input.type === 'hidden') hidden.set(input.name, input.value);
  }
  assert.ok(hidden.get('form_token'));
  return {
    page,
    post(fields, { origin = action.origin, token } = {}) {
      const body = new URLSearchParams(hidden);
      if (token !== undefined) body.set('form_token', token);
      for (const [key, value] of Object.entries(fields)) body.append('field.' + key, value);
      return fetch(action, {
        method: 'POST', redirect: 'manual',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body
      });
    }
  };
}

function detailLinks(page, listURL) {
  const list = new URL(listURL);
  return [...page.matchAll(/<a\b[^>]+>/gi)]
    .map(([tag]) => new URL(attrs(tag).href, list))
    .filter(url => url.origin === list.origin && url.pathname.startsWith(list.pathname + '/'));
}

const first = {
  plate: '样车甲', branch: '城南店', 'intake-date': '2026-11-22',
  mileage: '0012900', note: '检查 <后视镜> & 车灯'
};
const second = {
  plate: '样车乙', branch: '城北店', 'intake-date': '2026-11-23', mileage: '0', note: ''
};

test('工作包真实 MCP 入口按参数生成表单，连续录入、查看列表和明细，重启可恢复', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'package-intake-test-'));
  const contextFile = join(directory, 'context.json');
  const context = JSON.parse(await readFile(example, 'utf8'));
  await writeFile(contextFile, JSON.stringify(context));
  const capability = randomBytes(32).toString('base64url');
  let host = await startHost(directory, contextFile, capability);
  t.after(async () => {
    if (host) await host.close();
    await rm(directory, { recursive: true, force: true });
  });

  const catalog = await host.request('tools/list', {});
  assert.ok(catalog.tools.some(tool => tool.name === 'open_work_package'));
  const ctx = await host.tool('describe_page_context');
  assert.deepEqual(ctx.structuredContent.work_packages, [{ ref: pkg.package_ref, label: '车辆交接登记' }]);
  assert.equal((await host.tool('open_work_package', { package_ref: 'not-authorized' })).isError, true);

  const opened = await host.tool('open_work_package', pkg);
  assert.equal(opened.isError, false);
  const { form_url, list_url, title } = opened.structuredContent;
  assert.equal(title, '车辆交接登记');
  const empty = await html(list_url);
  assert.equal(detailLinks(empty, list_url).length, 0);
  const a = await openForm(form_url);
  const fieldNames = [...a.page.matchAll(/name="field\.([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(fieldNames, context.work_packages['vehicle-intake'].parameters);
  assert.match(a.page, /<select\b[^>]*name="field\.branch"/);
  assert.match(a.page, /<textarea\b[^>]*name="field\.note"/);

  for (const fields of [
    { ...first, plate: '' }, { ...first, branch: '不存在的门店' },
    { ...first, mileage: '-1' }, { ...first, 'intake-date': '2026-02-30' },
    { ...first, unexpected: '未声明参数' }
  ]) assert.equal((await a.post(fields)).status, 400);
  assert.equal((await a.post(first, { token: 'tampered' })).status, 403);
  assert.equal((await a.post(first, { origin: 'https://unrelated.example' })).status, 403);
  assert.equal(detailLinks(await html(list_url), list_url).length, 0);

  const [saved, replayed] = await Promise.all([a.post(first), a.post(first)]);
  for (const receipt of [saved, replayed]) {
    assert.equal(receipt.status, 303);
    assert.equal(new URL(receipt.headers.get('location'), form_url).href, list_url);
  }
  assert.equal((await a.post(second)).status, 409);
  assert.equal(detailLinks(await html(list_url), list_url).length, 1);
  const b = await openForm(form_url);
  assert.equal((await b.post(second)).status, 303);

  async function checkRows(listURL) {
    const list = await html(listURL);
    const cols = ['车牌号', '交车门店', '交车日期'];
    for (const col of cols) assert.ok(list.includes(col));
    assert.ok(list.indexOf(cols[0]) < list.indexOf(cols[1]) && list.indexOf(cols[1]) < list.indexOf(cols[2]));
    for (const hidden of ['交车备注', '交车里程（公里）', '后视镜', '12900']) assert.ok(!list.includes(hidden));
    assert.ok(list.includes('样车甲') && list.indexOf('样车乙') < list.indexOf('样车甲'));
    const links = detailLinks(list, listURL);
    assert.equal(links.length, 2);
    const newest = await html(links[0]);
    assert.ok(newest.includes('样车乙') && newest.includes('交车备注'));
    assert.match(newest, />0</);
    assert.ok(newest.includes('—'));
    const original = await html(links[1]);
    assert.ok(original.includes('样车甲') && original.includes('12900'));
    assert.ok(!original.includes('0012900'));
    assert.ok(original.includes('&lt;后视镜&gt; &amp; 车灯'));
    for (const url of [listURL, links[0], links[1]]) {
      const withoutKey = new URL(url);
      withoutKey.search = '';
      assert.equal((await fetch(withoutKey)).status, 403);
    }
    return links;
  }
  const links = await checkRows(list_url);
  const recordId = link => link.pathname.split('/').at(-1);
  const read = (id, ref = pkg.package_ref) => host.tool('get_work_package_record', { package_ref: ref, record_id: id });
  const firstRecord = await read(recordId(links[1]));
  assert.equal(firstRecord.isError, false);
  assert.deepEqual(firstRecord.structuredContent, {
    ...pkg, record_id: recordId(links[1]), values: { ...first, mileage: 12900 }
  });
  const secondRecord = await read(recordId(links[0]));
  const { note, ...requiredSecond } = second;
  assert.deepEqual(secondRecord.structuredContent.values, { ...requiredSecond, mileage: 0 });
  assert.equal((await read(recordId(links[0]), 'not-authorized')).isError, true);
  await host.close();
  host = undefined;
  host = await startHost(directory, contextFile, capability);
  const reopened = (await host.tool('open_work_package', pkg)).structuredContent;
  assert.equal(new URL(reopened.list_url).pathname, new URL(list_url).pathname);
  const recovered = await checkRows(reopened.list_url);
  assert.deepEqual(recovered.map(url => url.pathname), links.map(url => url.pathname));
  await writeFile(contextFile, JSON.stringify({ ...context, principal: '其他员工' }));
  assert.equal((await fetch(reopened.list_url)).status, 403);
  assert.equal((await fetch(recovered[0])).status, 403);
  assert.equal((await read(recordId(recovered[0]))).isError, true);
});

test('发布到宿主时，录入和列表使用原会话授权，外部网页不能使用本机链接钥匙', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'package-gateway-test-'));
  const context = JSON.parse(await readFile(example, 'utf8'));
  const contextFile = join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify(context));
  const host = await startHost(directory, contextFile, randomBytes(32).toString('base64url'));
  let identity = context;
  const publicOrigin = 'https://example.test';
  const gateway = http.createServer(host.service.createAuthenticatedBrowserHandler({
    origin: publicOrigin, authenticate: async () => identity
  }));
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => gateway.close(resolve));
    await host.close();
    await rm(directory, { recursive: true, force: true });
  });
  const local = (await host.tool('open_work_package', pkg)).structuredContent;
  const address = 'http://127.0.0.1:' + gateway.address().port;
  const gatewayForm = new URL(new URL(local.form_url).pathname, address);
  const gatewayList = new URL(new URL(local.list_url).pathname, address);
  const key = new URL(local.form_url).search;
  assert.equal((await fetch(gatewayForm.href + key)).status, 403);
  const form = await openForm(gatewayForm);
  assert.ok(!form.page.includes(new URL(local.form_url).searchParams.get('k')));
  identity = { ...context, task: '其他任务' };
  assert.equal((await fetch(gatewayList)).status, 403);
  assert.equal((await form.post(first, { origin: publicOrigin })).status, 403);
  identity = context;
  assert.equal((await form.post(first)).status, 403);
  const sent = await form.post(first, { origin: publicOrigin });
  assert.equal(sent.status, 303);
  assert.equal(new URL(sent.headers.get('location'), address).search, '');
  const links = detailLinks(await html(gatewayList), gatewayList);
  assert.equal(links.length, 1);
  assert.equal(links[0].search, '');
  assert.ok((await html(links[0])).includes('样车甲'));
  identity = { ...context, principal: '其他员工' };
  assert.equal((await fetch(links[0])).status, 403);
});

test('同一个宿主可按不同工作包的参数生成页面，包之间的表单、列表和明细彼此独立', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'two-packages-test-'));
  const contextFile = join(directory, 'context.json');
  const context = JSON.parse(await readFile(example, 'utf8'));
  context.work_packages['branch-note'] = { label: '门店交接留言', parameters: ['branch', 'note'] };
  await writeFile(contextFile, JSON.stringify(context));
  const host = await startHost(directory, contextFile, randomBytes(32).toString('base64url'));
  t.after(async () => {
    await host.close();
    await rm(directory, { recursive: true, force: true });
  });
  const intake = (await host.tool('open_work_package', pkg)).structuredContent;
  const other = (await host.tool('open_work_package', { package_ref: 'branch-note' })).structuredContent;
  const noteForm = await openForm(other.form_url);
  assert.deepEqual([...noteForm.page.matchAll(/name="field\.([^"]+)"/g)].map(m => m[1]), ['branch', 'note']);
  const receipt = await noteForm.post({ branch: '城北店', note: '下午复核门店清单' });
  assert.equal(receipt.status, 303);
  const notes = await html(other.list_url);
  assert.ok(notes.includes('下午复核门店清单'));
  assert.ok(notes.includes('交车门店') && notes.includes('交车备注'));
  assert.ok(!notes.includes('交车日期'));
  const recordId = detailLinks(notes, other.list_url)[0].pathname.split('/').at(-1);
  const denied = await host.tool('get_work_package_record', { ...pkg, record_id: recordId });
  assert.equal(denied.isError, true);
  assert.ok(!JSON.stringify(denied).includes('下午复核门店清单'));
  const intakeList = await html(intake.list_url);
  assert.equal(detailLinks(intakeList, intake.list_url).length, 0);
  const wrongDetail = new URL(intake.list_url);
  wrongDetail.pathname += '/' + recordId;
  assert.equal((await fetch(wrongDetail)).status, 404);
  const stolenKey = new URL(other.list_url);
  stolenKey.search = new URL(intake.list_url).search;
  assert.equal((await fetch(stolenKey)).status, 403);
});

test('资料和显示布局变化保留同包记录，参数合同或身份范围变化隔离历史记录', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'package-versions-test-'));
  const contextFile = join(directory, 'context.json');
  const original = JSON.parse(await readFile(example, 'utf8'));
  let capability = randomBytes(32).toString('base64url');
  let host;
  async function load(context, rotate = false) {
    if (host) {
      await host.close();
      host = undefined;
    }
    if (rotate) capability = randomBytes(32).toString('base64url');
    await writeFile(contextFile, JSON.stringify(context));
    host = await startHost(directory, contextFile, capability);
    const result = await host.tool('open_work_package', pkg);
    assert.equal(result.isError, false);
    return result.structuredContent;
  }
  t.after(async () => {
    if (host) await host.close();
    await rm(directory, { recursive: true, force: true });
  });

  const originalPages = await load(original);
  const form = await openForm(originalPages.form_url);
  assert.equal((await form.post(first)).status, 303);
  const links = detailLinks(await html(originalPages.list_url), originalPages.list_url);
  assert.equal(links.length, 1);
  const recordId = links[0].pathname.split('/').at(-1);
  const read = () => host.tool('get_work_package_record', { ...pkg, record_id: recordId });

  const changedDisplay = structuredClone(original);
  changedDisplay.facts.notice = { label: '今日提醒', items: [{ label: '天气', value: '晴' }] };
  changedDisplay.work_packages['vehicle-intake'].label = '新版车辆交接台账';
  changedDisplay.work_packages['vehicle-intake'].list_columns = ['branch', 'intake-date', 'plate'];
  const refreshed = await load(changedDisplay);
  const currentList = await html(refreshed.list_url);
  assert.ok(currentList.includes('新版车辆交接台账'));
  assert.ok(currentList.indexOf('交车门店') < currentList.indexOf('车牌号'));
  const newDetails = detailLinks(currentList, refreshed.list_url);
  assert.equal(newDetails.length, 1);
  assert.equal(newDetails[0].pathname.split('/').at(-1), recordId);
  assert.ok((await html(newDetails[0])).includes('&lt;后视镜&gt;'));
  assert.equal((await read()).structuredContent.values.mileage, 12900);
  for (const oldPage of [originalPages.form_url, originalPages.list_url, links[0]]) {
    const old = new URL(oldPage);
    const now = new URL(old.pathname + old.search, refreshed.list_url);
    assert.ok([403, 404].includes((await fetch(now)).status), '应拒绝旧快照页面入口');
  }

  const changedParameters = structuredClone(changedDisplay);
  changedParameters.fields.mileage.max = 1000000;
  const variants = [
    [changedParameters, false, '参数合同'],
    [{ ...changedDisplay, principal: '另一员工' }, true, '员工'],
    [{ ...changedDisplay, task: '另一任务' }, true, '任务'],
    [{ ...changedDisplay, workspace: '另一工作区' }, true, '工作区']
  ];
  for (const [context, rotate, whatChanged] of variants) {
    const other = await load(context, rotate);
    const listing = await html(other.list_url);
    assert.equal(detailLinks(listing, other.list_url).length, 0, whatChanged + '改变后应得到独立列表');
    assert.ok(!listing.includes('样车甲'));
    assert.equal((await read()).isError, true);
  }
});
