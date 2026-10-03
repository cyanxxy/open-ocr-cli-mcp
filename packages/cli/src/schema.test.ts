import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ocrErrorPayload } from './errors';
import {
  assertCustomSchemaOutput,
  customSchemaCompatibilityWarning,
  loadCustomSchema,
  validateCustomSchema,
} from './schema';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-schema-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('custom JSON schemas', () => {
  it('loads supported schemas and validates extracted values', async () => {
    const schemaPath = path.join(directory, 'invoice.schema.json');
    await writeFile(schemaPath, JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_number: { type: 'string', description: 'Invoice identifier' },
        invoice_date: { type: 'string', format: 'date' },
        total: { type: 'number', minimum: 0 },
      },
      required: ['invoice_number', 'invoice_date', 'total'],
    }));
    const schema = await loadCustomSchema(schemaPath, directory);
    expect(schema).not.toHaveProperty('$schema');
    expect(() => assertCustomSchemaOutput(
      schema,
      { invoice_number: 'INV-1', invoice_date: '2026-07-13', total: 12.5 },
    )).not.toThrow();
    expect(() => assertCustomSchemaOutput(
      schema,
      { invoice_number: 'INV-1', invoice_date: 'July 13', total: 12.5 },
    )).toThrow('must match format');
  });

  it('rejects unsupported Gemini schema keywords before making requests', async () => {
    const schemaPath = path.join(directory, 'unsupported.json');
    await writeFile(schemaPath, JSON.stringify({ type: 'string', pattern: '^INV-' }));
    await expect(loadCustomSchema(schemaPath, directory)).rejects.toThrow('keyword "pattern" is not supported');
  });

  it('rejects non-metadata siblings next to $ref', async () => {
    const schemaPath = path.join(directory, 'invalid-ref.json');
    await writeFile(schemaPath, JSON.stringify({ $ref: '#/$defs/value', description: 'not allowed' }));
    await expect(loadCustomSchema(schemaPath, directory)).rejects.toThrow('$ref');
  });

  it('rejects external schema references before making a request', async () => {
    const schemaPath = path.join(directory, 'external-ref.json');
    await writeFile(schemaPath, JSON.stringify({ $ref: 'https://example.com/schema.json' }));
    await expect(loadCustomSchema(schemaPath, directory)).rejects.toThrow('this schema document');
  });

  it('names an unreadable schema path instead of leaking a raw errno', async () => {
    let thrown: unknown;
    try {
      await loadCustomSchema('nope.json', directory);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe('Schema file not found: nope.json');
    // The unguarded stat() previously surfaced `ENOENT ... stat '<absolute>'`,
    // and redaction strips credentials but never filesystem paths.
    expect((thrown as Error).message).not.toContain('ENOENT');
    expect((thrown as Error).message).not.toContain(directory);
    expect(ocrErrorPayload(thrown, 2)).toMatchObject({
      code: 'SCHEMA_INVALID',
      category: 'schema',
      retryable: false,
    });
  });

  it('keeps the adjacent directory and malformed-JSON schema errors typed', async () => {
    await expect(loadCustomSchema('.', directory)).rejects.toThrow('Schema path is not a file: .');
    const schemaPath = path.join(directory, 'broken.json');
    await writeFile(schemaPath, '{ not valid JSON');
    await expect(loadCustomSchema(schemaPath, directory))
      .rejects.toThrow('Invalid JSON in schema');
  });

  it('validates and clones inline schemas for machine requests', () => {
    const input = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { value: { type: 'string' } },
    };
    const schema = validateCustomSchema(input);
    expect(schema).not.toBe(input);
    expect(schema).not.toHaveProperty('$schema');
    expect(input).toHaveProperty('$schema');
  });

  it('isolates repeated schema IDs across requests and preserves each validator', () => {
    const schema = {
      $id: 'https://example.com/extraction.json',
      type: 'object',
      properties: { value: { $ref: '#/$defs/value' } },
      required: ['value'],
      $defs: { value: { type: 'string' } },
    };
    const first = validateCustomSchema(schema);
    const repeated = validateCustomSchema(schema);
    const changed = validateCustomSchema({ ...schema, $defs: { value: { type: 'number' } } });

    expect(() => assertCustomSchemaOutput(first, { value: 'original' })).not.toThrow();
    expect(() => assertCustomSchemaOutput(repeated, { value: 'repeated' })).not.toThrow();
    expect(() => assertCustomSchemaOutput(changed, { value: 42 })).not.toThrow();
    expect(() => assertCustomSchemaOutput(first, { value: 42 })).toThrow('must be string');
    expect(() => assertCustomSchemaOutput(changed, { value: 'stale' })).toThrow('must be number');
  });

  // An array bound the provider cannot compile is rejected as a bare 400 that
  // names no field, so the cost has to be explained before the request is sent.
  it('warns that a costly array bound will likely be rejected', () => {
    const warning = customSchemaCompatibilityWarning({
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          maxItems: 1000,
          items: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
        },
      },
    });
    expect(warning).toContain('properties.rows');
    expect(warning).toContain('maxItems');
    expect(warning).toContain('cap the collection after parsing');
  });

  it('stays silent for a schema built from accepted constructs', () => {
    expect(customSchemaCompatibilityWarning({
      type: 'object',
      required: ['total'],
      additionalProperties: false,
      properties: { total: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    })).toBeUndefined();
  });
});
