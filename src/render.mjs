import { escape, pageAppearance } from './appearance.mjs';
import { validPageSpecification } from './schema.mjs';
import { version } from './version.mjs';
import { AnswerError, UnknownReference, validateFieldDefinition, normalizeFieldInput as cleanValue, readSubmittedField, displayFieldValue } from './field-rules.mjs';

export { AnswerError, UnknownReference };

const own = (obj, key) => obj != null && Object.hasOwn(obj, key);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasLabel = v => typeof v === 'string' && v.trim() !== '';
const scalar = v => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const pageSubmit = { reference: 'page-submit', kind: 'submit_response', label: '提交' };
const columnName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export function pageBrand(presentation) {
  return '<footer class="ipm-brand">'+presentation.menu+'<div>'+
    presentation.markup('即页 · IPM','Instant Page MCP · IPM')+' <span>v'+escape(version)+'</span></div></footer>'+
    presentation.script;
}

function lookup(registry, group, ref) {
  if (!object(registry?.[group]) || !own(registry[group], ref)) throw new UnknownReference('页面引用在当前上下文不可用。');
  const source = registry[group][ref];
  if (!object(source) || !hasLabel(source.label)) throw new UnknownReference('页面引用缺少有效定义。');
  return source;
}

function fieldDefinition(registry, ref) {
  return validateFieldDefinition(lookup(registry, 'fields', ref));
}

export function resolvePageFields(spec, registry) {
  const inlineFields = new Map();
  for (const {ref, ...definition} of spec.fields ?? []) {
    if (inlineFields.has(ref) || own(registry?.fields, ref)) {
      throw new UnknownReference('本页字段标识重复或与当前上下文字段冲突。');
    }
    inlineFields.set(ref, validateFieldDefinition(definition));
  }
  const fields = new Map();
  for (const block of spec.blocks) {
    if (block.kind !== 'input') continue;
    const ref = block.field_ref;
    if (fields.has(ref)) throw new UnknownReference('同一页面重复引用输入字段。');
    fields.set(ref, inlineFields.get(ref) ?? fieldDefinition(registry, ref));
  }
  for (const ref of inlineFields.keys()) {
    if (!fields.has(ref)) throw new UnknownReference('本页字段必须放入输入区块。');
  }
  return fields;
}

function resolve(spec, registry) {
  if (!validPageSpecification(spec)) throw new UnknownReference('页面声明格式无效。');
  const fields = resolvePageFields(spec, registry);
  const actions = new Map();
  const blocks = spec.blocks.map(b => {
    if (b.kind === 'narrative') return b;
    if (b.kind === 'input') return { ...b, source: fields.get(b.field_ref) };
    if (b.kind === 'facts') {
      const source = lookup(registry,'facts',b.source_ref);
      if (!Array.isArray(source.items) || source.items.some(i => !object(i) || !hasLabel(i.label) || !scalar(i.value)))
        throw new UnknownReference('资料条目无效。');
      return { ...b, source };
    }
    const source = lookup(registry,'tables',b.source_ref);
    if (!object(source.columns) || !Array.isArray(source.rows)) throw new UnknownReference('表格定义无效。');
    const cols = b.columns ?? Object.keys(source.columns);
    if (cols.length < 1 || cols.length > 8 || cols.some(k => !columnName.test(k) || !own(source.columns,k) || !hasLabel(source.columns[k])) ||
      source.rows.some(row => !object(row) || cols.some(k => (own(row,k) && row[k] !== null && !scalar(row[k])))))
      throw new UnknownReference('表格列或数据类型无效。');
    return { ...b, source, cols };
  });
  for (const a of spec.actions) {
    const usePageSubmit = (spec.fields?.length > 0 || spec.attachment) && a.reference === pageSubmit.reference &&
      !own(registry?.actions, a.reference);
    const source = usePageSubmit ? pageSubmit : lookup(registry,'actions',a.reference);
    if (source.kind !== a.kind || actions.has(a.reference)) throw new UnknownReference('页面操作未授权或重复。');
    actions.set(a.reference,source);
  }
  if (spec.attachment && !actions.size) throw new UnknownReference('图片附件需要一个提交动作。');
  return { blocks, fields, actions };
}

export function validateAnswer(spec, registry, params) {
  const { fields, actions } = resolve(spec,registry);
  const seen = new Set(), submitted = new Map();
  let action;
  for (const [key,raw] of params) {
    if (seen.has(key)) throw new AnswerError('表单字段重复。');
    seen.add(key);
    if (key === 'form_token') continue;
    if (key === 'action') { action=raw; continue; }
    if (!key.startsWith('field.') || !fields.has(key.slice(6))) throw new AnswerError('表单包含未声明的字段。');
    submitted.set(key.slice(6), raw.trim());
  }
  if (!actions.has(action)) throw new AnswerError('请选择本页允许的操作。');
  const values = [];
  for (const [ref,f] of fields) {
    const value = readSubmittedField(ref, f, submitted.get(ref));
    if (value !== undefined) values.push([ref,value]);
  }
  return { action:{ kind:actions.get(action).kind, reference:action }, fields:Object.fromEntries(values) };
}

function pageInitialValues(spec, fields) {
  const values = new Map();
  for (const [ref, value] of Object.entries(spec.initial_values ?? {})) {
    const field = fields.get(ref);
    if (!field) throw new UnknownReference('预填值必须对应本页的输入字段。');
    const raw = field.type === 'number' && typeof value === 'number' ? String(value) : value;
    values.set(ref, readSubmittedField(ref, field, raw));
  }
  return values;
}

function inputHtml(f,ref,id,locked,value,presentation=pageAppearance()) {
  const {text,markup,placeholder} = presentation;
  const label = '<label for="'+id+'">'+presentation.fieldLabel(ref,f.label)+(f.required?' <small>'+markup('必填','Required')+'</small>':'')+'</label>';
  if (locked) {
    const saved = displayFieldValue(f,value);
    return label+'<output id="'+id+'">'+(saved == null ? markup('未填写','Not provided') : escape(saved))+'</output>';
  }
  const attrs = ' id="'+id+'" name="field.'+escape(ref)+'"'+(f.required?' required':'');
  const valueAttr = value === undefined ? '' : ' value="'+escape(value)+'"';
  if (f.type === 'select') return label+'<select'+attrs+'><option value=""'+presentation.label('请选择','Select an option')+'>'+text('请选择','Select an option')+'</option>'+
    f.options.map(x=>'<option value="'+escape(x)+'"'+(x===value?' selected':'')+'>'+escape(x)+'</option>').join('')+'</select>';
  if (f.format === 'cn_mobile') {
    return label+'<input'+attrs+' type="tel" inputmode="tel" autocomplete="tel" maxlength="17"'+placeholder('11 位手机号，可带 +86','11-digit mobile number, +86 optional')+valueAttr+'>';
  }
  if (f.format === 'cn_resident_id') {
    return label+'<input'+attrs+' type="text" inputmode="text" autocapitalize="characters" spellcheck="false" autocomplete="off" minlength="18" maxlength="18" pattern="[0-9]{17}[0-9Xx]"'+placeholder('18 位，末位可以是 X','18 characters, final X allowed')+valueAttr+'>';
  }
  const attr = (key, val) => val === undefined ? '' : ' '+key+'="'+escape(val)+'"';
  if (f.type === 'textarea' || f.type === 'text') {
    const limits = attr('minlength', f.min_length) + attr('maxlength', f.max_length ?? 2000);
    if (f.type === 'textarea') return label+'<textarea'+attrs+' rows="3"'+limits+'>'+escape(value ?? '')+'</textarea>';
    return label+'<input'+attrs+' type="text"'+limits+valueAttr+'>';
  }
  const limits = attr('min', f.min) + attr('max', f.max);
  const step = f.type === 'number' ? attr('step', f.integer ? '1' : 'any') : '';
  return label+'<input'+attrs+' type="'+f.type+'"'+step+limits+valueAttr+'>';
}

const styles = `
:root{font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#183632;background:#eef3f0;color-scheme:light}*{box-sizing:border-box}body{margin:0;line-height:1.6}
main{max-width:52rem;margin:2rem auto;padding:clamp(1.2rem,5vw,3rem);background:white;border:1px solid #d1ded7;border-radius:1rem}h1{font-size:clamp(1.6rem,5vw,2.25rem);line-height:1.3;margin:0}h2{font-size:1.08rem;margin:0 0 .65rem}
header{border-bottom:2px solid #37755d;padding-bottom:1rem}header p{margin:.65rem 0 0;color:#435f54}.ipm-brand{display:flex;justify-content:flex-end;flex-wrap:wrap;align-items:baseline;gap:.45rem;margin-top:1.6rem;font-size:.875rem;font-weight:650;text-align:right}.ipm-brand span{font-weight:400}.ipm-language{display:flex;align-items:center;gap:.4rem;margin-right:.3rem}.ipm-language select{width:auto;margin:0;padding:.2rem .4rem}section{margin:1.35rem 0}p,dt,dd,td,th,output,h1,h2,label{overflow-wrap:anywhere}.note,output,dd{white-space:pre-wrap}.note,.receipt{background:#edf6ee;border-left:3px solid #367559;padding:.8rem 1rem}
dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,8rem),1fr));gap:.6rem;margin:0}dl div{background:#f1f5f2;padding:.6rem .8rem;border-radius:.45rem}dt,small{color:#50685c;font-size:.86rem}dd{margin:.1rem 0 0;font-weight:650}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.5rem .65rem;border-bottom:1px solid #dce6e0}th{background:#f2f6f3}
input,textarea,select,button{font:inherit}input,textarea,select,output{display:block;width:100%;max-width:100%;margin-top:.35rem;padding:.55rem .7rem;border:1px solid #9cafa2;border-radius:.4rem;background:white;color:inherit}label{display:block;font-weight:650}small{font-weight:400}textarea{resize:vertical}
.buttons{display:flex;flex-wrap:wrap;gap:.6rem}button{background:#245e46;color:#fff;border:0;padding:.6rem 1rem;border-radius:.5rem;cursor:pointer}:focus-visible{outline:3px solid #b47e1b;outline-offset:2px}.receipt{margin:.85rem 0 0}
@media(max-width:600px){main{min-height:100vh;margin:0;border:0;border-radius:0}td,th{padding:.48rem .4rem}} `;

export function imageAttachmentInput(attachment,presentation) {
  const {markup} = presentation;
  if (!attachment) return '';
  return '<section><label for="attachment">'+escape(attachment.label)+
    (attachment.required?' <small>'+markup('必填','Required')+'</small>':'')+'</label><input id="attachment" name="attachment" type="file"'+
    ' accept="image/png,image/jpeg"'+(attachment.required?' required':'')+'><small>'+markup('PNG 或 JPEG，最多 10 MiB','PNG or JPEG, up to 10 MiB')+'</small></section>';
}

export function renderPage(spec, registry, options = {}) {
  const { blocks, fields, actions } = resolve(spec,registry);
  const { pageId, state, formToken, submission }=options;
  const initial = state === 'submitted' ? new Map() : pageInitialValues(spec, fields);
  const submitted=state==='submitted', interactive=!submitted && actions.size > 0 && typeof formToken==='string' && formToken.length>0 && typeof pageId==='string' && pageId.length>0;
  const presentation = pageAppearance(spec.appearance);
  const {markup,lang} = presentation;
  const title = spec.appearance?.translations?.title?.[lang] ?? spec.title;
  const fieldSection = presentation.grid ? '<section class="field">' : '<section>';
  const content=blocks.map((b,i)=>{
    if (b.kind === 'narrative') return '<section><p class="note">'+escape(b.text)+'</p></section>';
    const s=b.source;
    if (b.kind === 'input') {
      const value = submitted ? (own(submission?.values,b.field_ref) ? submission.values[b.field_ref] : undefined) : initial.get(b.field_ref);
      return fieldSection+inputHtml(s,b.field_ref,'f'+i,!interactive,value,presentation)+'</section>';
    }
    const start='<section><h2>'+escape(s.label)+'</h2>';
    if (b.kind === 'facts') return start+'<dl>'+s.items.map(v=>'<div><dt>'+escape(v.label)+'</dt><dd>'+escape(v.value)+'</dd></div>').join('')+'</dl></section>';
    return start+'<div class="scroll"><table><thead><tr>'+b.cols.map(k=>'<th scope="col">'+escape(s.columns[k])+'</th>').join('')+'</tr></thead><tbody>'+
      s.rows.map(r=>'<tr>'+b.cols.map(k=>'<td>'+escape(own(r,k)?r[k]??'—':'—')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div></section>';
  }).join('');
  const actionLabel = value => value === pageSubmit ? markup('提交','Submit') : escape(value.label);
  const buttonHtml=[...actions].map(([ref,a])=>'<button type="submit" name="action" value="'+escape(ref)+'">'+actionLabel(a)+'</button>').join('');
  const upload = spec.attachment;
  const attachmentField = imageAttachmentInput(upload,presentation);
  const body=interactive?'<form method="post" action="/p/'+escape(encodeURIComponent(pageId))+'/submit"'+(upload?' enctype="multipart/form-data"':'')+'><input type="hidden" name="form_token" value="'+escape(formToken)+'">'+content+attachmentField+'<div class="buttons">'+buttonHtml+'</div></form>':
    (presentation.grid ? '<div class="page-content">'+content+'</div>' : content);
  const receipt=submitted?'<p class="receipt" role="status">'+markup('已记录你的选择','Your response was saved')+(actions.has(submission?.reference)?' · '+actionLabel(actions.get(submission.reference)):'')+'</p>':'';
  const attached = submitted && submission?.attachment ? '<p>'+markup('已保存图片附件：','Image saved: ')+escape(submission.attachment.filename)+'</p>' : '';
  return '<!doctype html><html lang="'+lang+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="strict-origin"><title>'+escape(title)+'</title><style>'+styles+presentation.css+'</style></head><body><main'+presentation.mainAttributes+'><header><h1>'+presentation.title(spec.title)+'</h1><p>'+presentation.purpose(spec.purpose)+'</p></header>'+receipt+body+attached+pageBrand(presentation)+'</main></body></html>';
}

export { fieldDefinition, inputHtml, cleanValue, escape, styles };
