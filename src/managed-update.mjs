import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { createInterface } from 'node:readline';

const registry = 'https://registry.npmjs.org';
const name = 'instant-page-mcp';
const versionPattern = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

export function newer(version, current) {
  if (!versionPattern.test(version) || !versionPattern.test(current)) return false;
  const left = version.split('.').map(Number), right = current.split('.').map(Number);
  return (left[0] - right[0] || left[1] - right[1] || left[2] - right[2]) > 0;
}

export function readyReleases(home) {
  let entries;
  try { entries = readdirSync(join(home, 'releases'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isDirectory() && versionPattern.test(entry.name) &&
      existsSync(join(home, 'releases', entry.name, 'verified')))
    .map(entry => entry.name).sort((left, right) => newer(left, right) ? -1 : Number(left !== right));
}

export function releasePath(home, version) {
  return join(home, 'releases', version, 'node_modules', name);
}

export function npmCommand() {
  if (process.platform !== 'win32') return ['npm'];
  const roots = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)];
  const cli = roots.map(root => join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')).find(existsSync);
  if (!cli) throw Error('npm_not_found');
  return [process.execPath, cli];
}

async function install(stage, archive, signal) {
  const [command, ...prefix] = npmCommand();
  const args = [...prefix, 'install', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-package-lock', '--registry', registry, '--fetch-retries=0', archive];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: stage, stdio: 'ignore', windowsHide: true, signal });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error('npm_install_failed')));
  });
}

async function probe(pkg, stage, version, signal) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(PAGE_MCP_|CFM_PAGE_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    PAGE_MCP_PORT: '1', PAGE_MCP_CAPABILITY: 'probe-token-0000000000000000000000000000',
    PAGE_MCP_DATA_DIR: join(stage, 'probe-data'), PAGE_MCP_CONTEXT_FILE: join(pkg, 'examples', 'local-context.json')
  });
  const child = spawn(process.execPath, [join(pkg, 'src', 'managed-runtime.mjs'), '--probe'], {
    env, cwd: stage, signal, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
  });
  const finished = new Promise(resolve => child.once('close', resolve));
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  async function request(id, method, params) {
    send({ id, method, params });
    const next = await reader.next();
    if (next.done) throw Error('update_probe_incomplete');
    const result = JSON.parse(next.value);
    if (result.id !== id || !result.result) throw Error('update_probe_failed');
    return result.result;
  }
  try {
    const session = await request(1, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ipm-update-probe', version: '1' }
    });
    if (session.serverInfo?.name !== name || session.serverInfo.version !== version) throw Error('update_probe_version');
    send({ method: 'notifications/initialized' });
    const catalog = await request(2, 'tools/list', {});
    const required = ['generate_interaction_page', 'get_interaction_result', 'open_work_package', 'get_work_package_record'];
    if (!required.every(name => catalog.tools?.some(tool => tool.name === name))) throw Error('update_probe_tools');
    const context = await request(3, 'tools/call', { name: 'describe_page_context', arguments: {} });
    if (context.isError || !Array.isArray(context.structuredContent?.fields)) throw Error('update_probe_service');
  } finally {
    child.stdin.end();
    if (await finished !== 0) throw Error('update_probe_exit');
  }
}

async function download(response, limit) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
    throw Error('update_download_failed');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Error('update_download_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function prepareNpmUpdate(home, currentVersion, stop, fetchLatest = fetch) {
  const signal = AbortSignal.any([stop, AbortSignal.timeout(60000)]);
  const options = { signal, redirect: 'error' };
  const meta = JSON.parse(await download(await fetchLatest(`${registry}/${name}/latest`, options), 262144));
  if (meta.name !== name || typeof meta.version !== 'string') throw Error('update_package_identity');
  const version = meta.version;
  if (!newer(version, currentVersion)) return null;
  const releases = join(home, 'releases');
  const destination = join(releases, version);
  if (existsSync(join(destination, 'verified'))) return null;

  const tarball = `${registry}/${name}/-/${name}-${version}.tgz`;
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(meta.dist?.integrity) || meta.dist.tarball !== tarball) {
    throw Error('update_package_integrity_metadata');
  }
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(releases, '.download-'));
  try {
    const bytes = await download(await fetchLatest(tarball, options), 2 * 1024 * 1024);
    if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== meta.dist.integrity) {
      throw Error('update_package_checksum');
    }
    const archive = join(stage, `${name}.tgz`);
    writeFileSync(archive, bytes, { mode: 0o600, flag: 'wx' });
    await install(stage, archive, signal);
    const pkg = join(stage, 'node_modules', name);
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
    if (manifest.name !== name || manifest.version !== version) throw Error('update_package_version');
    await probe(pkg, stage, version, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
    for (const item of ['probe-data', 'package.json', `${name}.tgz`]) rmSync(join(stage, item), { force: true, recursive: item === 'probe-data' });
    stop.throwIfAborted();
    writeFileSync(join(stage, 'verified'), version, { mode: 0o600, flag: 'wx' });
    try { renameSync(stage, destination); }
    catch (error) { if (!existsSync(join(destination, 'verified'))) throw error; }
    return version;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
