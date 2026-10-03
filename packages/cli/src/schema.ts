import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import path from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { findSchemaCompatibilityIssues } from '@open-ocr/engine/gemini/schemaCompat';
import type { JsonValue } from '@open-ocr/engine/gemini/types';
import { CliExitError } from './errors';

const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_LISTED_SCHEMA_ISSUES = 3;
// Mirrors @google/genai's documented responseJsonSchema subset. `$schema` is
// accepted only as file metadata and removed before the request.
const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', '$anchor',
  'type', 'format', 'title', 'description', 'enum',
  'items', 'prefixItems', 'minItems', 'maxItems',
  'minimum', 'maximum', 'anyOf', 'oneOf',
  'properties', 'additionalProperties', 'required', 'propertyOrdering',
]);

interface CustomSchemaValidator {
  ajv: Ajv2020;
  validate: ValidateFunction<unknown>;
}

const validators = new WeakMap<Record<string, unknown>, CustomSchemaValidator>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSupportedSchemaNode(value: unknown, pointer: string, depth: number): void {
  if (!isRecord(value)) throw new Error(`${pointer} must be a JSON Schema object`);
  if (depth > 32) throw new Error('Schema nesting exceeds the supported depth of 32');
  for (const key of Object.keys(value)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`${pointer}: JSON Schema keyword "${key}" is not supported by the portable structured-output subset`);
    }
  }
  if ('$ref' in value) {
    if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#')) {
      throw new Error(`${pointer}: "$ref" must reference this schema document using a # fragment`);
    }
    const sibling = Object.keys(value).find((key) => key !== '$ref' && !key.startsWith('$'));
    if (sibling) throw new Error(`${pointer}: "$ref" cannot be combined with "${sibling}"`);
  }
  const childMaps = ['$defs', 'properties'] as const;
  for (const key of childMaps) {
    const children = value[key];
    if (children === undefined) continue;
    if (!isRecord(children)) throw new Error(`${pointer}/${key} must be an object`);
    for (const [name, child] of Object.entries(children)) {
      assertSupportedSchemaNode(child, `${pointer}/${key}/${name}`, depth + 1);
    }
  }
  for (const key of ['items', 'additionalProperties'] as const) {
    const child = value[key];
    if (child !== undefined && typeof child !== 'boolean') {
      assertSupportedSchemaNode(child, `${pointer}/${key}`, depth + 1);
    }
  }
  for (const key of ['prefixItems', 'anyOf', 'oneOf'] as const) {
    const children = value[key];
    if (children === undefined) continue;
    if (!Array.isArray(children)) throw new Error(`${pointer}/${key} must be an array`);
    children.forEach((child, index) => assertSupportedSchemaNode(child, `${pointer}/${key}/${index}`, depth + 1));
  }
}

function compileSchema(schema: Record<string, unknown>): CustomSchemaValidator {
  const cached = validators.get(schema);
  if (cached) return cached;
  // Schemas belong to one extraction request. A shared Ajv registry rejects
  // repeated $id values and strongly retains every schema in a long-lived MCP
  // process, even when this outer cache uses weak keys.
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'propertyOrdering', schemaType: 'array' });
  const validate = ajv.compile(schema);
  const compiled = { ajv, validate };
  validators.set(schema, compiled);
  return compiled;
}

/** Validate and normalize an in-memory custom schema for programmatic callers. */
export function validateCustomSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Custom schema must be a JSON object');
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `Custom schema must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new Error('Schema exceeds the 1 MB safety limit');
  }
  const schema = JSON.parse(serialized) as Record<string, unknown>;
  assertSupportedSchemaNode(schema, '#', 0);
  // Accept `$schema` as document metadata, but omit it from provider requests.
  delete schema.$schema;
  try {
    compileSchema(schema);
  } catch (error) {
    throw new Error(
      `Invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return schema;
}

function schemaFileError(message: string, cause: unknown): CliExitError {
  return new CliExitError(message, 2, {
    cause,
    code: 'SCHEMA_INVALID',
    category: 'schema',
    retryable: false,
    hint: 'Point --schema at a readable JSON Schema file.',
  });
}

/**
 * Map an unreadable schema path to a typed error naming the path the caller
 * passed. Left unguarded, the ErrnoException reaches the generic classifier and
 * reports a raw `ENOENT ... stat '<absolute path>'` instead.
 */
function unreadableSchemaError(error: unknown, schemaPath: string): CliExitError | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return schemaFileError(`Schema file not found: ${schemaPath}`, error);
  if (code === 'EISDIR') return schemaFileError(`Schema path is not a file: ${schemaPath}`, error);
  if (code === 'EACCES' || code === 'EPERM') {
    return schemaFileError(`Schema file is not readable: ${schemaPath}`, error);
  }
  return undefined;
}

/**
 * Describe constructs in a user-supplied schema that the provider is likely to
 * reject when it compiles the schema into a decoding grammar. Reported as a
 * warning rather than an error: the thresholds in `schemaCompat` come from
 * probes against one model, so a schema failing them may still be accepted
 * elsewhere. Without this the caller sees only a bare 400 naming no field.
 */
export function customSchemaCompatibilityWarning(
  schema: Record<string, unknown>,
  // Named in the caller's own vocabulary: a `run`/MCP caller never passed
  // `--schema` and cannot act on advice that points at a flag it has no access to.
  subject = '--schema',
): string | undefined {
  const issues = findSchemaCompatibilityIssues(schema);
  if (issues.length === 0) return undefined;
  const listed = issues
    .slice(0, MAX_LISTED_SCHEMA_ISSUES)
    .map((issue) => `${issue.path || 'schema'} (${issue.keyword}): ${issue.reason}`)
    .join('; ');
  const remainder = issues.length > MAX_LISTED_SCHEMA_ISSUES
    ? `, and ${issues.length - MAX_LISTED_SCHEMA_ISSUES} more`
    : '';
  return `${subject} may be rejected by the provider: ${listed}${remainder}`;
}

export async function loadCustomSchema(schemaPath: string, cwd: string): Promise<Record<string, unknown>> {
  const absolutePath = path.resolve(cwd, schemaPath);
  // Inspect and read through a single handle. Stat-then-read re-resolves the
  // path and lets the file change between the size check and the read; every
  // check here applies to the exact bytes we go on to parse.
  let handle;
  try {
    handle = await open(absolutePath, 'r');
  } catch (error) {
    throw unreadableSchemaError(error, schemaPath) ?? error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Schema path is not a file: ${schemaPath}`);
    if (metadata.size > MAX_SCHEMA_BYTES) throw new Error('Schema exceeds the 1 MB safety limit');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile('utf8')) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in schema ${schemaPath}: ${error.message}`, { cause: error });
      }
      throw unreadableSchemaError(error, schemaPath) ?? error;
    }
    return validateCustomSchema(parsed);
  } finally {
    await handle.close();
  }
}

export function assertCustomSchemaOutput(
  schema: Record<string, unknown>,
  value: unknown,
): asserts value is JsonValue {
  const { ajv, validate } = compileSchema(schema);
  if (validate(value)) return;
  const details = ajv.errorsText(validate.errors, { separator: '; ' });
  throw new Error(`Schema output validation failed: ${details}`);
}
