// Field values and individual rule parameters are checked by the same code that
// renders and accepts form submissions. The versioned envelope also rejects
// misspelled rules and references before the service begins accepting requests.
import { fieldDefinition } from './render.mjs';
import { isObject, validReference } from './schema.mjs';

const fieldKeys = new Set([
  'type', 'label', 'required', 'format', 'min_length', 'max_length',
  'min', 'max', 'integer', 'options'
]);
const packageKeys = new Set(['label', 'parameters', 'list_columns']);

function invalid(reason) {
  throw new Error(reason);
}

function allKnownKeys(object, allowed) {
  return Object.keys(object).every(key => allowed.has(key));
}

function validateRefs(list, available, reason) {
  if (!Array.isArray(list) || list.length === 0 || new Set(list).size !== list.length ||
      !list.every(ref => validReference(ref) && available.has(ref))) invalid(reason);
}

export function validateFieldContract(catalog) {
  if (!Object.hasOwn(catalog, 'field_spec_version')) return;
  if (catalog.field_spec_version !== '1.0') invalid('unsupported_field_spec_version');
  if (!isObject(catalog.fields) || !isObject(catalog.work_packages)) invalid('invalid_field_catalog');

  const available = new Set(Object.keys(catalog.fields));
  for (const ref of available) {
    if (!validReference(ref)) invalid('invalid_field_reference');
    const field = fieldDefinition(catalog, ref);
    if (!allKnownKeys(field, fieldKeys) || (Object.hasOwn(field, 'options') && field.type !== 'select')) {
      invalid('unsupported_field_rule');
    }
  }
  for (const [ref, pkg] of Object.entries(catalog.work_packages)) {
    if (!validReference(ref) || !isObject(pkg) || typeof pkg.label !== 'string' || !pkg.label.trim() ||
        !allKnownKeys(pkg, packageKeys)) invalid('invalid_package_definition');
    validateRefs(pkg.parameters, available, 'invalid_package_parameters');
    if (Object.hasOwn(pkg, 'list_columns')) {
      validateRefs(pkg.list_columns, new Set(pkg.parameters), 'invalid_package_list_columns');
    }
  }
}
