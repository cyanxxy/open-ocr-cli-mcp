import { promises as nodeFs } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Discovery itself cannot match a file outside (it skips symbolic links), so
// an outside match is simulated by handing it to the confinement callback that
// machine.ts gives discovery, which is where real matches are judged before
// any of them is stat'ed or opened.
const discovery = vi.hoisted(() => ({ outsideMatch: undefined as string | undefined }));
vi.mock('./inputs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inputs')>();
  return {
    ...actual,
    discoverInputSet: async (...args: Parameters<typeof actual.discoverInputSet>) => {
      const [, , , confineMatches] = args;
      if (discovery.outsideMatch) {
        if (!confineMatches) throw new Error('MCP discovery must receive a confinement callback');
        await confineMatches([discovery.outsideMatch]);
      }
      return actual.discoverInputSet(...args);
    },
  };
});

import { confineCallerPath, isForeignNetworkPath } from './fileBoundary';
import { executeOcrJobRequest } from './machine';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

let root: string;
let cwd: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'open-ocr-boundary-'));
  cwd = path.join(root, 'project');
  outside = path.join(root, 'outside');
  await Promise.all([mkdir(cwd), mkdir(outside), mkdir(path.join(root, 'home'))]);
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('USERPROFILE', path.join(root, 'home'));
  vi.stubEnv('OPEN_OCR_NO_CONFIG', undefined);
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function mcpRequest(inputs: Array<{ type: 'path'; path: string }>) {
  return executeOcrJobRequest({
    protocolVersion: 2,
    operation: 'extract',
    inputs,
    dryRun: true,
  }, { cwd, runId: 'boundary-run', abortController: new AbortController(), boundary: 'mcp' });
}

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
}

describe('MCP input boundary', () => {
  it.each([
    '.{.,}/outside/*.pdf',
    '{.,x}./outside/*.pdf',
    '.[.]/outside/*.pdf',
    '\\.\\./outside/*.pdf',
  ])('refuses %s before walking outside, whether or not the file exists', async (pattern) => {
    const statSpy = vi.spyOn(nodeFs, 'stat');
    const openSpy = vi.spyOn(nodeFs, 'open');
    const missing = await refusal(mcpRequest([{ type: 'path', path: pattern }]));
    await writeFile(path.join(outside, 'secret-contract.pdf'), PDF_BYTES);
    const present = await refusal(mcpRequest([{ type: 'path', path: pattern }]));

    expect(present).toMatchObject({ code: 'INPUT_INVALID' });
    expect(present.message).toBe(missing.message);
    expect(present.message).not.toContain('secret-contract');
    const outsideCalls = [...statSpy.mock.calls, ...openSpy.mock.calls]
      .map(([target]) => String(target))
      .filter((target) => target.startsWith(outside));
    expect(outsideCalls).toEqual([]);
  });

  it('refuses a discovered match outside the working directory without naming it', async () => {
    await writeFile(path.join(cwd, 'scan.pdf'), PDF_BYTES);
    await writeFile(path.join(outside, 'secret-contract.pdf'), PDF_BYTES);
    discovery.outsideMatch = path.join(outside, 'secret-contract.pdf');
    try {
      const error = await refusal(mcpRequest([{ type: 'path', path: '*.pdf' }]));
      expect(error).toMatchObject({ code: 'INPUT_INVALID' });
      expect(error.message).toBe('An input matched a file that resolves outside the MCP server working directory');
    } finally {
      discovery.outsideMatch = undefined;
    }
  });

  it('refuses outside absolute paths and globs', async () => {
    await expect(confineCallerPath(cwd, '/etc/passwd', 'input')).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    for (const value of ['/etc/passwd', '/etc/*.conf', path.join(outside, 'x (1).pdf')]) {
      await expect(mcpRequest([{ type: 'path', path: value }])).rejects.toMatchObject({ code: 'INPUT_INVALID' });
    }
  });

  it('judges a Windows UNC or device path by its spelling, before any filesystem call', () => {
    const docs = 'C:\\Users\\me\\Docs';
    for (const value of [
      '\\\\attacker.example\\share\\scan.png',
      '//attacker.example/share/scan.png',
      '\\\\?\\UNC\\attacker.example\\share\\scan.png',
      '\\\\.\\pipe\\x',
    ]) {
      expect(isForeignNetworkPath(value, docs, path.win32), value).toBe(true);
    }
    expect(isForeignNetworkPath('scan.png', docs, path.win32)).toBe(false);
    expect(isForeignNetworkPath('C:\\Other\\scan.png', docs, path.win32)).toBe(false);
    // A working directory on the share may read that share.
    expect(isForeignNetworkPath('scan.png', '\\\\fileserver\\team\\docs', path.win32)).toBe(false);
    expect(isForeignNetworkPath('\\\\fileserver\\team\\docs\\a.png', '\\\\fileserver\\team\\docs', path.win32)).toBe(false);
    expect(isForeignNetworkPath('\\\\other\\team\\a.png', '\\\\fileserver\\team\\docs', path.win32)).toBe(true);
    // POSIX paths are never network paths by spelling.
    expect(isForeignNetworkPath('//host/share/x', '/workspace', path.posix)).toBe(false);
  });

  it('still accepts inside paths, including through the real path of the working directory', async () => {
    await writeFile(path.join(cwd, 'scan.pdf'), PDF_BYTES);
    const real = await nodeFs.realpath(cwd);
    await expect(confineCallerPath(cwd, path.join(real, 'scan.pdf'), 'input')).resolves.toBe(path.join(real, 'scan.pdf'));
    await expect(confineCallerPath(cwd, 'scan.pdf', 'input')).resolves.toBe(path.join(cwd, 'scan.pdf'));
  });
});

describe('URL requests and file-oriented configuration', () => {
  it.each([
    ['format all', { format: 'all' }],
    ['a record preset', { preset: 'invoice' }],
    ['a schema', { schema: 's.json' }],
    ['agentic mode', { mode: 'agentic' }],
  ])('validates a URL dry run under a project config with %s', async (_label, config) => {
    await writeFile(path.join(cwd, '.open-ocr-cli.json'), JSON.stringify(config));
    await writeFile(path.join(cwd, 's.json'), JSON.stringify({ type: 'object' }));
    for (const boundary of [undefined, 'mcp'] as const) {
      const execution = await executeOcrJobRequest({
        protocolVersion: 2,
        operation: 'extract',
        inputs: [{ type: 'url', url: 'https://example.com/' }],
        dryRun: true,
      }, { cwd, runId: 'url-run', abortController: new AbortController(), ...(boundary ? { boundary } : {}) });
      expect(execution.result).toMatchObject({ status: 'validated' });
    }
  });

  it('takes JSON output from a config format of json', async () => {
    await writeFile(path.join(cwd, '.open-ocr-cli.json'), JSON.stringify({ format: 'json' }));
    let format: string | undefined;
    await executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'url', url: 'https://example.com/' }],
      dryRun: true,
    }, {
      cwd,
      runId: 'url-json',
      abortController: new AbortController(),
      onResolvedOptions: (options) => { format = options.format; },
    });
    expect(format).toBe('json');
  });

  it('still validates explicit extraction fields on a URL request', async () => {
    await expect(executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      inputs: [{ type: 'url', url: 'https://example.com/' }],
      extraction: { mode: 'agentic' },
      dryRun: true,
    }, { cwd, runId: 'url-agentic', abortController: new AbortController() })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('run --no-config', () => {
  it('refuses a request that names a configPath', async () => {
    await writeFile(path.join(cwd, 'scan.pdf'), PDF_BYTES);
    await writeFile(path.join(cwd, 'my.json'), JSON.stringify({ model: 'gemini-4-argon', maxFiles: 7 }));
    await expect(executeOcrJobRequest({
      protocolVersion: 2,
      operation: 'extract',
      configPath: 'my.json',
      inputs: [{ type: 'path', path: 'scan.pdf' }],
      dryRun: true,
    }, { cwd, runId: 'no-config', abortController: new AbortController(), noConfig: true }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('--no-config') as unknown });
  });
});
