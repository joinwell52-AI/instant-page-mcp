import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFrozenPageAsset } from './frozen-asset.mjs';

const assetPath = 'assets/pages/intake.json';
const expected = {
  contract_version:'1.0', package_id:'vehicle-maintenance', package_version:'1.0.1', work_id:'models',
  views:{}
};
const data = Buffer.from(JSON.stringify(expected));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const assets = new Map([[assetPath, data]]);
const hashes = { [assetPath]:sha256(data) };
const selection = { packageId:'vehicle-maintenance', packageVersion:'1.0.1', workId:'models', assetPath, assets, hashes };
const roles = {'PM-01':'pm.md','OPS-01':'ops.md','DEV-01':'dev.md','QA-01':'qa.md'};
const existingManifest = {
  schema:'codeflowmu.team-workpack/v1', id:selection.packageId, version:selection.packageVersion,
  assets:[assetPath], jobs:{models:{root:'root.md',plan:'models.md',roles},brands:{root:'root.md',plan:'brands.md',roles}}
};
const draftManifest = {
  format_version:'host-accepted-example', id:selection.packageId, version:selection.packageVersion, name:'示例',
  works:[
    {id:'models',name:'车型检查',template:'templates/models.md',assets:[assetPath]},
    {id:'brands',name:'品牌检查',template:'templates/brands.md',assets:[]}
  ]
};
const read = changes => readFrozenPageAsset({...selection, manifest:existingManifest, ...changes});

test('已安装清单可从已冻结的包级 assets 读取当前工作的页面资源', () => {
  assert.deepEqual(read({}), expected);
  assert.deepEqual(read({hashes:new Map(Object.entries(hashes))}), expected);
  assert.throws(() => read({workId:'brands'}), /page_asset_identity_mismatch/);
  assert.throws(() => read({workId:'unknown'}), /work_not_declared/);
  assert.throws(() => read({manifest:{...existingManifest,assets:[]}}), /asset_not_declared/);
});

test('评审稿清单按指定工作的 assets 和宿主批准的格式版本解析', () => {
  const approved = { manifest:draftManifest, acceptedFormatVersion:draftManifest.format_version };
  assert.deepEqual(read(approved), expected);
  assert.throws(() => read({manifest:draftManifest}), /unsupported_manifest_format/);
  assert.throws(() => read({...approved,acceptedFormatVersion:'other'}), /unsupported_manifest_format/);
  assert.throws(() => read({...approved,workId:'brands'}), /asset_not_declared/);
  assert.throws(() => read({...approved,manifest:{...draftManifest,works:[...draftManifest.works,draftManifest.works[0]]}}),
    /ambiguous/);
});

test('包身份、冻结摘要、受信字节和相对路径分别校验', () => {
  assert.throws(() => read({packageId:'another'}), /package_selection_mismatch/);
  assert.throws(() => read({packageVersion:'2.0.0'}), /package_selection_mismatch/);
  assert.throws(() => read({workId:'__proto__'}), /work_not_declared/);
  assert.throws(() => read({hashes:{}}), /missing_frozen_digest/);
  assert.throws(() => read({hashes:{[assetPath]:'0'.repeat(64)}}), /frozen_digest_mismatch/);
  assert.throws(() => read({assets:new Map()}), /no_frozen_asset_bytes/);
  for (const bad of ['/tmp/x.json','../x.json','file:///tmp/x.json','https://example.org/x.json','C:/x.json','dir/%2e%2e/x.json','x.md']) {
    assert.throws(() => read({assetPath:bad}), /invalid_relative_json_path/);
  }
  for (const changed of [{...expected,package_version:'9.9.9'}, {...expected,package_id:'other'}]) {
    const bytes = Buffer.from(JSON.stringify(changed));
    assert.throws(() => read({assets:new Map([[assetPath,bytes]]),hashes:{[assetPath]:sha256(bytes)}}),
      /page_asset_identity_mismatch/);
  }
  const badUtf8 = Buffer.from([123,34,0xff,34,58,49,125]);
  assert.throws(() => read({assets:new Map([[assetPath,badUtf8]]), hashes:{[assetPath]:sha256(badUtf8)}}),
    /invalid_page_asset_json/);
});
