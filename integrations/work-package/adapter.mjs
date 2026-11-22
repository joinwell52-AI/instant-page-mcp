import { isObject, validPageId, validPageSpecification, validReference } from '../../src/schema.mjs';

function reject(code) {
  throw Object.assign(new Error(code), {code});
}

function objectShape(value, required, optional = []) {
  return isObject(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function validVersion(version) {
  // Version identity is opaque. Resolve moving aliases to an installed revision in the host.
  return typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version) &&
    !['latest','current','*'].includes(version.toLowerCase());
}

function checkManifest(manifest, expected) {
  if (!objectShape(manifest, ['contract_version','package_id','package_version','work_id'], ['views']) ||
      !validReference(manifest.package_id) || !validVersion(manifest.package_version) || !validReference(manifest.work_id)) reject('invalid_manifest');
  if (manifest.contract_version !== '1.0') reject('unsupported_contract_version');
  if (!objectShape(expected, ['package_id','package_version','work_id']) ||
      manifest.package_id !== expected.package_id || manifest.package_version !== expected.package_version ||
      manifest.work_id !== expected.work_id) {
    reject('package_version_mismatch');
  }
  const views = Object.hasOwn(manifest, 'views') ? manifest.views : {};
  if (!isObject(views)) reject('invalid_manifest');
  for (const [key, view] of Object.entries(views)) {
    if (!validReference(key) || !isObject(view) || !Object.hasOwn(view,'kind')) reject('invalid_manifest');
    if (view.kind === 'interaction') {
      if (!objectShape(view, ['kind','specification']) || !validPageSpecification(view.specification)) reject('invalid_manifest');
    } else if (!['form','list'].includes(view.kind) || !objectShape(view, ['kind','collection_ref']) ||
        !validReference(view.collection_ref)) {
      reject('invalid_manifest');
    }
  }
  return views;
}

function chooseView(views, viewKey, fallback, defaultCollectionRef) {
  if (viewKey !== undefined) {
    if (!validReference(viewKey) || !Object.hasOwn(views, viewKey)) reject('unknown_view');
    return views[viewKey];
  }
  if (!['form','list'].includes(fallback)) reject('view_required');
  if (!validReference(defaultCollectionRef)) reject('missing_default_collection');
  return {kind:fallback, collection_ref:defaultCollectionRef};
}

function trustedOrigin(configured) {
  if (configured === undefined) return undefined;
  if (typeof configured !== 'string') reject('invalid_published_origin');
  let url;
  try { url = new URL(configured); } catch { reject('invalid_published_origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== configured) {
    reject('invalid_published_origin');
  }
  return url.origin;
}

function checkedUrl(value, kind, pageId, publishedOrigin) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\\]/u.test(value)) reject('invalid_mcp_response');
  let url;
  try { url = new URL(value); } catch { reject('invalid_mcp_response'); }
  if (url.username || url.password || url.hash || url.href !== value) reject('invalid_mcp_response');
  const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (local) {
    if (!/^\?k=[A-Za-z0-9_-]{43}$/.test(url.search)) reject('invalid_mcp_response');
  } else if (url.protocol !== 'https:' || url.origin !== publishedOrigin || url.search) {
    reject('invalid_mcp_response');
  }
  const parts = url.pathname.split('/');
  if (kind === 'interaction') {
    if (parts.length !== 3 || parts[1] !== 'p' || parts[2] !== pageId) reject('invalid_mcp_response');
  } else if (parts.length !== 4 || parts[1] !== 'w' || !validPageId(parts[2]) ||
      parts[3] !== (kind === 'form' ? 'form' : 'records')) reject('invalid_mcp_response');
  return url.href;
}

async function invoke(callTool, name, args) {
  let result;
  try { result = await callTool({name, arguments:args}); }
  catch { reject('mcp_transport_error'); }
  if (!isObject(result) || (result.isError !== undefined && typeof result.isError !== 'boolean')) {
    reject('invalid_mcp_response');
  }
  if (result.isError) reject('mcp_error');
  if (!isObject(result.structuredContent)) reject('invalid_mcp_response');
  return result.structuredContent;
}

// The host supplies the approved manifest, pinned identity, scoped MCP connection, and retry ID.
// Neither a package path nor an arbitrary callable tool can be supplied through the manifest.
export async function openPackageView({manifest, expectedPackage, viewKey, fallback,
  requestId, defaultCollectionRef, publishedOrigin, callTool}) {
  if (typeof callTool !== 'function') reject('mcp_client_required');
  const allowedOrigin = trustedOrigin(publishedOrigin);
  const views = checkManifest(manifest, expectedPackage);
  const view = chooseView(views, viewKey, fallback, defaultCollectionRef);
  const receipt = {package_id:manifest.package_id, package_version:manifest.package_version,
    work_id:manifest.work_id, view_key:viewKey ?? null, kind:view.kind};

  if (view.kind === 'interaction') {
    if (!validPageId(requestId)) reject('invalid_request_id');
    const result = await invoke(callTool, 'generate_interaction_page',
      {request_id:requestId, specification:view.specification});
    if (!validPageId(result.page_id)) reject('invalid_mcp_response');
    return {...receipt, page_id:result.page_id, url:checkedUrl(result.url, view.kind, result.page_id, allowedOrigin)};
  }

  const result = await invoke(callTool, 'open_work_package', {package_ref:view.collection_ref});
  if (result.package_ref !== view.collection_ref) reject('invalid_mcp_response');
  const url = checkedUrl(view.kind === 'form' ? result.form_url : result.list_url, view.kind, undefined, allowedOrigin);
  return {...receipt, collection_ref:view.collection_ref, url};
}
