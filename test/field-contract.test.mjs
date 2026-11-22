import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AnswerError, UnknownReference, validateFieldDefinition, normalizeFieldInput,
  displayFieldValue, isCalendarDate
} from '../src/field-rules.mjs';
import { inputHtml } from '../src/render.mjs';

const field = (type, rules = {}) => validateFieldDefinition({ label: '测试字段', type, ...rules });
const valid = (f, raw) => normalizeFieldInput(f, raw);
const reject = (f, raw, code) => assert.throws(
  () => normalizeFieldInput(f, raw), error => error instanceof AnswerError && error.code === code
);

test('字符串长度采用 UTF-16 单元；规则组合、可选和必填边界明确', () => {
  const title = field('text', { min_length: 2, max_length: 3 });
  assert.equal(valid(title, '  车站  '), '车站');
  assert.equal(valid(title, '🌿绿'), '🌿绿');
  reject(title, '车', 'text_length');
  reject(title, '🌿🌿', 'text_length');
  reject(title, 'a\nb', 'text_format');
  assert.equal(valid(field('textarea'), '甲\n乙'), '甲\n乙');
  assert.equal(valid(title, '  '), undefined);
  reject(field('text', { required: true }), '  ', 'required');
  assert.equal(valid(field('text', { min_length: 10000, max_length: 10000 }), 'x'.repeat(10000)).length, 10000);
  for (const definition of [
    { type: 'text', min_length: 2001 },
    { type: 'textarea', min_length: -1 },
    { type: 'text', max_length: 10001 },
    { type: 'text', max_length: 0 },
    { type: 'number', max_length: 20 },
    { type: 'select', options: ['重复', '重复'] },
    { type: 'number', format: 'cn_resident_id' },
    { type: 'text', format: 'unknown' },
    { type: 'text', format: 'cn_mobile', max_length: 11 },
    { type: 'text', format: 'cn_resident_id', min_length: 19 }
  ]) assert.throws(() => field(definition.type, definition), UnknownReference);
});

test('日期使用真实公历日和包含式最小最大值；数字按安全整数及包含范围校验', () => {
  assert.equal(isCalendarDate('0001-01-01'), true);
  assert.equal(isCalendarDate('0000-01-01'), false);
  const interval = field('date', { min: '2024-02-29', max: '2024-03-01' });
  assert.equal(valid(interval, '2024-02-29'), '2024-02-29');
  assert.equal(valid(interval, '2024-03-01'), '2024-03-01');
  reject(interval, '2023-02-29', 'date_format');
  reject(interval, '2024-03-02', 'date_range');
  assert.throws(() => field('date', { min: '2026-02-29' }), UnknownReference);
  assert.throws(() => field('date', { min: '2024-06-01', max: '2024-05-01' }), UnknownReference);
  assert.match(inputHtml(interval, 'arrival', 'f1', false), / min="2024-02-29" max="2024-03-01"/);
  const count = field('number', { integer: true, min: 0, max: 10 });
  for (const raw of ['0', '10', '1.00e1', '1e0']) assert.equal(valid(count, raw), Number(raw));
  for (const raw of ['11', '1.01', '1.00000000000000001', '1e-1000']) reject(count, raw, 'number_range');
  reject(count, 'Infinity', 'number_format');
  reject(field('number', { integer: true }), '9007199254740992', 'number_range');
});

test('中国大陆手机号码按 3-4-4 录入并统一 +86，输出和回执服务端遮盖', () => {
  const mobile = field('text', { format: 'cn_mobile', min_length: 14, max_length: 14 });
  const canonical = '+8613800000000';
  for (const raw of ['13800000000', '138-0000-0000', '+86 138 0000 0000', '+86-138-0000-0000']) {
    assert.equal(valid(mobile, raw), canonical);
  }
  for (const raw of ['12800000000', '+1 13800000000', '138 00 000000', '1380000000', '１３８００００００００']) {
    reject(mobile, raw, 'phone_format');
  }
  assert.match(inputHtml(mobile, 'phone', 'f1', false), /type="tel" inputmode="tel"/);
  const locked = inputHtml(mobile, 'phone', 'f1', true, canonical);
  assert.ok(locked.includes('+86138****0000'));
  assert.ok(!locked.includes(canonical));
  assert.equal(displayFieldValue(mobile, 'invalid legacy content'), '****');
});

test('公民身份号码处理小写 x、校验位、出生日期及结构；回执不暴露中间位', () => {
  const id = field('text', { format: 'cn_resident_id' });
  // This check-digit example is printed in GB 11643-1999, Annex B.
  const sample = '440524188001010014';
  assert.equal(valid(id, sample), sample);
  // Fictional address prefix outside the administration table: testing structure only.
  const artificialWithX = '99000020000101008X';
  assert.equal(valid(id, artificialWithX.toLowerCase()), artificialWithX);
  reject(id, sample.slice(0, 17)+'8', 'id_checksum');
  reject(id, '990000202502300000', 'id_birth_date');
  reject(id, '990000999912310000', 'id_birth_date');
  reject(id, '000000200001010000', 'id_shape');
  reject(id, '123456789012345', 'id_shape');
  const locked = inputHtml(id, 'resident', 'f2', true, artificialWithX);
  assert.ok(locked.includes('990************08X'));
  assert.ok(!locked.includes(artificialWithX));
  assert.equal(displayFieldValue(id, 12345), '****');
});
