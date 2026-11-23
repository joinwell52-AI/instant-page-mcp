import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, toNamespacedPath } from 'node:path';
import { isObject, validPageId } from './schema.mjs';
import { renderPage } from './render.mjs';
import { validateFieldContract } from './field-contract.mjs';

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
}
function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}
export class PageError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const scopeKeys = ['principal','workspace','task'];
function loadContext(path) {
  const registry = JSON.parse(readFileSync(path,'utf8'));
  if (!isObject(registry) || !scopeKeys.every(k => typeof registry[k] === 'string' && registry[k].trim()) ||
      !['facts','tables','fields','actions'].every(k => isObject(registry[k]))) throw Error('invalid_page_context');
  validateFieldContract(registry);
  return registry;
}
function record(path, data) {
  writeFileSync(path, JSON.stringify(data), { encoding:'utf8', mode:0o600, flag:'wx' });
}
function read(path) { return JSON.parse(readFileSync(path,'utf8')); }
function nonce() { return randomBytes(32).toString('base64url'); }
// Both files are ready before a directory becomes visible. An existing committed directory is never overwritten.
export function publishDirectory(parent, name, write) {
  // Windows mkdtemp needs an extended-length path for deeply nested page data.
  const stage = mkdtempSync(toNamespacedPath(join(parent,'.stage-')));
  const dest = join(parent,name);
  try {
    write(stage);
    try { renameSync(stage,dest); return true; }
    catch (error) { if (!existsSync(dest)) throw error; return false; }
  } finally { rmSync(stage,{ recursive:true, force:true }); }
}
export class PageStore {
  constructor({directory, contextFile, capability, linkTtlSeconds = 0}) {
    if (!Number.isSafeInteger(linkTtlSeconds) || linkTtlSeconds < 0 ||
        !Number.isSafeInteger(Date.now() + linkTtlSeconds * 1000)) throw Error('invalid_link_ttl');
    this.linkTtlSeconds = linkTtlSeconds;
    this.directory = directory;
    this.contextFile = contextFile;
    this.registry = loadContext(contextFile);
    this.contextDigest = fingerprint(this.registry);
    this.root = join(directory,'contexts',this.contextDigest);
    mkdirSync(this.root,{ recursive:true, mode:0o700 });
    // A local host capability already used for one business identity cannot be reused for a different one.
    const keys = join(directory,'capabilities');
    mkdirSync(keys,{ recursive:true, mode:0o700 });
    const scope = fingerprint(scopeKeys.map(k=>this.registry[k]));
    const key = fingerprint(capability);
    publishDirectory(keys,key,dir=>record(join(dir,'scope.json'),{scope}));
    if (read(join(keys,key,'scope.json')).scope !== scope) throw Error('capability_bound_to_other_context');
    this.byPage = new Map();
    this.refreshIndex();
  }
  current() {
    try {
      if (fingerprint(loadContext(this.contextFile)) === this.contextDigest) return;
    } catch { /* Revoked or malformed host state is inaccessible. */ }
    throw new PageError(403,'context_unavailable');
  }
  refreshIndex() {
    for (const id of readdirSync(this.root)) {
      if (!validPageId(id)) continue;
      const {page_id} = read(join(this.root,id,'page.json'));
      if (!validPageId(page_id)) throw Error('invalid_page_store');
      this.byPage.set(page_id,id);
    }
  }
  generate({request_id,specification}) {
    this.current();
    const id = request_id.toLowerCase();
    const reqDir = join(this.root,id);
    const hash = fingerprint(specification);
    if (!existsSync(reqDir)) {
      const page = {page_id:randomUUID(),access:nonce(),formToken:nonce(),hash,specification};
      if (this.linkTtlSeconds > 0) page.browser_expires_at_ms = Date.now() + this.linkTtlSeconds * 1000;
      const html = renderPage(specification,this.registry,{pageId:page.page_id,formToken:page.formToken,state:'open'});
      publishDirectory(this.root,id,dir=>{
        record(join(dir,'page.json'),page);
        writeFileSync(join(dir,'open.html'),html,{mode:0o600,flag:'wx'});
      });
    }
    const page = read(join(reqDir,'page.json'));
    if (page.hash !== hash) throw new PageError(409,'request_conflict');
    this.byPage.set(page.page_id,id);
    return this.get(page.page_id);
  }
  get(id) {
    this.current();
    id = id.toLowerCase();
    if (!this.byPage.has(id)) this.refreshIndex();
    const key = this.byPage.get(id);
    if (!key) throw new PageError(404,'page_not_found');
    const path = join(this.root,key);
    const data = read(join(path,'page.json'));
    const submitted = existsSync(join(path,'answer'));
    return {path,data,state:submitted?'submitted':'open',submission:submitted?read(join(path,'answer','answer.json')):undefined};
  }
  assertBrowserLinkActive(page) {
    const deadline = page.data.browser_expires_at_ms;
    if (deadline !== undefined && (!Number.isSafeInteger(deadline) || Date.now() >= deadline)) {
      throw new PageError(410, 'page_link_expired');
    }
  }
  html(page) {
    return readFileSync(page.state==='submitted'?join(page.path,'answer','submitted.html'):join(page.path,'open.html'));
  }
  attachment(page) {
    if (!page.submission?.attachment) throw new PageError(404,'attachment_not_found');
    return readFileSync(join(page.path,'answer','attached-image'));
  }
  submit(page, answer, upload) {
    this.current();
    this.assertBrowserLinkActive(page);
    const logical = {action:answer.action.kind,reference:answer.action.reference,values:answer.fields,
      ...(upload ? {attachment:upload.metadata} : {})};
    if (!page.submission) {
      const submission = {...logical, submitted_at:new Date().toISOString()};
      const html = renderPage(page.data.specification,this.registry,{
        pageId:page.data.page_id,state:'submitted',formToken:'',submission
      });
      publishDirectory(page.path,'answer',dir=>{
        record(join(dir,'answer.json'),submission);
        if (upload) writeFileSync(join(dir,'attached-image'),upload.image,{mode:0o600,flag:'wx'});
        writeFileSync(join(dir,'submitted.html'),html,{mode:0o600,flag:'wx'});
      });
    }
    const settled = this.get(page.data.page_id);
    const {submitted_at,...saved} = settled.submission;
    if (fingerprint(logical)!==fingerprint(saved)) throw new PageError(409,'page_already_submitted');
    return settled;
  }
}
