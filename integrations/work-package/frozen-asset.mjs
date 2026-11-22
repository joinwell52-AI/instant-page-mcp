import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function reject(code) {
  throw new Error(code);
}

function relativeJsonPath(path) {
  return nonempty(path) && /\.json$/iu.test(path) &&
    !/[\\:%?#\u0000-\u001f\u007f]/u.test(path) &&
    path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

// manifest, package selection, work selection and digest index come from the authorized host.
// No path from either the caller or the JSON is resolved on the filesystem.
function declaredAssets(manifest, workId, acceptedFormatVersion) {
  if (Object.hasOwn(manifest, 'schema')) {
    if (manifest.schema !== 'codeflowmu.team-workpack/v1' || Object.hasOwn(manifest, 'format_version')) {
      reject('unsupported_manifest_format');
    }
    if (!object(manifest.jobs) || !Object.hasOwn(manifest.jobs, workId) || !object(manifest.jobs[workId])) {
      reject('work_not_declared');
    }
    return manifest.assets;
  }
  if (!nonempty(acceptedFormatVersion) || !Object.hasOwn(manifest, 'format_version') ||
      manifest.format_version !== acceptedFormatVersion || !Array.isArray(manifest.works)) {
    reject('unsupported_manifest_format');
  }
  const entries = manifest.works.filter(item => object(item) && item.id === workId);
  if (entries.length !== 1) reject('work_not_declared_or_ambiguous');
  return entries[0].assets;
}

export function readFrozenPageAsset({
  manifest, packageId, packageVersion, workId, assetPath, assets, hashes, acceptedFormatVersion
}) {
  if (!object(manifest) || !nonempty(packageId) || !nonempty(packageVersion) || !nonempty(workId) ||
      manifest.id !== packageId || manifest.version !== packageVersion) reject('package_selection_mismatch');
  if (!relativeJsonPath(assetPath)) reject('invalid_relative_json_path');
  const paths = declaredAssets(manifest, workId, acceptedFormatVersion);
  if (!Array.isArray(paths) || !paths.includes(assetPath)) reject('asset_not_declared');

  const bytes = assets instanceof Map ? assets.get(assetPath) : undefined;
  if (!(bytes instanceof Uint8Array)) reject('no_frozen_asset_bytes');
  const digest = hashes instanceof Map ? hashes.get(assetPath) :
    object(hashes) && Object.hasOwn(hashes, assetPath) ? hashes[assetPath] : undefined;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/iu.test(digest)) reject('missing_frozen_digest');
  const snapshot = Buffer.from(bytes);
  if (createHash('sha256').update(snapshot).digest('hex') !== digest.toLowerCase()) reject('frozen_digest_mismatch');

  let descriptor;
  try {
    descriptor = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(snapshot));
  } catch {
    reject('invalid_page_asset_json');
  }
  if (!object(descriptor) || descriptor.package_id !== packageId ||
      descriptor.package_version !== packageVersion || descriptor.work_id !== workId) {
    reject('page_asset_identity_mismatch');
  }
  return descriptor;
}
