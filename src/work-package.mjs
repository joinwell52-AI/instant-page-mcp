import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageAppearance } from './appearance.mjs';
import { validateFieldContract } from './field-contract.mjs';
import { displayFieldValue, isSensitiveField, readSubmittedField, validateFormAt } from './field-rules.mjs';
import { AnswerError, escape, fieldDefinition, imageAttachmentInput, inputHtml, pageBrand, styles } from './render.mjs';
import { isObject, validAttachmentSpec, validPageAppearance, validPageId, validReference } from './schema.mjs';
import { PageError, publishDirectory, scopeKeys } from './store.mjs';

const directoryMode = { recursive: true, mode: 0o700 };
const own = (obj, key) => Object.hasOwn(obj, key);
const hmac = (key, message) => createHmac('sha256', key).update(message).digest('base64url');

function sameSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const digest = text => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

// Write first, then publish the complete inode without replacing an existing committed file.
function publishOnce(directory, filename, contents) {
  const temporary = join(directory, '.pending-' + randomUUID());
  const destination = join(directory, filename);
  writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
  try {
    try {
      linkSync(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    }
    return true;
  } finally {
    unlinkSync(temporary);
  }
}

function packageId(snapshot, reference) {
  const bytes = createHash('sha256').update(JSON.stringify([snapshot, reference])).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
}

function specification(registry, reference) {
  const packages = registry.work_packages;
  if (!validReference(reference) || !isObject(packages) || !own(packages, reference)) {
    throw new PageError(404, 'work_package_not_found');
  }
  const definition = packages[reference];
  if (!isObject(definition) || typeof definition.label !== 'string' || !definition.label.trim()) {
    throw new PageError(503, 'invalid_work_package');
  }
  const parameters = definition.parameters;
  if (!Array.isArray(parameters) || !parameters.length || !parameters.every(validReference) ||
      new Set(parameters).size !== parameters.length) {
    throw new PageError(503, 'invalid_work_package_parameters');
  }
  const fields = new Map(parameters.map(ref => [ref, fieldDefinition(registry, ref)]));
  const explicitColumns = own(definition, 'list_columns');
  const columns = explicitColumns ? definition.list_columns : parameters.filter(ref => !isSensitiveField(fields.get(ref)));
  if (!Array.isArray(columns) || (explicitColumns && !columns.length) ||
      !columns.every(ref => fields.has(ref)) || new Set(columns).size !== columns.length) {
    throw new PageError(503, 'invalid_work_package_columns');
  }
  if (definition.appearance !== undefined && !validPageAppearance(definition.appearance)) {
    throw new PageError(503, 'invalid_work_package_appearance');
  }
  if (definition.attachment !== undefined && !validAttachmentSpec(definition.attachment)) {
    throw new PageError(503, 'invalid_work_package_attachment');
  }
  return { title: definition.label, fields, columns, appearance: definition.appearance,
    attachment: definition.attachment };
}

// Access keys and routes belong to the current snapshot. Rows belong to an authorized
// package and its input contract, so changing an unrelated table does not hide past input.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
}

function recordsKey(registry, reference, fields) {
  const parameters = Object.fromEntries(Array.from(fields, ([ref, field]) => {
    // Captions, field order and select option order change presentation only. Keep
    // unrecognized field metadata in the contract in case it narrows access.
    const {label, ...definition} = field;
    definition.required = field.required ?? false;
    if (field.type === 'number') definition.integer = field.integer ?? false;
    if (field.type === 'text' || field.type === 'textarea') definition.max_length = field.max_length ?? 2000;
    if (field.type === 'select') definition.options = [...field.options].sort();
    return [ref, definition];
  }));
  const identity = scopeKeys.map(k => registry[k]);
  const contract = canonical({identity, reference, parameters});
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function parseValues(fields, form) {
  const provided = new Map();
  for (const [key, value] of form) {
    if (key === 'form_token') continue;
    const ref = key.slice(6);
    if (!key.startsWith('field.') || !fields.has(ref) || provided.has(ref)) {
      throw new AnswerError('表单包含重复或未声明的字段。');
    }
    provided.set(ref, value.trim());
  }
  const result = [];
  for (const [ref, field] of fields) {
    const value = readSubmittedField(ref, field, provided.get(ref));
    if (value !== undefined) result.push([ref, value]);
  }
  return Object.fromEntries(result);
}

function document(title, suffix, links, body, presentation) {
  const {lang,text,markup} = presentation;
  const browserTitle = presentation.titleText(title) + ' · ' + text(...suffix);
  const heading = presentation.title(title) + ' · ' + markup(...suffix);
  return '<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(browserTitle) +
    '</title><style>' + styles + ' nav{display:flex;gap:1.1rem;margin-top:.8rem}' +
    ' a{color:#235e49}caption{text-align:left;padding:.7rem 0}time{white-space:nowrap}' + presentation.css +
    '</style></head><body><main' + presentation.mainAttributes + '><header><h1>' + heading + '</h1><nav>' + links +
    '</nav></header>' + body + pageBrand(presentation) + '</main></body></html>';
}

function anchor(url, label) {
  return '<a href="' + escape(url) + '">' + label + '</a>';
}

function parametersForm(pkg, formUrl, listUrl, token) {
  const presentation = pageAppearance(pkg.appearance);
  const {markup} = presentation;
  const section = presentation.grid ? '<section class="field">' : '<section>';
  const fields = Array.from(pkg.fields, ([ref, field], index) =>
    section + inputHtml(field, ref, 'f' + index, false, undefined, presentation) + '</section>').join('');
  const encoding = pkg.attachment ? ' enctype="multipart/form-data"' : '';
  const body = '<form action="' + escape(formUrl) + '" method="post"' + encoding + '>' +
    '<input type="hidden" name="form_token" value="' + escape(token) + '">' + fields +
    imageAttachmentInput(pkg.attachment,presentation) +
    '<button type="submit">' + markup('保存记录','Save record') + '</button></form>';
  return document(pkg.title, ['参数录入','Data entry'], anchor(listUrl, markup('查看记录列表','View records')), body, presentation);
}

function valueOf(row, ref, field) {
  return own(row.values, ref) ? displayFieldValue(field, row.values[ref]) : '—';
}

function submittedTime(row) {
  return '<time datetime="' + escape(row.submitted_at) + '">' +
    escape(row.submitted_at.slice(0, 19).replace('T', ' ') + ' UTC') + '</time>';
}

function recordsList(pkg, rows, link) {
  const presentation = pageAppearance(pkg.appearance);
  const {markup} = presentation;
  const newRecord = anchor(link('/form'), markup('新增录入','Add record'));
  let content = '<p>' + markup('暂无录入记录。','No records yet.') + '</p>';
  if (rows.length) {
    const headings = pkg.columns.map(ref => '<th scope="col">' + presentation.fieldLabel(ref,pkg.fields.get(ref).label) + '</th>').join('');
    const body = rows.map(row => {
      const cells = pkg.columns.map(ref => '<td>' + escape(valueOf(row, ref, pkg.fields.get(ref))) + '</td>').join('');
      return '<tr><td>' + submittedTime(row) + '</td>' + cells + '<td>' +
        anchor(link('/records/' + row.record_id), markup('查看详情','View details')) + '</td></tr>';
    }).join('');
    content = '<div class="scroll"><table><caption>' + markup('共 ' + rows.length + ' 条记录','Records: ' + rows.length) + '</caption>' +
      '<thead><tr><th scope="col">' + markup('录入时间','Submitted at') + '</th>' + headings +
      '<th scope="col">' + markup('详情','Details') + '</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>';
  }
  return document(pkg.title, ['记录列表','Records'], newRecord, content, presentation);
}

function recordDetail(pkg, row, link) {
  const presentation = pageAppearance(pkg.appearance);
  const {markup} = presentation;
  const fields = Array.from(pkg.fields, ([ref, field]) =>
    '<div><dt>' + presentation.fieldLabel(ref,field.label) + '</dt><dd>' + escape(valueOf(row, ref, field)) + '</dd></div>').join('');
  const attachment = row.attachment ? '<p>' + markup('已保存图片附件：','Image saved: ') + escape(row.attachment.filename) + '</p>' : '';
  const content = '<section><p>' + markup('录入时间','Submitted at') + ' ' + submittedTime(row) +
    '</p><dl>' + fields + '</dl>' + attachment + '</section>';
  return document(pkg.title, ['记录详情','Record details'], anchor(link('/records'), markup('返回列表','Back to records')) +
    anchor(link('/form'), markup('新增录入','Add record')), content, presentation);
}


function readRecord(directory, recordId) {
  try {
    const folder = join(directory, recordId);
    const file = existsSync(folder) ? join(folder, 'record.json') : join(directory, recordId + '.json');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new PageError(404, 'record_not_found');
    throw error;
  }
}

function readRecords(directory) {
  const ids = new Set(readdirSync(directory, {withFileTypes:true})
    .map(entry => entry.isDirectory() ? entry.name : entry.name.endsWith('.json') ? entry.name.slice(0,-5) : '')
    .filter(validPageId));
  return Array.from(ids, id => readRecord(directory, id))
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at) || b.order.localeCompare(a.order) ||
      b.record_id.localeCompare(a.record_id));
}

function inlineRegistry(reference, {label, fields, list_columns, appearance, attachment}) {
  return {
    field_spec_version: '1.0',
    fields: Object.fromEntries(fields.map(({ref, ...field}) => [ref, field])),
    work_packages: {
      [reference]: {label, parameters: fields.map(({ref}) => ref),
        ...(list_columns === undefined ? {} : {list_columns}),
        ...(appearance === undefined ? {} : {appearance}),
        ...(attachment === undefined ? {} : {attachment})}
    }
  };
}

export function createWorkPackagePages(store) {
  const inlineDirectory = join(store.root, 'inline-work-packages');
  const references = new Map();
  for (const ref of Object.keys(store.registry.work_packages ?? {})) {
    if (validReference(ref)) references.set(packageId(store.contextDigest, ref), ref);
  }

  function loadInline(id) {
    try {
      return JSON.parse(readFileSync(join(inlineDirectory, id + '.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function listInline() {
    if (!existsSync(inlineDirectory)) return [];
    return readdirSync(inlineDirectory)
      .filter(file => file.endsWith('.json') && validPageId(file.slice(0, -5)))
      .map(file => loadInline(file.slice(0, -5)))
      .map(({ref, definition}) => ({ref, label: definition.label}));
  }

  function registerInline(id, ref, definition) {
    if (references.has(id)) throw new PageError(409, 'work_package_definition_conflict');
    try {
      validateFieldContract(inlineRegistry(ref, definition));
    } catch {
      throw new PageError(400, 'invalid_work_package_definition');
    }
    mkdirSync(inlineDirectory, directoryMode);
    if (!publishOnce(inlineDirectory, id + '.json', JSON.stringify({ref, definition}))) {
      const {definition: existing} = loadInline(id);
      if (JSON.stringify(canonical(existing)) !== JSON.stringify(canonical(definition))) {
        throw new PageError(409, 'work_package_definition_conflict');
      }
    }
  }

  function prepare(id) {
    store.current();
    const declaredRef = references.get(id);
    const inline = declaredRef === undefined ? loadInline(id) : undefined;
    const ref = declaredRef ?? inline?.ref;
    if (ref === undefined) throw new PageError(404, 'work_package_not_found');
    const metadata = specification(inline ? inlineRegistry(ref, inline.definition) : store.registry, ref);
    const root = join(store.root, 'work-packages', id);
    const directory = inline ? join(root, 'records') :
      join(store.directory, 'work-package-records', recordsKey(store.registry, ref, metadata.fields));
    mkdirSync(root, directoryMode);
    mkdirSync(directory, directoryMode);
    if (!existsSync(join(root, 'secret'))) publishOnce(root, 'secret', randomBytes(32));
    const key = readFileSync(join(root, 'secret'));
    return { ...metadata, id, directory, key, access: hmac(key, 'local-access') };
  }

  function open(ref, definition) {
    const id = packageId(store.contextDigest, ref);
    if (definition !== undefined) {
      store.current();
      registerInline(id, ref, definition);
    }
    const pkg = prepare(id);
    const root = '/w/' + pkg.id;
    return { package_ref: ref, title: pkg.title, form_path: root + '/form',
      list_path: root + '/records', access_key: pkg.access };
  }

  function findRecord(ref, recordId) {
    if (!validPageId(recordId)) throw new PageError(404, 'record_not_found');
    const pkg = prepare(packageId(store.contextDigest, ref));
    return {pkg, row: readRecord(pkg.directory, recordId.toLowerCase())};
  }

  function getRecord(ref, recordId) {
    const {pkg,row} = findRecord(ref, recordId);
    const visible = [];
    for (const [key, field] of pkg.fields) {
      if (own(row.values, key)) visible.push([key, displayFieldValue(field, row.values[key])]);
    }
    return { package_ref: ref, record_id: row.record_id, values: Object.fromEntries(visible),
      ...(row.attachment ? {attachment:row.attachment} : {}) };
  }

  function getAttachment(ref, recordId) {
    const {pkg,row} = findRecord(ref, recordId);
    if (!row.attachment) throw new PageError(404, 'attachment_not_found');
    return {metadata:row.attachment, image:readFileSync(join(pkg.directory, row.record_id, 'attached-image'))};
  }

  async function handle(req, res, {origin, authenticate, readSubmission, headers, csp}) {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new PageError(404, 'not_found');
    const url = new URL(req.url, origin);
    const route = /^\/w\/([a-f0-9-]+)\/(form|records)(?:\/([a-f0-9-]+))?$/.exec(url.pathname);
    if (!route || url.origin !== origin || !validPageId(route[1]) ||
        (route[3] && (route[2] !== 'records' || !validPageId(route[3])))) throw new PageError(404, 'not_found');
    if (req.method !== 'GET' && !(req.method === 'POST' && route[2] === 'form')) throw new PageError(405, 'method_not_allowed');

    if (authenticate) {
      const identity = await authenticate(req);
      if (!identity || !scopeKeys.every(k => identity[k] === store.registry[k]) || url.searchParams.has('k')) {
        throw new PageError(403, 'access_denied');
      }
    }
    const pkg = prepare(route[1]);
    if (!authenticate && (url.searchParams.getAll('k').length !== 1 || !sameSecret(url.searchParams.get('k'), pkg.access))) {
      throw new PageError(403, 'access_denied');
    }

    const audience = authenticate ? 'gateway:' + origin : 'local';
    const link = suffix => '/w/' + pkg.id + suffix + (authenticate ? '' : '?k=' + pkg.access);
    const signature = id => hmac(pkg.key, JSON.stringify(['submission', audience, id]));
    if (req.method === 'POST') {
      if (req.headers.origin !== origin) throw new PageError(403, 'origin_denied');
      const {form,upload} = await readSubmission(req, pkg.attachment, link('/form'), pkg.appearance);
      const token = form.get('form_token') ?? '';
      const [id, sig] = token.split('.');
      if (form.getAll('form_token').length !== 1 || token !== id + '.' + sig ||
          !validPageId(id) || !sameSecret(sig, signature(id))) throw new PageError(403, 'invalid_form');
      const values = validateFormAt(link('/form'), () => parseValues(pkg.fields, form), pkg.appearance);
      store.current();
      const row = { record_id: id, submitted_at: new Date().toISOString(),
        order: process.hrtime.bigint().toString().padStart(24, '0'), values,
        ...(upload ? {attachment:upload.metadata} : {}) };
      const filename = id + '.json';
      const published = pkg.attachment
        ? !existsSync(join(pkg.directory, filename)) && publishDirectory(pkg.directory, id, stage => {
            writeFileSync(join(stage, 'record.json'), JSON.stringify(row), {flag:'wx',mode:0o600});
            if (upload) writeFileSync(join(stage, 'attached-image'), upload.image, {flag:'wx',mode:0o600});
          })
        : !existsSync(join(pkg.directory, id)) && publishOnce(pkg.directory, filename, JSON.stringify(row));
      if (!published) {
        const saved = readRecord(pkg.directory, id);
        if (JSON.stringify(saved.values) !== JSON.stringify(values) ||
            JSON.stringify(saved.attachment) !== JSON.stringify(row.attachment)) {
          throw new PageError(409, 'submission_conflict');
        }
      }
      res.writeHead(303, { ...headers, location: link('/records') });
      res.end();
      return;
    }

    let html;
    if (route[2] === 'form') {
      const id = randomUUID();
      html = parametersForm(pkg, link('/form'), link('/records'), id + '.' + signature(id));
    } else if (route[3]) {
      html = recordDetail(pkg, readRecord(pkg.directory, route[3]), link);
    } else {
      html = recordsList(pkg, readRecords(pkg.directory), link);
    }
    res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp });
    res.end(html);
  }
  return { describe: open, open, getRecord, getAttachment, listInline, matches: pathname => typeof pathname === 'string' && pathname.startsWith('/w/'), handle };
}
