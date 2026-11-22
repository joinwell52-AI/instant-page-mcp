export class UnknownReference extends Error {}
export class AnswerError extends Error {
  constructor(message, code = 'invalid_answer') {
    super(message);
    this.code = code;
  }
}

const fieldTypes = new Set(['text', 'textarea', 'number', 'date', 'select']);
const canonicalLengths = new Map([['cn_resident_id', 18], ['cn_mobile', 14]]);
const idWeights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const idRemainders = '10X98765432';
const cnMobile = /^(?:\+86[ -]?)?(1[3-9][0-9])[ -]?([0-9]{4})[ -]?([0-9]{4})$/;
const decimal = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;
const invalidTextControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

const textType = type => type === 'text' || type === 'textarea';

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}

export function validateFieldDefinition(field) {
  if (field === null || typeof field !== 'object' || Array.isArray(field) ||
      typeof field.label !== 'string' || !field.label.trim()) {
    throw new UnknownReference('字段缺少有效标签。');
  }
  if (!fieldTypes.has(field.type) || (field.required !== undefined && typeof field.required !== 'boolean')) {
    throw new UnknownReference('字段类型或必填设置无效。');
  }
  if (field.format !== undefined && (field.type !== 'text' || !canonicalLengths.has(field.format))) {
    throw new UnknownReference('字段语义格式无效。');
  }
  if (field.type === 'select') {
    const choices = field.options;
    if (!Array.isArray(choices) || !choices.length || choices.some(option =>
      typeof option !== 'string' || !option.trim() || option !== option.trim()) || new Set(choices).size !== choices.length) {
      throw new UnknownReference('字段选项无效。');
    }
  }
  if (field.min !== undefined || field.max !== undefined) {
    const validLimit = field.type === 'date' ? isCalendarDate : Number.isFinite;
    if ((field.type !== 'number' && field.type !== 'date') ||
        (field.min !== undefined && !validLimit(field.min)) ||
        (field.max !== undefined && !validLimit(field.max)) ||
        (field.min !== undefined && field.max !== undefined && field.min > field.max)) {
      throw new UnknownReference('字段范围无效。');
    }
  }
  if (field.integer !== undefined && (field.type !== 'number' || typeof field.integer !== 'boolean')) {
    throw new UnknownReference('整数设置无效。');
  }
  if (field.min_length !== undefined || field.max_length !== undefined) {
    const min = field.min_length === undefined ? 0 : field.min_length;
    const max = field.max_length === undefined ? 2000 : field.max_length;
    const canonical = canonicalLengths.get(field.format);
    if (!textType(field.type) || !Number.isInteger(min) || !Number.isInteger(max) ||
        min < 0 || max < 1 || max > 10000 || min > max ||
        (canonical !== undefined && (canonical < min || canonical > max))) {
      throw new UnknownReference('字段长度范围与类型或规范值不匹配。');
    }
  }
  return field;
}

function normalizeResidentId(value) {
  if (!/^[1-9][0-9]{16}[0-9Xx]$/.test(value)) {
    throw new AnswerError('请输入 18 位公民身份号码，末位可以是 X。', 'id_shape');
  }
  const birth = value.slice(6, 10) + '-' + value.slice(10, 12) + '-' + value.slice(12, 14);
  // Mainland China civil dates use UTC+08:00. The workstation may run in a different zone.
  const todayInChina = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (!isCalendarDate(birth) || birth > todayInChina) {
    throw new AnswerError('身份号码中的出生日期无效。', 'id_birth_date');
  }
  const result = value.toUpperCase();
  const sum = idWeights.reduce((total, weight, i) => total + weight * Number(result[i]), 0);
  if (idRemainders[sum % 11] !== result[17]) {
    throw new AnswerError('身份号码校验位不匹配。', 'id_checksum');
  }
  return result;
}

function normalizeMobile(value) {
  const parts = cnMobile.exec(value);
  if (!parts) throw new AnswerError('请输入 11 位中国大陆手机号码，可以带 +86。', 'phone_format');
  return '+86' + parts[1] + parts[2] + parts[3];
}

// Check the submitted decimal itself. IEEE-754 rounding can make non-integers look integral.
function integralDecimal(raw) {
  const [mantissa, suffix] = raw.toLowerCase().replace(/^-/, '').split('e');
  const fraction = mantissa.split('.')[1] ?? '';
  const digits = mantissa.replace('.', '');
  if (!/[1-9]/.test(digits)) return true;
  const fractionalPlaces = fraction.length - Number(suffix ?? 0);
  if (fractionalPlaces <= 0) return true;
  return fractionalPlaces <= digits.length && !/[1-9]/.test(digits.slice(-fractionalPlaces));
}

export function normalizeFieldInput(field, raw) {
  if (raw !== undefined && typeof raw !== 'string') throw new AnswerError('输入须为表单文本。', 'invalid_type');
  const value = raw?.trim();
  if (value === undefined || value === '') {
    if (field.required) throw new AnswerError('请填写必填字段。', 'required');
    return undefined;
  }
  if (field.format === 'cn_resident_id') return normalizeResidentId(value);
  if (field.format === 'cn_mobile') return normalizeMobile(value);
  if (textType(field.type)) {
    if (invalidTextControls.test(value) || (field.type === 'text' && /[\r\n]/u.test(value))) {
      throw new AnswerError('文字格式无效。', 'text_format');
    }
    if (value.length < (field.min_length ?? 0) || value.length > (field.max_length ?? 2000)) {
      throw new AnswerError('文字长度不在允许范围。', 'text_length');
    }
  }
  if (field.type === 'select' && !field.options.includes(value)) {
    throw new AnswerError('选项已失效。', 'invalid_choice');
  }
  if (field.type === 'number') {
    if (!decimal.test(value)) throw new AnswerError('请输入有效的数值。', 'number_format');
    const number = Number(value);
    if (!Number.isFinite(number) || (field.integer && (!Number.isSafeInteger(number) || !integralDecimal(value))) ||
        number < (field.min ?? -Infinity) || number > (field.max ?? Infinity)) {
      throw new AnswerError('数值不在允许范围。', 'number_range');
    }
    return number;
  }
  if (field.type === 'date') {
    if (!isCalendarDate(value)) throw new AnswerError('日期无效。', 'date_format');
    if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
      throw new AnswerError('日期不在允许范围。', 'date_range');
    }
  }
  return value;
}

// Keep user data out of error objects. The reference and label come from the verified declaration.
export function readSubmittedField(ref, field, raw) {
  try {
    return normalizeFieldInput(field, raw);
  } catch (error) {
    if (error instanceof AnswerError) {
      error.fieldRef = ref;
      error.fieldLabel = field.label;
    }
    throw error;
  }
}

export function validateFormAt(formUrl, validate) {
  try {
    return validate();
  } catch (error) {
    if (error instanceof AnswerError) error.formUrl = formUrl;
    throw error;
  }
}

export function isSensitiveField(field) {
  return canonicalLengths.has(field?.format);
}

// Mask on the server so hidden full values never appear in the HTML or output JSON.
export function displayFieldValue(field, value) {
  if (!isSensitiveField(field) || value == null || value === '') return value;
  if (typeof value !== 'string') return '****';
  if (field.format === 'cn_mobile' && /^\+861[3-9][0-9]{9}$/.test(value)) {
    return value.slice(0, 6) + '****' + value.slice(-4);
  }
  if (field.format === 'cn_resident_id' && /^[1-9][0-9]{16}[0-9X]$/.test(value)) {
    return value.slice(0, 3) + '*'.repeat(12) + value.slice(-3);
  }
  return '****';
}
