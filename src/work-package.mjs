import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { displayFieldValue, isSensitiveField, readSubmittedField, validateFormAt } from './field-rules.mjs';
import { AnswerError, escape, fieldDefinition, inputHtml, styles } from './render.mjs';
import { isObject, validPageId, validReference } from './schema.mjs';
import { PageError, scopeKeys } from './store.mjs';

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
  return { title: definition.label, fields, columns };
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

function document(title, heading, links, body) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) +
    '</title><style>' + styles + ' nav{display:flex;gap:1.1rem;margin-top:.8rem}' +
    ' a{color:#235e49}caption{text-align:left;padding:.7rem 0}time{white-space:nowrap}' +
    '</style></head><body><main><header><h1>' + escape(heading) + '</h1><nav>' + links +
    '</nav></header>' + body + '</main></body></html>';
}

function anchor(url, label) {
  return '<a href="' + escape(url) + '">' + escape(label) + '</a>';
}

function parametersForm(pkg, formUrl, listUrl, token) {
  const fields = Array.from(pkg.fields, ([ref, field], index) =>
    '<section>' + inputHtml(field, ref, 'f' + index, false) + '</section>').join('');
  const body = '<form action="' + escape(formUrl) + '" method="post">' +
    '<input type="hidden" name="form_token" value="' + escape(token) + '">' + fields +
    '<button type="submit">保存记录</button></form>';
  return document(pkg.title + ' · 参数录入', pkg.title + ' · 参数录入', anchor(listUrl, '查看记录列表'), body);
}

function valueOf(row, ref, field) {
  return own(row.values, ref) ? displayFieldValue(field, row.values[ref]) : '—';
}

function submittedTime(row) {
  return '<time datetime="' + escape(row.submitted_at) + '">' +
    escape(row.submitted_at.slice(0, 19).replace('T', ' ') + ' UTC') + '</time>';
}

function recordsList(pkg, rows, link) {
  const newRecord = anchor(link('/form'), '新增录入');
  let content = '<p>暂无录入记录。</p>';
  if (rows.length) {
    const headings = pkg.columns.map(ref => '<th scope="col">' + escape(pkg.fields.get(ref).label) + '</th>').join('');
    const body = rows.map(row => {
      const cells = pkg.columns.map(ref => '<td>' + escape(valueOf(row, ref, pkg.fields.get(ref))) + '</td>').join('');
      return '<tr><td>' + submittedTime(row) + '</td>' + cells + '<td>' +
        anchor(link('/records/' + row.record_id), '查看详情') + '</td></tr>';
    }).join('');
    content = '<div class="scroll"><table><caption>共 ' + rows.length + ' 条记录</caption>' +
      '<thead><tr><th scope="col">录入时间</th>' + headings + '<th scope="col">详情</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>';
  }
  return document(pkg.title + ' · 记录列表', pkg.title + ' · 记录列表', newRecord, content);
}

function recordDetail(pkg, row, link) {
  const fields = Array.from(pkg.fields, ([ref, field]) =>
    '<div><dt>' + escape(field.label) + '</dt><dd>' + escape(valueOf(row, ref, field)) + '</dd></div>').join('');
  const content = '<section><p>录入时间 ' + submittedTime(row) + '</p><dl>' + fields + '</dl></section>';
  return document(pkg.title + ' · 记录详情', pkg.title + ' · 记录详情',
    anchor(link('/records'), '返回列表') + anchor(link('/form'), '新增录入'), content);
}

function readRecord(directory, recordId) {
  try {
    return JSON.parse(readFileSync(join(directory, recordId + '.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new PageError(404, 'record_not_found');
    throw error;
  }
}

function readRecords(directory) {
  return readdirSync(directory)
    .filter(name => name.endsWith('.json') && validPageId(name.slice(0, -5)))
    .map(name => readRecord(directory, name.slice(0, -5)))
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at) || b.order.localeCompare(a.order) ||
      b.record_id.localeCompare(a.record_id));
}

export function createWorkPackagePages(store) {
  const references = new Map();
  for (const ref of Object.keys(store.registry.work_packages ?? {})) {
    if (validReference(ref)) references.set(packageId(store.contextDigest, ref), ref);
  }

  function prepare(ref) {
    store.current();
    const metadata = specification(store.registry, ref);
    const id = packageId(store.contextDigest, ref);
    const root = join(store.root, 'work-packages', id);
    const directory = join(store.directory, 'work-package-records', recordsKey(store.registry, ref, metadata.fields));
    mkdirSync(root, directoryMode);
    mkdirSync(directory, directoryMode);
    if (!existsSync(join(root, 'secret'))) publishOnce(root, 'secret', randomBytes(32));
    const key = readFileSync(join(root, 'secret'));
    return { ...metadata, id, directory, key, access: hmac(key, 'local-access') };
  }

  function open(ref) {
    const pkg = prepare(ref);
    const root = '/w/' + pkg.id;
    return { package_ref: ref, title: pkg.title, form_path: root + '/form',
      list_path: root + '/records', access_key: pkg.access };
  }

  function getRecord(ref, recordId) {
    if (!validPageId(recordId)) throw new PageError(404, 'record_not_found');
    const pkg = prepare(ref);
    const row = readRecord(pkg.directory, recordId.toLowerCase());
    const visible = [];
    for (const [key, field] of pkg.fields) {
      if (own(row.values, key)) visible.push([key, displayFieldValue(field, row.values[key])]);
    }
    return { package_ref: ref, record_id: row.record_id, values: Object.fromEntries(visible) };
  }

  async function handle(req, res, {origin, authenticate, readBody, headers, csp}) {
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
    const ref = references.get(route[1]);
    if (!ref) throw new PageError(404, 'work_package_not_found');
    const pkg = prepare(ref);
    if (!authenticate && (url.searchParams.getAll('k').length !== 1 || !sameSecret(url.searchParams.get('k'), pkg.access))) {
      throw new PageError(403, 'access_denied');
    }

    const audience = authenticate ? 'gateway:' + origin : 'local';
    const link = suffix => '/w/' + pkg.id + suffix + (authenticate ? '' : '?k=' + pkg.access);
    const signature = id => hmac(pkg.key, JSON.stringify(['submission', audience, id]));
    if (req.method === 'POST') {
      if (req.headers.origin !== origin) throw new PageError(403, 'origin_denied');
      const form = new URLSearchParams(await readBody(req, 'application/x-www-form-urlencoded'));
      const token = form.get('form_token') ?? '';
      const [id, sig] = token.split('.');
      if (form.getAll('form_token').length !== 1 || token !== id + '.' + sig ||
          !validPageId(id) || !sameSecret(sig, signature(id))) throw new PageError(403, 'invalid_form');
      const values = validateFormAt(link('/form'), () => parseValues(pkg.fields, form));
      store.current();
      const row = { record_id: id, submitted_at: new Date().toISOString(),
        order: process.hrtime.bigint().toString().padStart(24, '0'), values };
      if (!publishOnce(pkg.directory, id + '.json', JSON.stringify(row))) {
        const saved = readRecord(pkg.directory, id);
        if (JSON.stringify(saved.values) !== JSON.stringify(values)) throw new PageError(409, 'submission_conflict');
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
  return { describe: open, open, getRecord, matches: pathname => typeof pathname === 'string' && pathname.startsWith('/w/'), handle };
}
