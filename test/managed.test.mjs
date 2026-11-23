import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { npmCommand, prepareNpmUpdate, readyReleases } from '../src/managed-update.mjs';
import { version } from '../src/version.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(root, 'bin', 'managed.mjs');
const registry = 'https://registry.npmjs.org/instant-page-mcp';

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return String(port);
}

async function start(t, env, registryStub) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(registryStub).href, launcher], {
    env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  const closed = once(child, 'close');
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
  const finish = async () => { child.stdin.end(); return closed; };
  t.after(() => { child.kill(); return closed; });
  const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  let id = 0;
  async function rpc(method, params) {
    send({ id: ++id, method, params });
    const next = await reader.next();
    assert.ok(!next.done, stderr);
    const reply = JSON.parse(next.value);
    assert.equal(reply.id, id);
    assert.ok(reply.result, JSON.stringify(reply));
    return reply.result;
  }
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'managed-test', version: '1' }
  });
  send({ method: 'notifications/initialized' });
  return { version: initialized.serverInfo.version, finish, rpc };
}

test('managed startup stages an npm release, honors off and preserves page links and submissions on update',
  { timeout: 40000 }, async t => {
    const temp = await mkdtemp(join(tmpdir(), 'ipm-managed-test-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const fixture = join(temp, 'fixture');
    await mkdir(fixture);
    for (const dir of ['bin', 'src', 'examples']) await cp(join(root, dir), join(fixture, dir), { recursive: true });
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const [major, minor, patch] = version.split('.').map(Number);
    const nextVersion = [major, minor, patch + 1].join('.');
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ ...manifest, version: nextVersion }));
    const [npm, ...prefix] = npmCommand();
    await execute(npm, [...prefix, 'pack', '--quiet', '--pack-destination', temp], { cwd: fixture });
    const archive = join(temp, `instant-page-mcp-${nextVersion}.tgz`);
    const integrity = 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64');
    const meta = { name: 'instant-page-mcp', version: nextVersion,
      dist: { integrity, tarball: `${registry}/-/instant-page-mcp-${nextVersion}.tgz` } };
    const stub = join(temp, 'registry.mjs');
    await writeFile(stub, `import { readFile } from 'node:fs/promises';
      const actualFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        if (url === ${JSON.stringify(registry + '/latest')}) return Response.json(${JSON.stringify(meta)});
        if (url === ${JSON.stringify(meta.dist.tarball)}) return new Response(await readFile(${JSON.stringify(archive)}));
        return actualFetch(url, options);
      };`);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(PAGE_MCP_|CFM_PAGE_)/i.test(key)) delete env[key];
    const home = join(temp, 'home');
    const port = await freePort();
    Object.assign(env, { PAGE_MCP_MANAGED_HOME: home, PAGE_MCP_PORT: port });
    const manage = async (...args) => JSON.parse((await execute(process.execPath, [launcher, ...args], { env })).stdout);
    const tool = async (client, name, args) => {
      const result = await client.rpc('tools/call', { name, arguments: args });
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.structuredContent;
    };
    assert.deepEqual(await manage('status'), { auto_update: 'on', version, prepared: null });
    await manage('update', 'off');
    const first = await start(t, env, stub);
    assert.equal(first.version, version);
    const page = await tool(first, 'generate_interaction_page', { request_id: randomUUID(), specification: {
      title: 'Upgrade persistence', purpose: 'Keep the original page during a version change',
      fields: [{ ref: 'note', label: 'Note', type: 'text', required: true }],
      blocks: [{ kind: 'input', field_ref: 'note' }],
      actions: [{ kind: 'submit_response', reference: 'page-submit' }]
    } });
    assert.equal((await manage('status')).prepared, null);
    assert.equal((await first.finish())[0], 0);

    await manage('update', 'on');
    const checking = await start(t, env, stub);
    assert.equal(checking.version, version);
    for (let i = 0; i < 100 && readyReleases(home).length === 0; i++) await delay(125);
    assert.deepEqual(await manage('status'), { auto_update: 'on', version, prepared: nextVersion });
    await manage('update', 'off');
    assert.equal((await checking.finish())[0], 0);
    const disabled = await start(t, env, stub);
    assert.equal(disabled.version, version);
    assert.equal((await disabled.finish())[0], 0);

    await manage('update', 'on');
    const updated = await start(t, env, stub);
    assert.equal(updated.version, nextVersion);
    assert.deepEqual(await manage('status'), { auto_update: 'on', version: nextVersion, prepared: null });
    const response = await fetch(page.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    const action = /<form method="post" action="([^"]+)"/.exec(html)[1];
    const formToken = /name="form_token" value="([^"]+)"/.exec(html)[1];
    const origin = new URL(page.url).origin;
    const submitted = await fetch(new URL(action, origin), { method: 'POST', redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ form_token: formToken, action: 'page-submit', 'field.note': 'Still here' }) });
    assert.equal(submitted.status, 303);
    const result = await tool(updated, 'get_interaction_result', { page_id: page.page_id });
    assert.equal(result.submission.values.note, 'Still here');
    assert.equal((await updated.finish())[0], 0);
  });

test('a corrupt npm archive never becomes eligible for activation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ipm-bad-update-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const meta = { name: 'instant-page-mcp', version: '99.0.0', dist: {
    integrity: 'sha512-' + createHash('sha512').update('expected').digest('base64'),
    tarball: `${registry}/-/instant-page-mcp-99.0.0.tgz`
  } };
  await assert.rejects(prepareNpmUpdate(home, version, new AbortController().signal, async url =>
    url.endsWith('/latest') ? Response.json(meta) : new Response('different bytes')), /update_package_checksum/);
  assert.deepEqual(readyReleases(home), []);
});
