#!/usr/bin/env node
// 独立页面服务的标准输入输出 MCP 接口。
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { isSensitiveField } from './field-rules.mjs';
import { MAX_PAGE_FIELDS, isObject, tools, validToolArguments, validAction, validPageId, validReference, validColumnId } from './schema.mjs';
import { createInterface } from 'node:readline';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const versions = ['2025-11-25', '2025-06-18'];
const routes = new Map([
  ['describe_page_context', '/v1/pages/context'],
  ['open_work_package', '/v1/work-packages/open'],
  ['get_work_package_record', '/v1/work-packages/record'],
  ['generate_interaction_page', '/v1/pages/generate'],
  ['get_interaction_page', '/v1/pages/read'],
  ['get_interaction_result', '/v1/pages/result']
]);
// 两种环境命名若同时出现，必须完全一致，防止旧启动设置把请求送到另一授权上下文。
function launchValue(canonical, legacy) {
  const preferred = process.env[canonical], old = process.env[legacy];
  if (preferred !== undefined && old !== undefined && preferred !== old) return '';
  return preferred ?? old ?? '';
}
const portValue = launchValue('PAGE_MCP_PORT', 'CFM_PAGE_PORT');
const port = /^[1-9][0-9]{0,4}$/.test(portValue) ? Number(portValue) : 0;
const capability = launchValue('PAGE_MCP_CAPABILITY', 'CFM_PAGE_CAPABILITY');
// 能力值由宿主使用安全随机数生成并限定权限，本程序仅能检查格式。
const configured = port > 0 && port <= 65535 && /^[A-Za-z0-9._~-]{32,512}$/.test(capability);
class LocalError extends Error {}
function localCall(path, args, signal) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(args);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST', agent: false, signal,
      headers: {
        authorization: 'Bearer ' + capability,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (res) => {
      if (res.statusCode !== 200 && !(res.statusCode === 201 && path === '/v1/pages/generate')) {
        const code = ({ 400: 'invalid_specification', 422: 'invalid_specification', 401: 'scope_denied', 403: 'scope_denied', 404: 'not_found', 409: 'conflict' })[res.statusCode];
        reject(new LocalError(code ?? 'companion_unavailable'));
        res.destroy();
        return;
      }
      if (res.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        reject(new LocalError('invalid_companion_response'));
        res.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 1048576) {
          reject(new LocalError('invalid_companion_response'));
          res.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      res.on('error', () => reject(new LocalError('companion_unavailable')));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new LocalError('invalid_companion_response')); }
      });
    });
    req.on('error', () => reject(new LocalError('companion_unavailable')));
    req.end(body);
  });
}
function toolResult(payload, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError };
}
function displayUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const localOrigin = new URL('http://127.0.0.1:' + port).origin;
    if (url.username || url.password || (url.origin !== localOrigin && url.protocol !== 'https:')) return null;
    if (url.pathname === '/' || url.pathname.startsWith('/v1/')) return null;
    return url.href;
  } catch { return null; }
}
const fieldTypes = new Set(['text','textarea','number','date','select']);
function contextDescription(data) {
  const invalid = () => { throw new LocalError('invalid_companion_response'); };
  if (!isObject(data)) invalid();
  const clean = {};
  const groups = ['facts','tables','fields','actions'];
  if (Object.hasOwn(data,'work_packages')) groups.push('work_packages');
  for (const group of groups) {
    if (!Array.isArray(data[group])) invalid();
    clean[group] = data[group].map(row => {
      if (!isObject(row) || typeof row.label !== 'string' || !row.label.trim() || /[\u0000-\u001F\u007F]/u.test(row.label)) invalid();
      if (group === 'actions') {
        if (!validAction({kind:row.kind,reference:row.reference})) invalid();
        return {reference:row.reference,label:row.label,kind:row.kind};
      }
      if (!validReference(row.ref)) invalid();
      const item = {ref:row.ref,label:row.label};
      if (group === 'fields') {
        if (!fieldTypes.has(row.type)) invalid();
        item.type = row.type;
        if (row.format !== undefined) {
          if (row.type !== 'text' || !isSensitiveField(row)) invalid();
          item.format = row.format;
        }
      }
      if (group === 'tables') {
        if (!Array.isArray(row.columns)) invalid();
        item.columns = row.columns.map(col => {
          if (!isObject(col) || !validColumnId(col.id) || typeof col.label !== 'string' || !col.label.trim() || /[\u0000-\u001F\u007F]/u.test(col.label)) invalid();
          return {id:col.id,label:col.label};
        });
      }
      return item;
    });
  }
  if (JSON.stringify(clean).includes(capability)) invalid();
  return clean;
}
function sanitizePage(name, args, data) {
  const invalid = () => { throw new LocalError('invalid_companion_response'); };
  if (!isObject(data) || !validPageId(data.page_id) || (args.page_id && args.page_id.toLowerCase() !== data.page_id.toLowerCase()) ||
      !['open', 'submitted', 'expired', 'revoked'].includes(data.state)) invalid();
  const output = { page_id: data.page_id, state: data.state };
  if (name !== 'get_interaction_result') {
    const url = displayUrl(data.url);
    if (!url) invalid();
    output.url = url;
    if (typeof data.title === 'string' && [...data.title].length <= 80) output.title = data.title;
  } else if (data.state === 'submitted') {
    const s = data.submission;
    if (!isObject(s) || !validAction({ kind:s.action, reference:s.reference }) || !isObject(s.values)) invalid();
    const entries = Object.entries(s.values);
    if (entries.length > MAX_PAGE_FIELDS || entries.some(([k, v]) => !validReference(k) ||
        !(v === null || typeof v === 'boolean' || Number.isFinite(v) || (typeof v === 'string' && [...v].length <= 10000)))) invalid();
    output.submission = { action:s.action, reference:s.reference, values:Object.fromEntries(entries) };
  } else if (data.submission != null) invalid();
  // 页面服务即使配置错误，也不可将工具通道的私钥当作访问链接或文本回给模型。
  if (JSON.stringify(output).includes(capability) ||
      (output.url && decodeURIComponent(output.url).includes(capability))) invalid();
  return output;
}
function workPackageLinks(args,data) {
  const invalid=()=>{ throw new LocalError('invalid_companion_response'); };
  if (!isObject(data) || data.package_ref!==args.package_ref ||
      typeof data.title!=='string' || !data.title.trim() || /[\u0000-\u001F\u007F]/u.test(data.title)) invalid();
  const origin='http://127.0.0.1:'+port;
  function parse(link,view) {
    if (typeof link!=='string' || link.length>4096) invalid();
    let url;
    try { url=new URL(link); } catch { invalid(); }
    if (url.origin!==origin || url.username || url.password || url.hash || url.href!==link) invalid();
    const parts=url.pathname.split('/');
    if (parts.length!==4 || parts[1]!=='w' || !validPageId(parts[2]) || parts[3]!==view) invalid();
    const key=url.searchParams.get('k');
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key) || url.search!=='?k='+key) invalid();
    return {pathId:parts[2],key};
  }
  const form=parse(data.form_url,'form'), list=parse(data.list_url,'records');
  if (form.pathId!==list.pathId || form.key!==list.key) invalid();
  const clean={package_ref:args.package_ref,title:data.title,form_url:data.form_url,list_url:data.list_url};
  if (JSON.stringify(clean).includes(capability)) invalid();
  return clean;
}
function workPackageRecord(args,data) {
  const invalid=()=>{ throw new LocalError('invalid_companion_response'); };
  if (!isObject(data) || data.package_ref!==args.package_ref || !validPageId(data.record_id) ||
      data.record_id.toLowerCase()!==args.record_id.toLowerCase() || !isObject(data.values)) invalid();
  const fields=Object.entries(data.values);
  if (fields.some(([key,value])=> !validReference(key) ||
      !(value===null || Number.isFinite(value) || (typeof value==='string' && value.length<=10000)))) invalid();
  const clean={package_ref:args.package_ref,record_id:data.record_id,values:Object.fromEntries(fields)};
  if (JSON.stringify(clean).includes(capability)) invalid();
  return clean;
}
async function invoke(name, args, signal) {
  if (!configured) return toolResult({code:'connector_unavailable'}, true);
  try {
    const data = await localCall(routes.get(name), args, signal);
    if (name === 'describe_page_context') return toolResult(contextDescription(data));
    if (name === 'open_work_package') return toolResult(workPackageLinks(args,data));
    if (name === 'get_work_package_record') return toolResult(workPackageRecord(args,data));
    return toolResult(sanitizePage(name,args,data));
  } catch (error) {
    return toolResult({ code:error instanceof LocalError ? error.message : 'companion_unavailable' }, true);
  }
}
const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
const pending = new Map();
let phase = 'new';
async function handle(message) {
  const validId = isObject(message) && (typeof message.id === 'string' || Number.isSafeInteger(message.id));
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (Object.hasOwn(message, 'id') && !validId)) {
    return fail(validId ? message.id : null, -32600, 'Invalid Request');
  }
  const { id, method, params = {} } = message;
  if (!validId) {
    if (method === 'notifications/initialized' && phase === 'initializing') phase = 'ready';
    if (method === 'notifications/cancelled') pending.get(params?.requestId)?.abort();
    return;
  }
  if (!isObject(params)) return fail(id, -32602, 'Invalid params');
  const result = value => write({ jsonrpc: '2.0', id, result: value });
  if (method === 'ping') return result({});
  if (method === 'initialize') {
    if (phase !== 'new') return fail(id, -32600, 'Already initialized');
    if (typeof params.protocolVersion !== 'string' || !isObject(params.capabilities) || !isObject(params.clientInfo)) {
      return fail(id, -32602, 'Invalid initialize params');
    }
    phase = 'initializing';
    return result({
      protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
      capabilities: { tools: {} }, serverInfo: { name: 'instant-page-mcp', version }
    });
  }
  if (phase !== 'ready') return fail(id, -32002, 'Initialization incomplete');
  if (method === 'tools/list') return result({ tools });
  if (method !== 'tools/call') return fail(id, -32601, 'Method not found');
  const { name, arguments: args = {} } = params;
  if (!routes.has(name)) return fail(id, -32602, 'Unknown tool');
  if (!validToolArguments(name, args)) return result(toolResult({ code: 'invalid_arguments' }, true));
  if (pending.has(id)) return fail(id, -32600, 'Duplicate request id');
  const controller = new AbortController();
  pending.set(id, controller);
  try {
    const output = await invoke(name, args, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
    if (!controller.signal.aborted) result(output);
  } finally { pending.delete(id); }
}

const input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
input.on('line', line => {
  if (Buffer.byteLength(line) > 262144) { fail(null, -32600, 'Request too large'); return; }
  let msg;
  try { msg = JSON.parse(line); }
  catch { fail(null, -32700, 'Parse error'); return; }
  handle(msg).catch(() => fail(null, -32603, 'Internal error'));
});
input.on('close', () => { for (const ctl of pending.values()) ctl.abort(); });
