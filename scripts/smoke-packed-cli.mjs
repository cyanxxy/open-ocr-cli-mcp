import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'open-ocr-cli-pack-'));
const npmCache = path.join(temporary, 'npm-cache');

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

try {
  const tarballName = run('npm', ['pack', './packages/cli', '--pack-destination', temporary]).trim().split(/\r?\n/).at(-1);
  if (!tarballName) throw new Error('npm pack did not report a tarball');
  const installDirectory = path.join(temporary, 'install');
  mkdirSync(installDirectory);
  writeFileSync(path.join(installDirectory, 'package.json'), '{"private":true}\n');
  // Exercise consumers' declared Node support, not only whether the executable
  // happens to run despite a transitive package's unsupported engine range.
  run('npm', ['install', '--engine-strict', path.join(temporary, tarballName)], installDirectory);
  const npmMajor = Number.parseInt(run('npm', ['--version'], installDirectory), 10);
  if (npmMajor >= 11) {
    const pendingScripts = JSON.parse(
      run('npm', ['approve-scripts', '--allow-scripts-pending', '--json'], installDirectory),
    );
    if (pendingScripts.allowScripts?.length !== 0) {
      throw new Error(`Packed CLI has unreviewed install scripts: ${pendingScripts.allowScripts.join(', ')}`);
    }
  }
  for (const packageName of ['@google/genai', '@open-ocr/engine', 'protobufjs']) {
    if (existsSync(path.join(installDirectory, 'node_modules', ...packageName.split('/')))) {
      throw new Error(`Packed CLI unexpectedly installed bundled dependency ${packageName}`);
    }
  }
  const binaryDirectory = path.join(installDirectory, 'node_modules', '.bin');
  const executable = path.join(binaryDirectory, process.platform === 'win32' ? 'open-ocr-cli.cmd' : 'open-ocr-cli');
  const help = run(executable, ['--help']);
  run(process.execPath, [path.join(root, 'scripts', 'smoke-mcp.mjs'), executable], installDirectory);
  if (!help.includes('multimodal OCR for files')) throw new Error('Packed CLI help did not contain the expected identity');
  const providers = JSON.parse(run(executable, ['providers', '--json']));
  if (!Array.isArray(providers) || !providers.some((entry) => entry.id === 'openrouter')) {
    throw new Error('Packed CLI did not expose the OpenRouter provider');
  }
  const capabilities = JSON.parse(run(executable, ['capabilities', '--json']));
  if (
    capabilities.protocolVersion !== 2
    || !Array.isArray(capabilities.supportedProtocolVersions)
    || capabilities.supportedProtocolVersions?.length !== 1
    || capabilities.supportedProtocolVersions[0] !== 2
    || !capabilities.deliveryModes?.includes('reference')
    || capabilities.schemaAccess?.networkFetch !== false
  ) {
    throw new Error('Packed CLI did not expose the reference-first agent protocol');
  }
  const installedSkill = path.join(installDirectory, 'node_modules', 'open-ocr-cli', 'skills', 'open-ocr', 'SKILL.md');
  if (!existsSync(installedSkill) || !readFileSync(installedSkill, 'utf8').includes('name: open-ocr')) {
    throw new Error('Packed CLI did not include the shared Open OCR skill');
  }
  const requestSchema = JSON.parse(run(executable, ['schema', 'request']));
  if (!requestSchema.$id?.endsWith('/request-v2.schema.json')) {
    throw new Error('Packed CLI did not expose the current request schema');
  }
  run(executable, [
    'extract',
    path.join(root, 'evals', 'corpus', 'raster', 'invoice.png'),
    '--provider',
    'kimi',
    '--dry-run',
    '--quiet',
  ]);
  // Parse a real PDF with the installed dependency, beyond the raster sniffing
  // above. Regional PDF rendering is also exercised by the Node matrix tests.
  run(executable, [
    'extract',
    path.join(root, 'evals', 'corpus', 'invoice.pdf'),
    '--provider',
    'gemini',
    '--no-config',
    '--dry-run',
    '--quiet',
  ]);
  const requestPath = path.join(temporary, 'request.json');
  writeFileSync(requestPath, JSON.stringify({
    protocolVersion: 2,
    operation: 'extract',
    inputs: [{ type: 'path', path: path.join(root, 'evals', 'corpus', 'raster', 'invoice.png') }],
    delivery: { mode: 'reference', outputDirectory: path.join(temporary, 'results') },
    dryRun: true,
  }));
  const result = JSON.parse(run(executable, ['run', '--request', requestPath, '--response-format', 'json']));
  if (!result.ok || result.status !== 'validated' || result.documents?.[0]?.plannedArtifacts?.length !== 1) {
    throw new Error('Packed CLI agent-protocol dry run did not return planned artifact references');
  }
  const invalidRequestPath = path.join(temporary, 'invalid-request.json');
  writeFileSync(invalidRequestPath, JSON.stringify({
    protocolVersion: 2,
    operation: 'extract',
    inputs: [{ type: 'path', path: path.join(root, 'evals', 'corpus', 'raster', 'invoice.png') }],
    extraction: { preset: 'invoice', schema: { type: 'object' } },
  }));
  const invalidRun = spawnSync(
    executable,
    ['run', '--request', invalidRequestPath, '--response-format', 'jsonl'],
    { cwd: root, encoding: 'utf8' },
  );
  const invalidEvents = invalidRun.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (
    invalidRun.status !== 2
    || invalidEvents.length !== 1
    || invalidEvents[0]?.type !== 'run.failed'
    || invalidEvents[0]?.error?.code !== 'CONFIG_INVALID'
    || invalidEvents[0]?.error?.message.includes('--schema')
  ) {
    throw new Error('Packed CLI did not preserve the typed JSONL invalid-request contract');
  }
  process.stdout.write(`Packed install smoke passed: ${tarballName}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
