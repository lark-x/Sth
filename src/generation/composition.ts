import { OperationError } from '../core/index.ts';
import type { Field } from './contracts.ts';

const outputLimit = 200_000;

export function jsonObject(input: unknown): Record<string, unknown> | undefined {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}

export function assertText(...values: (string | undefined)[]) {
  if (values.some(value => value !== undefined && /[\0\p{Surrogate}]/u.test(value))) {
    throw new OperationError(400, 'generation_invalid_text', 'Use well-formed text without NUL characters.');
  }
}

export function validateTemplate(fields: Field[], path = '/fields') {
  const keys = new Set<string>();
  for (const [index, field] of fields.entries()) {
    const here = `${path}/${index}`;
    assertText(field.label, field.description);
    if (keys.has(field.key)) {
      throw new OperationError(400, 'generation_invalid_template', `${here}/key duplicates ${JSON.stringify(field.key)}.`);
    }
    keys.add(field.key);
    if (field.type === 'integer' && (field.minimum ?? -Infinity) > (field.maximum ?? Infinity)) {
      throw new OperationError(400, 'generation_invalid_template', `${here}: minimum exceeds maximum.`);
    }
    if (field.type === 'sections') {
      if ((field.minItems ?? 1) > (field.maxItems ?? 100)) {
        throw new OperationError(400, 'generation_invalid_template', `${here}: minItems exceeds maxItems.`);
      }
      validateTemplate(field.fields, `${here}/fields`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(fields)) > outputLimit) {
    throw new OperationError(400, 'generation_invalid_template', 'Template fields exceed the 200,000-byte limit.');
  }
}

function invalidOutput(path: string, message: string): never {
  throw new OperationError(422, 'generation_invalid_output', `${path || '/'}: ${message}`);
}

function validateObject(input: unknown, fields: Field[], path: string, nullableOptionals: boolean): Record<string, unknown> {
  const object = jsonObject(input);
  if (!object) invalidOutput(path, 'expected an object.');
  const allowed = new Set(fields.map(field => field.key));
  const unexpected = Object.keys(object).find(key => !allowed.has(key));
  if (unexpected !== undefined) {
    invalidOutput(path, `unexpected field ${JSON.stringify(unexpected.slice(0, 100))}.`);
  }
  const values: [string, unknown][] = [];
  for (const field of fields) {
    const fieldPath = `${path}/${field.key}`;
    if (!Object.hasOwn(object, field.key)) {
      if (field.required !== false) invalidOutput(fieldPath, 'field is required.');
      continue;
    }
    const value = object[field.key];
    if (nullableOptionals && value === null && field.required === false) continue;
    switch (field.type) {
      case 'text': {
        const maxLength = field.maxLength ?? 100_000;
        if (typeof value !== 'string' || !value.trim() || /[\0\p{Surrogate}]/u.test(value)) {
          invalidOutput(fieldPath, 'expected well-formed, nonblank text.');
        }
        if ([...value].length > maxLength) invalidOutput(fieldPath, `text exceeds ${maxLength} characters.`);
        values.push([field.key, value]);
        break;
      }
      case 'integer':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalidOutput(fieldPath, 'expected a safe integer.');
        if (field.minimum !== undefined && value < field.minimum) invalidOutput(fieldPath, `must be at least ${field.minimum}.`);
        if (field.maximum !== undefined && value > field.maximum) invalidOutput(fieldPath, `must be at most ${field.maximum}.`);
        values.push([field.key, value]);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') invalidOutput(fieldPath, 'expected a boolean.');
        values.push([field.key, value]);
        break;
      case 'sections': {
        const minItems = field.minItems ?? 1;
        const maxItems = field.maxItems ?? 100;
        if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
          invalidOutput(fieldPath, `expected an array with ${minItems} to ${maxItems} entries.`);
        }
        values.push([field.key, value.map((entry, index) => validateObject(entry, field.fields, `${fieldPath}/${index}`, nullableOptionals))]);
        break;
      }
    }
  }
  return Object.fromEntries(values);
}

export function validateOutput(input: unknown, fields: Field[], nullableOptionals = false) {
  const output = validateObject(input, fields, '', nullableOptionals);
  if (Buffer.byteLength(JSON.stringify(output)) > outputLimit) invalidOutput('', 'output exceeds the 200,000-byte limit.');
  return output;
}

export function parseProviderOutput(rawOutput: string, fields: Field[], nullableOptionals = false) {
  const fence = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(rawOutput.trim());
  let output: unknown;
  try {
    output = JSON.parse(fence ? fence[1] : rawOutput);
  } catch {
    invalidOutput('', 'provider did not return valid JSON.');
  }
  return validateOutput(output, fields, nullableOptionals);
}

export function structuredOutputSchema(fields: Field[]): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: fields.map(field => field.key),
    properties: Object.fromEntries(fields.map(field => {
      const value = field.type === 'sections' ? { type: 'array', items: structuredOutputSchema(field.fields) }
        : { type: field.type === 'text' ? 'string' : field.type };
      return [field.key, field.required === false ? { anyOf: [value, { type: 'null' }] } : value];
    })),
  };
}

