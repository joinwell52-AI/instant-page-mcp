#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newer, prepareNpmUpdate, readyReleases, releasePath } from '../src/managed-update.mjs';
import { version } from '../src/version.mjs';

const bundled = fileURLToPath(new URL('..', import.meta.url));
const defaultRoot = process.platform === 'win32' ? process.env.LOCALAPPDATA ?? homedir() :
  process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
const home = resolve(process.env.PAGE_MCP_MANAGED_HOME ?? join(defaultRoot, 'instant-page-mcp'));
const intervalMs = 24 * 60 * 60 * 1000;

function read(name) {
  try { return readFileSync(join(home, name), 'utf8').trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function save(name, value, keepExisting = false) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temp = join(home, `.write-${randomUUID()}`);
  const dest = join(home, name);
  try {
    writeFileSync(temp, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (keepExisting) linkSync(temp, dest);
    else renameSync(temp, dest);
  } catch (error) {
    if (!keepExisting || error.code !== 'EEXIST') throw error;
  } finally { rmSync(temp, { force: true }); }
}

function autoUpdate() { return read('auto-update') !== 'off'; }

function versions() {
  const ready = readyReleases(home);
  const saved = read('active');
  const current = ready.includes(saved) && newer(saved, version) ? saved : version;
  return { current, prepared: ready.find(candidate => newer(candidate, current)) ?? null };
}

function runtimeEnvironment() {
  const env = { ...process.env };
  for (const [key, fallback] of Object.entries({
    PORT: () => '8765',
    DATA_DIR: () => join(home, 'data'),
    CONTEXT_FILE: () => {
      if (!read('context.json')) save('context.json', readFileSync(join(bundled, 'examples', 'local-context.json'), 'utf8'), true);
      return join(home, 'context.json');
    },
    CAPABILITY: () => {
      if (!read('capability')) save('capability', randomBytes(32).toString('base64url'), true);
      return read('capability');
    }
  })) {
    const primary = 'PAGE_MCP_' + key;
    env[primary] ??= env['CFM_PAGE_' + key] ?? fallback();
  }
  return env;
}

async function startRuntime(chosen, env) {
  const pkg = chosen === version ? bundled : releasePath(home, chosen);
  const child = spawn(process.execPath, [join(pkg, 'src', 'managed-runtime.mjs')], {
    env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true
  });
  let ready = false;
  const ended = new Promise(resolve => child.once('close', code => resolve(code ?? 1)));
  await new Promise(resolve => {
    const timeout = setTimeout(() => child.kill(), 8000);
    child.once('message', message => { ready = message?.ready === true; clearTimeout(timeout); resolve(); });
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.once('error', () => { clearTimeout(timeout); resolve(); });
  });
  if (ready) return { child, ended };
  await ended;
  return null;
}

async function serve() {
  const env = runtimeEnvironment();
  const { current, prepared } = versions();
  let active = autoUpdate() && prepared ? prepared : current;
  let runtime = await startRuntime(active, env);
  if (!runtime && active !== current) {
    console.error('IPM: update could not start. Keeping the current release.');
    active = current;
    runtime = await startRuntime(current, env);
  }
  if (!runtime) throw Error('runtime_start_failed');
  try { save('active', active); }
  catch { console.error('IPM: could not save the active release.'); }

  const controller = new AbortController();
  let checking;
  function check() {
    if (checking || !autoUpdate() || Date.now() - Number(read('last-check')) < intervalMs) return;
    const known = versions().prepared ?? active;
    checking = prepareNpmUpdate(home, known, controller.signal)
      .then(next => { if (next) console.error(`IPM: ${next} verified for the next start.`); })
      .catch(() => { if (!controller.signal.aborted) console.error('IPM: update check failed. Keeping the current release.'); })
      .finally(() => {
        if (!controller.signal.aborted) {
          try { save('last-check', String(Date.now())); }
          catch { console.error('IPM: could not save the update check time.'); }
        }
        checking = undefined;
      });
  }
  const checkSafely = () => {
    try { check(); } catch { console.error('IPM: could not read the update settings.'); }
  };
  checkSafely();
  const timer = setInterval(checkSafely, 60_000).unref();
  const stop = () => runtime.child.kill();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { process.exitCode = await runtime.ended; }
  finally {
    clearInterval(timer);
    controller.abort();
    await checking;
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 0) await serve();
  else if (args.length === 2 && args[0] === 'update' && ['on', 'off'].includes(args[1])) {
    if (args[1] === 'on' && !autoUpdate()) save('last-check', '0');
    save('auto-update', args[1]);
    console.log(JSON.stringify({ auto_update: args[1] }));
  } else if (args.length === 1 && args[0] === 'status') {
    const { current, prepared } = versions();
    console.log(JSON.stringify({ auto_update: autoUpdate() ? 'on' : 'off', version: current, prepared }));
  } else {
    console.error('Usage: instant-page-mcp-managed [status | update on | update off]');
    process.exitCode = 2;
  }
} catch {
  console.error('IPM: managed startup failed. Check the local installation directory and port.');
  process.exitCode = 1;
}
