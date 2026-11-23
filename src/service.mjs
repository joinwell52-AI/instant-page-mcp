import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { languageScriptHash, pageAppearance } from './appearance.mjs';
import { MAX_IMAGE_BYTES, readImageForm } from './attachment.mjs';
import { isObject, validAction, validPageId, validReference, validToolArguments } from './schema.mjs';
import { displayFieldValue, isSensitiveField, validateFormAt } from './field-rules.mjs';
import { UnknownReference, AnswerError, validateAnswer, renderPage, fieldDefinition, resolvePageFields, escape, pageBrand, styles } from './render.mjs';
import { PageError, PageStore, scopeKeys } from './store.mjs';
import { createWorkPackagePages } from './work-package.mjs';

const privateHeaders = { 'cache-control':'no-store', 'referrer-policy':'strict-origin', 'x-content-type-options':'nosniff', 'x-robots-tag':'noindex, nofollow' };
const apiRoutes = new Map([
  ['/v1/pages/context','describe_page_context'],
  ['/v1/work-packages/open','open_work_package'],
  ['/v1/work-packages/record','get_work_package_record'],
  ['/v1/work-packages/attachment','get_work_package_record'],
  ['/v1/pages/generate','generate_interaction_page'],
  ['/v1/pages/read','get_interaction_page'],
  ['/v1/pages/result','get_interaction_result'],
  ['/v1/pages/attachment','get_interaction_result'],
]);
const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; script-src '" +
  languageScriptHash + "'; form-action 'self'; frame-ancestors 'none'";
function sameSecret(value,expected) {
  const digest=s=>createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(digest(value),digest(expected));
}
function json(res,status,value) {
  res.writeHead(status,{...privateHeaders,'content-type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}
function reject(code,message) { throw new PageError(code,message); }
async function readBytes(req, type, limit) {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== type) reject(415,'wrong_content_type');
  if (Number(req.headers['content-length']) > limit) reject(413,'content_too_large');
  const chunks=[];
  let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if (size>limit) reject(413,'content_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readBody(req, type) {
  const limit = type === 'application/x-www-form-urlencoded' ? 2 * 1024 * 1024 : 256 * 1024;
  return (await readBytes(req, type, limit)).toString('utf8');
}
async function readSubmission(req, attachment, formUrl, appearance) {
  if (!attachment) return {form: new URLSearchParams(await readBody(req, 'application/x-www-form-urlencoded'))};
  const bytes = await readBytes(req, 'multipart/form-data', MAX_IMAGE_BYTES + 256 * 1024);
  try {
    return await readImageForm(bytes, req.headers['content-type'], attachment);
  } catch (error) {
    if (error instanceof AnswerError) {
      error.formUrl = formUrl;
      error.appearance = appearance;
    }
    throw error;
  }
}
function sendAttachment(res, metadata, image) {
  res.writeHead(200, {...privateHeaders, 'content-type':metadata.content_type,
    'content-disposition':'attachment', 'content-length':image.length});
  res.end(image);
}
const answerErrorsEn = new Map([
  ['id_shape','Enter 18 characters. The last character can be X.'],
  ['id_birth_date','The date of birth in the ID number is invalid.'],
  ['id_checksum','The ID number check digit does not match.'],
  ['phone_format','Enter an 11-digit mainland China mobile number. The +86 prefix is optional.'],
  ['invalid_type','Enter a text value.'],
  ['required','Fill in this required field.'],
  ['text_format','Enter text in the expected format.'],
  ['text_length','The text length is outside the allowed range.'],
  ['invalid_choice','This option is no longer available.'],
  ['number_format','Enter a valid number.'],
  ['number_range','The number is outside the allowed range.'],
  ['date_format','Enter a valid date.'],
  ['date_range','The date is outside the allowed range.'],
  ['invalid_multipart','The image upload format is invalid.'],
  ['invalid_attachment','Attach only one image.'],
  ['attachment_required','Attach the original image.'],
  ['attachment_too_large','The image must be at most 10 MiB.'],
  ['invalid_attachment_type','Select a PNG or JPEG image.']
]);

function formFeedback(req, res, error) {
  const wantsJson = (req.headers.accept ?? '').split(',').some(range => {
    const [media, ...params] = range.toLowerCase().trim().split(';');
    return media.trim() === 'application/json' && !params.some(p => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p));
  });
  if (wantsJson || !error.formUrl) {
    return json(res, 400, { code: 'invalid_answer', reason: error.code, field_ref: error.fieldRef });
  }
  const presentation = pageAppearance(error.appearance);
  const {lang,text,markup} = presentation;
  const title = text('请检查填写内容','Check your entries');
  const message = markup(error.message, answerErrorsEn.get(error.code) ?? 'Check the submitted fields and action.');
  const field = error.fieldLabel ? '<strong>' + escape(error.fieldLabel) + '</strong>' + text('：',': ') : '';
  res.writeHead(400, { ...privateHeaders, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp });
  res.end('<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title>' +
    '<style>' + styles + presentation.css + '</style></head><body><main' + presentation.mainAttributes + '><h1>' + markup('请检查填写内容','Check your entries') + '</h1>' +
    '<p role="alert">' + field + message + '</p><p>' +
    markup('请使用浏览器返回键修改，或重新打开表单。','Go back in your browser or reopen the form.') + '</p>' +
    '<a href="' + escape(error.formUrl) + '">' + markup('重新打开表单','Reopen form') + '</a>' +
    pageBrand(presentation) + '</main></body></html>');
}
function errors(req,res,error) {
  if (res.headersSent) { res.destroy(); return; }
  if(error instanceof PageError) return json(res,error.status,{code:error.message});
  if(error instanceof UnknownReference) return json(res,404,{code:'unknown_reference'});
  if(error instanceof AnswerError) return formFeedback(req,res,error);
  return json(res,500,{code:'page_service_error'});
}
const guarded = handler => (req,res)=>handler(req,res).catch(error=>errors(req,res,error));

function describeContext(registry, inlinePackages) {
  // Project only public schema labels. Data rows, identity, option values and credentials never enter this response.
  const fromMap = (map, project) => Object.entries(map).map(([ref,entry])=>{
    if (!validReference(ref) || !isObject(entry) || typeof entry.label !== 'string' || !entry.label.trim()) throw new PageError(503,'invalid_context_metadata');
    return project(ref,entry);
  });
  const packages = registry.work_packages;
  if (packages !== undefined && !isObject(packages)) throw new PageError(503,'invalid_context_metadata');
  const workPackages = [...fromMap(packages ?? {}, (ref, {label}) => ({ref, label})), ...inlinePackages];
  return {
    ...(packages === undefined && !workPackages.length ? {} : {work_packages:workPackages}),
    facts:fromMap(registry.facts,(ref,{label})=>({ref,label})),
    tables:fromMap(registry.tables,(ref,{label,columns})=>{
      if (!isObject(columns)) throw new PageError(503,'invalid_context_metadata');
      const safe=Object.entries(columns).map(([id,label])=>{
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(id) || typeof label!=='string' || !label.trim()) throw new PageError(503,'invalid_context_metadata');
        return {id,label};
      });
      return {ref,label,columns:safe};
    }),
    fields:fromMap(registry.fields,(ref)=> {
      const {label,type,format} = fieldDefinition(registry, ref);
      return format === undefined ? {ref,label,type} : {ref,label,type,format};
    }),
    actions:fromMap(registry.actions,(reference,{label,kind})=>{
      if (!validAction({kind,reference})) throw new PageError(503,'invalid_context_metadata');
      return {reference,label,kind};
    }),
  };
}
function setting(name) {
  const preferred=process.env['PAGE_MCP_'+name];
  const legacy=process.env['CFM_PAGE_'+name];
  if (preferred!==undefined && legacy!==undefined && preferred!==legacy) throw Error('conflicting_configuration');
  return preferred ?? legacy;
}
export function createPageService({directory,contextFile,capability,linkTtlSeconds}) {
  if(typeof capability !== 'string'||!/^[A-Za-z0-9._~-]{32,512}$/.test(capability)) throw Error('invalid_capability');
  if(typeof directory!=='string'||!directory||typeof contextFile!=='string'||!contextFile) throw Error('missing_page_storage_or_context');
  const store=new PageStore({directory,contextFile,capability,linkTtlSeconds});
  const packages=createWorkPackagePages(store);
  const base=()=> 'http://127.0.0.1:'+server.address().port;
  const pagePath=page=>'/p/'+page.data.page_id;
  const localUrl=page=>base()+pagePath(page)+'?k='+page.data.access;
  async function browser(req,res,origin,authenticate) {
    if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')) reject(404,'not_found');
    const u = new URL(req.url,origin);
    if (u.origin!==origin) reject(404,'not_found');
    if (packages.matches(u.pathname)) return packages.handle(req,res,{origin,authenticate,readSubmission,headers:privateHeaders,csp});
    const parsed = /^\/p\/([a-f0-9-]+)(\/submit)?$/i.exec(u.pathname);
    if(!parsed||!validPageId(parsed[1])) reject(404,'not_found');
    const submit=Boolean(parsed[2]);
    if(req.method!==(submit?'POST':'GET')) reject(405,'method_not_allowed');
    if(authenticate) {
      const user=await authenticate(req);
      if(!user || !scopeKeys.every(key=>user[key]===store.registry[key])) reject(403,'access_denied');
    }
    const page=store.get(parsed[1]);
    if(!submit) {
      if((!authenticate && (u.searchParams.getAll('k').length!==1||!sameSecret(u.searchParams.get('k'),page.data.access))) ||
         (authenticate && u.searchParams.has('k'))) reject(403,'access_denied');
      store.assertBrowserLinkActive(page);
      res.writeHead(200,{...privateHeaders,'content-type':'text/html; charset=utf-8','content-security-policy':csp});
      // Older releases cached submitted HTML before formats supported masking.
      // Render sensitive inputs using the current display policy on every read.
      const fields = resolvePageFields(page.data.specification, store.registry);
      const sensitive = [...fields.values()].some(isSensitiveField);
      if (sensitive) {
        res.end(renderPage(page.data.specification,store.registry,{
          pageId:page.data.page_id,state:page.state,formToken:page.data.formToken,submission:page.submission
        }));
      } else {
        res.end(store.html(page));
      }
      return;
    }
    if(req.headers.origin!==origin) reject(403,'origin_denied');
    store.assertBrowserLinkActive(page);
    const {specification} = page.data;
    const formUrl=authenticate ? pagePath(page) : localUrl(page);
    const {form, upload} = await readSubmission(req, specification.attachment, formUrl, specification.appearance);
    if(form.getAll('form_token').length!==1||!sameSecret(form.get('form_token'),page.data.formToken)) reject(403,'invalid_form');
    const answer=validateFormAt(formUrl, () => validateAnswer(specification,store.registry,form), specification.appearance);
    const settled=store.submit(page,answer,upload);
    res.writeHead(303,{...privateHeaders,location:authenticate?pagePath(settled):localUrl(settled)});
    res.end();
  }
  const server=http.createServer(guarded(async(req,res)=>{
    if(req.headers.host!==new URL(base()).host) reject(403,'invalid_host');
    if(req.url?.startsWith('/p/') || req.url?.startsWith('/w/')) return browser(req,res,base(),undefined);
    if(!apiRoutes.has(req.url)||req.method!=='POST') reject(404,'not_found');
    if(!sameSecret(req.headers.authorization,'Bearer '+capability)||
       (req.headers.origin && req.headers.origin!==base())) reject(403,'scope_denied');
    const body=await readBody(req,'application/json');
    let args;
    try{args=JSON.parse(body);}catch{reject(400,'invalid_json');}
    if(!validToolArguments(apiRoutes.get(req.url),args)) reject(400,'invalid_arguments');
    if (req.url==='/v1/pages/context') {
      store.current();
      return json(res,200,describeContext(store.registry,packages.listInline()));
    }
    if (req.url==='/v1/work-packages/record') {
      return json(res,200,packages.getRecord(args.package_ref,args.record_id));
    }
    if (req.url==='/v1/work-packages/attachment') {
      const {metadata,image} = packages.getAttachment(args.package_ref,args.record_id);
      return sendAttachment(res,metadata,image);
    }
    if (req.url==='/v1/work-packages/open') {
      const {package_ref,title,form_path,list_path,access_key}=packages.open(args.package_ref,args.definition);
      const link=path=>{
        const url=new URL(path,base());
        url.searchParams.set('k',access_key);
        return url.href;
      };
      return json(res,200,{package_ref,title,form_url:link(form_path),list_url:link(list_path)});
    }
    const page=req.url==='/v1/pages/generate' ? store.generate(args) : store.get(args.page_id);
    if (req.url === '/v1/pages/attachment') {
      const image = store.attachment(page);
      return sendAttachment(res,page.submission.attachment,image);
    }
    const response={page_id:page.data.page_id,state:page.state};
    if(req.url==='/v1/pages/result') {
      if (page.submission) {
        const visible = [];
        for (const [ref, field] of resolvePageFields(page.data.specification, store.registry)) {
          if (Object.hasOwn(page.submission.values, ref)) {
            visible.push([ref, displayFieldValue(field, page.submission.values[ref])]);
          }
        }
        response.submission={...page.submission,values:Object.fromEntries(visible)};
      }
    } else {
      response.url=localUrl(page);
      response.title=page.data.specification.title;
    }
    json(res,200,response);
  }));
  return {
    server,
    listen(port=0) {
      return new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve(server.address().port);});
      });
    },
    close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),
    createAuthenticatedBrowserHandler({origin,authenticate}) {
      const canonical=new URL(origin);
      if(canonical.protocol!=='https:'||canonical.origin!==origin||typeof authenticate!=='function') throw Error('invalid_gateway_configuration');
      return guarded((req,res)=>browser(req,res,origin,authenticate));
    },
  };
}
export async function runPageService() {
  try {
    if(setting('PUBLIC_BASE')) throw Error('public_base_requires_authenticated_gateway');
    const portText=setting('PORT')??'';
    if(!/^[1-9][0-9]{0,4}$/.test(portText)||Number(portText)>65535) throw Error('invalid_port');
    const ttlText = setting('LINK_TTL_SECONDS');
    if (ttlText !== undefined && !/^[0-9]+$/.test(ttlText)) throw Error('invalid_link_ttl');
    const instance=createPageService({directory:setting('DATA_DIR'),contextFile:setting('CONTEXT_FILE'),
      capability:setting('CAPABILITY'),linkTtlSeconds:ttlText === undefined ? 0 : Number(ttlText)});
    await instance.listen(Number(portText));
    console.log('独立页面服务已在本机回环接口启动。');
  } catch {
    console.error('服务启动失败，请核对上下文文件、存储目录、能力值与本机端口。');
    process.exitCode=1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPageService();
}
