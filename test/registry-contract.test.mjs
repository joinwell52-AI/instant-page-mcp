import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFieldContract } from '../src/field-contract.mjs';
import { PageStore } from '../src/store.mjs';

const example = JSON.parse(readFileSync(new URL('../examples/contact-intake-context.json', import.meta.url)));
const copy = () => structuredClone(example);

test('字段规范 1.0 可作为便携目录或宿主目录；旧目录保持兼容', () => {
  const {field_spec_version, fields, work_packages} = example;
  assert.doesNotThrow(() => validateFieldContract({field_spec_version, fields, work_packages}));
  assert.doesNotThrow(() => validateFieldContract({...example, host_extension: {}}));
  assert.doesNotThrow(() => validateFieldContract({fields: {legacy: {custom_property: true}}}));
});

test('加载时拒绝未知规则、字段交叉和不成立的业务引用', () => {
  const changes = [
    c => { c.field_spec_version = 1; },
    c => { delete c.work_packages; },
    c => { c.work_packages = []; },
    c => { c.fields['a/b'] = {type:'text', label:'无效引用'}; },
    c => { c.fields.mobile.mandatory = true; },
    c => { c.fields.mobile.options = ['A']; },
    c => { c.fields.mobile.max_length = 11; },
    c => { c.fields.resident_id.format = 'unregistered'; },
    c => { c.fields.headcount.max = 0; },
    c => { c.fields.appointment_date.min = '2025-02-29'; },
    c => { c.work_packages['contact-intake'].parameters = ['mobile', 'mobile']; },
    c => { c.work_packages['contact-intake'].parameters = ['missing']; },
    c => { c.work_packages['contact-intake'].list_columns = []; },
    c => { c.work_packages['contact-intake'].list_colums = ['headcount']; },
    c => { c.work_packages['contact-intake'].parameters = ['headcount']; },
    c => { c.work_packages['contact-intake'].parameters = ['toString']; }
  ];
  for (const change of changes) {
    const input = copy();
    change(input);
    assert.throws(() => validateFieldContract(input));
  }
});

test('真实存储入口在新建和每次重读配置时核验字段合同版本', t => {
  const directory = mkdtempSync(join(tmpdir(), 'field-registry-'));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const contextFile = join(directory, 'context.json');
  const config = {directory, contextFile, capability: 'synthetic-test-capability'};
  const update = value => writeFileSync(contextFile, JSON.stringify(value));
  update(example);
  const store = new PageStore(config);
  assert.doesNotThrow(() => store.current());
  update({...example, field_spec_version: '2.0'});
  assert.throws(() => store.current());
  assert.throws(() => new PageStore(config), /unsupported_field_spec_version/);
});
