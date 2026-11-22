/**
 * Node runtime contract: the position of a JSON syntax error comes from V8's
 * SyntaxError message (see jsonSyntaxLocation in fileBoundary.ts). Files named
 * *.node.test.ts run on Node only; bun test, whose engine words the error
 * differently, skips them by name and CI runs them under Vitest on Node.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadCustomSchema } from './schema';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-schema-node-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('custom JSON schemas on Node', () => {
  it('reports where schema JSON is malformed without quoting the file', async () => {
    const schemaPath = path.join(directory, 'schema.json');
    await writeFile(schemaPath, '{"private_key": 1,}');
    const positioned = await loadCustomSchema(schemaPath, directory).catch((error: unknown) => error as Error);
    expect(positioned.message).toMatch(/^Invalid JSON in schema \S+ \(at position \d+/u);
    expect(positioned.message).not.toContain('private_key');
  });
});
