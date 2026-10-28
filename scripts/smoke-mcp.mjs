import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// The client comes from the workspace dev dependency; the server executable
// must come from the installed tarball so workspace imports cannot hide a
// missing production dependency in its lazy MCP entry point.
const executable = process.argv[2];
if (!executable) throw new Error('Supply the installed CLI executable');
const directory = await mkdtemp(path.join(tmpdir(), 'open-ocr-sdk-smoke-'));
const transport = new StdioClientTransport({
  command: executable,
  args: ['mcp'],
  cwd: directory,
  env: { ...process.env, OPEN_OCR_NO_CONFIG: '1', OPEN_OCR_MCP_CONFIRM: '0', NODE_ENV: 'development' },
  stderr: 'pipe',
  maxBufferSize: 1024 * 1024,
});
const client = new Client({ name: 'open-ocr-smoke', version: '1' }, {
  versionNegotiation: { mode: { pin: '2026-07-28' } },
});
let diagnostics = '';
transport.stderr?.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-8192); });
const errors = [];
client.onerror = (error) => errors.push(error);
const deadline = setTimeout(() => {
  if (transport.pid) process.kill(transport.pid, 'SIGKILL');
}, 20_000);

try {
  await writeFile(path.join(directory, 'scan.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]));
  await writeFile(path.join(directory, 'invalid.png'), 'not an image');
  await client.connect(transport);
  assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
  assert.equal(client.getServerVersion()?.name, 'open-ocr-cli-mcp');
  const discovery = await client.discover();
  assert.deepEqual(discovery.supportedVersions, ['2026-07-28']);
  assert.equal(discovery.cacheScope, 'private');
  const catalog = await client.listTools();
  assert.ok(catalog.tools.some((tool) => tool.name === 'ocr_extract'));
  assert.ok(catalog.tools.some((tool) => tool.name === 'ocr_read_artifact'));
  const capabilities = await client.callTool({ name: 'ocr_capabilities', arguments: {} });
  assert.equal(capabilities.structuredContent.capabilities.protocolVersion, 2);

  const progress = [];
  const dryRun = await client.callTool({
    name: 'ocr_extract',
    arguments: { inputs: [{ type: 'path', path: 'scan.jpg' }], dryRun: true, noConfig: true },
  }, { onprogress: (event) => progress.push(event) });
  assert.equal(dryRun.structuredContent.status, 'validated');
  assert.equal(dryRun.structuredContent.documents.length, 1);
  assert.ok(progress.length > 0);
  assert.equal(progress.at(-1).progress, 1);
  for (let index = 1; index < progress.length; index++) {
    assert.ok(progress[index].progress > progress[index - 1].progress);
  }
  const invalid = await client.callTool({
    name: 'ocr_extract', arguments: { inputs: [{ type: 'path', path: '-' }], dryRun: true },
  });
  assert.equal(invalid.isError, true);
  const partial = await client.callTool({
    name: 'ocr_extract',
    arguments: { inputs: [{ type: 'path', path: 'scan.jpg' }, { type: 'path', path: 'invalid.png' }], dryRun: true, noConfig: true },
  });
  assert.equal(partial.isError, true);
  assert.equal(partial.structuredContent.status, 'partial');
  assert.equal(partial.structuredContent.documents.length, 2);
  const forbidden = await client.callTool({ name: 'ocr_read_artifact', arguments: { uri: 'file:///etc/passwd' } });
  assert.equal(forbidden.isError, true);
  assert.deepEqual(errors, [], diagnostics);
  // SDK close ends stdin first, exercising the portable EOF shutdown path.
  await client.close();
  assert.equal(transport.pid, null, diagnostics);
  process.stdout.write('Packed MCP SDK stdio smoke passed\n');
} finally {
  clearTimeout(deadline);
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
