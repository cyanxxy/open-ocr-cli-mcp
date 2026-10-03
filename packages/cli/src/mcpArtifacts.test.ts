import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { MCP_ARTIFACT_CHUNK_BYTES, McpArtifactRegistry } from './mcpArtifacts';
import type { OcrMachineResult } from './protocol';

describe('MCP artifact reads', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  const fixture = async (text: string, registry = new McpArtifactRegistry()): Promise<{
    registry: McpArtifactRegistry;
    filename: string;
    uri: string;
    result: OcrMachineResult;
  }> => {
    const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-mcp-artifact-'));
    directories.push(directory);
    const filename = path.join(directory, 'result.md');
    await writeFile(filename, text);
    const result = {
      documents: [{ status: 'succeeded', artifacts: [{ path: filename, kind: 'markdown', mediaType: 'text/markdown' }] }],
    } as unknown as OcrMachineResult;
    expect(await registry.remember(result)).toEqual([]);
    return { registry, filename, uri: pathToFileURL(filename).href, result };
  };

  it('reads only remembered outputs and never registers dry-run planned artifacts', async () => {
    const { registry, uri } = await fixture('hello');
    expect(await registry.read(uri)).toMatchObject({ text: 'hello', offset: 0, nextOffset: 5, totalBytes: 5, eof: true });
    await registry.remember({ documents: [{ artifacts: [], plannedArtifacts: [{ path: '/tmp/secret' }] }] } as unknown as OcrMachineResult);
    await expect(registry.read('file:///tmp/secret')).rejects.toThrow('not retained');
    await expect(new McpArtifactRegistry().read(uri)).rejects.toThrow('not retained');
  });

  it.each([4, 5, 6, 7, 8, 9])('round-trips all UTF-8 code point sizes at a %i-byte boundary', async (maxBytes) => {
    const text = '\ufeffAé中😀\ufeffZé日🧾'.repeat(9);
    const { registry, uri } = await fixture(text);
    let offset = 0;
    const chunks: string[] = [];
    for (;;) {
      const chunk = await registry.read(uri, offset, maxBytes);
      expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(maxBytes);
      expect(chunk.nextOffset).toBeGreaterThan(offset);
      chunks.push(chunk.text);
      offset = chunk.nextOffset;
      if (chunk.eof) break;
    }
    expect(chunks.join('')).toBe(text);
    expect(offset).toBe(Buffer.byteLength(text));
  });

  it('caps default reads, validates offsets, and refuses invalid UTF-8 boundaries', async () => {
    const { registry, uri } = await fixture(`😀${'x'.repeat(MCP_ARTIFACT_CHUNK_BYTES)}`);
    const first = await registry.read(uri);
    expect(Buffer.byteLength(first.text)).toBe(MCP_ARTIFACT_CHUNK_BYTES);
    expect(first.eof).toBe(false);
    expect(await registry.read(uri, first.nextOffset)).toMatchObject({ text: 'xxxx', eof: true });
    await expect(registry.read(uri, 1)).rejects.toThrow('not valid UTF-8');
    await expect(registry.read(uri, -1)).rejects.toThrow('offset');
    await expect(registry.read(uri, first.totalBytes + 1)).rejects.toThrow('offset');
    await expect(registry.read(uri, 0, MCP_ARTIFACT_CHUNK_BYTES + 1)).rejects.toThrow('maxBytes');
    expect(await registry.read(uri, first.totalBytes)).toMatchObject({ text: '', eof: true });
  });

  it('refuses a file replaced by a symlink or a different regular file', async () => {
    const { registry, filename, uri } = await fixture('output');
    const replacement = `${filename}.replacement`;
    await writeFile(replacement, 'secret');
    await rm(filename);
    await symlink(replacement, filename);
    await expect(registry.read(uri)).rejects.toThrow();
    await rm(filename);
    await rename(replacement, filename);
    await expect(registry.read(uri)).rejects.toThrow('changed since OCR');
  });

  it('refuses in-place mutations and bounds the registry to its newest artifacts', async () => {
    const { registry, filename, uri } = await fixture('output', new McpArtifactRegistry(2));
    await writeFile(filename, 'new output');
    await expect(registry.read(uri)).rejects.toThrow('changed since OCR');
    const first = await fixture('first', registry);
    const second = await fixture('second', registry);
    const third = await fixture('third', registry);
    await expect(registry.read(first.uri)).rejects.toThrow('not retained');
    expect((await registry.read(second.uri)).text).toBe('second');
    expect((await registry.read(third.uri)).text).toBe('third');
  });

  it('reports missing output without throwing away the extraction result', async () => {
    const { registry, filename, result } = await fixture('output');
    await rm(filename);
    expect(await registry.remember(result)).toEqual([expect.stringContaining('MCP could not retain artifact')]);
  });

  it('does not let a user-editable resume manifest grant access to pre-existing files', async () => {
    const { registry, uri, result } = await fixture('prior output');
    if (!('documents' in result)) throw new Error('Expected a document result');
    result.documents[0].status = 'skipped';
    const fresh = new McpArtifactRegistry();
    expect(await fresh.remember(result)).toEqual([expect.stringContaining('was not written by this MCP process')]);
    await expect(fresh.read(uri)).rejects.toThrow('not retained');
    // Resuming the same process's own unchanged output preserves read access.
    expect(await registry.remember(result)).toEqual([]);
    expect((await registry.read(uri)).text).toBe('prior output');
  });
});
