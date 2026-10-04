'use strict';
/**
 * Compact JSON Schema validator (draft-07 / OpenAPI 3 subset):
 * type (incl. nullable), required, properties, additionalProperties, items,
 * enum, const, minLength, maxLength, pattern, format, minimum, maximum,
 * minItems, maxItems, allOf, anyOf, oneOf, not, $ref (local '#/...').
 */
const FORMATS = {
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  'date-time': (s) => !Number.isNaN(Date.parse(s)) && /\d{4}-\d{2}-\d{2}T/.test(s),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s),
  uri: (s) => { try { new URL(s); return true; } catch { return false; } },
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  'salesforce-id': (s) => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(s),
};

function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`Only local $ref supported (got ${ref})`);
  return ref.slice(2).split('/').reduce((o, k) => (o ? o[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), root);
}

function validate(schema, data, root = schema, path = '$', errors = [], depth = 0) {
  if (!schema || depth > 50) return errors;
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root);
    if (!target) { errors.push({ path, rule: '$ref', message: `Unresolvable $ref ${schema.$ref}` }); return errors; }
    return validate(target, data, root, path, errors, depth + 1);
  }
  const t = jsonType(data);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((ty) => ty === t || (ty === 'number' && t === 'integer')) || (data === null && schema.nullable);
    if (!ok) {
      errors.push({ path, rule: 'type', message: `Expected ${types.join('|')}${schema.nullable ? '|null' : ''}, got ${t}`, expected: types.join('|'), actual: t });
      return errors;
    }
  }
  if (data === null) return errors;
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(data))) {
    errors.push({ path, rule: 'enum', message: `Value ${JSON.stringify(data)} not in enum [${schema.enum.join(', ')}]` });
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(data)) {
    errors.push({ path, rule: 'const', message: `Expected constant ${JSON.stringify(schema.const)}` });
  }
  if (t === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) errors.push({ path, rule: 'minLength', message: `Length ${data.length} < minLength ${schema.minLength}` });
    if (schema.maxLength !== undefined && data.length > schema.maxLength) errors.push({ path, rule: 'maxLength', message: `Length ${data.length} > maxLength ${schema.maxLength}` });
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push({ path, rule: 'pattern', message: `Does not match pattern ${schema.pattern}` });
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](data)) errors.push({ path, rule: 'format', message: `Not a valid ${schema.format}` });
  }
  if (t === 'number' || t === 'integer') {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push({ path, rule: 'minimum', message: `${data} < minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && data > schema.maximum) errors.push({ path, rule: 'maximum', message: `${data} > maximum ${schema.maximum}` });
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push({ path, rule: 'minItems', message: `${data.length} items < minItems ${schema.minItems}` });
    if (schema.maxItems !== undefined && data.length > schema.maxItems) errors.push({ path, rule: 'maxItems', message: `${data.length} items > maxItems ${schema.maxItems}` });
    if (schema.items) data.slice(0, 500).forEach((item, i) => validate(schema.items, item, root, `${path}[${i}]`, errors, depth + 1));
  }
  if (t === 'object') {
    for (const req of schema.required || []) {
      if (!(req in data)) errors.push({ path: `${path}.${req}`, rule: 'required', message: `Required property "${req}" is missing` });
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(data)) {
      if (props[k]) validate(props[k], v, root, `${path}.${k}`, errors, depth + 1);
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${k}`, rule: 'additionalProperties', message: `Unexpected property "${k}"` });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, root, `${path}.${k}`, errors, depth + 1);
    }
  }
  if (schema.allOf) schema.allOf.forEach((s) => validate(s, data, root, path, errors, depth + 1));
  if (schema.anyOf && !schema.anyOf.some((s) => validate(s, data, root, path, [], depth + 1).length === 0)) {
    errors.push({ path, rule: 'anyOf', message: 'Value does not match any allowed schema (anyOf)' });
  }
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => validate(s, data, root, path, [], depth + 1).length === 0).length;
    if (n !== 1) errors.push({ path, rule: 'oneOf', message: `Value matches ${n} schemas; exactly one required (oneOf)` });
  }
  if (schema.not && validate(schema.not, data, root, path, [], depth + 1).length === 0) {
    errors.push({ path, rule: 'not', message: 'Value matches a forbidden schema (not)' });
  }
  return errors;
}

module.exports = { validate, jsonType };
