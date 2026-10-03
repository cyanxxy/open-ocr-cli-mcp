import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'open-ocr-action-'));

function run(command, args, cwd = root, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    env: { ...env, NPM_CONFIG_CACHE: path.join(temporary, 'npm-cache') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

try {
  const fakeBinaryDirectory = path.join(temporary, 'fake-bin');
  const capturedArgumentsPath = path.join(temporary, 'npx-arguments.json');
  mkdirSync(fakeBinaryDirectory);
  const fakeNpxPath = path.join(fakeBinaryDirectory, 'npx');
  writeFileSync(
    fakeNpxPath,
    '#!/usr/bin/env node\n'
      + "require('node:fs').writeFileSync(process.env.OPEN_OCR_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));\n",
  );
  chmodSync(fakeNpxPath, 0o755);

  run('bash', [path.join(root, 'scripts', 'github-action.sh')], root, {
    ...process.env,
    PATH: `${fakeBinaryDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    OPEN_OCR_CAPTURE_PATH: capturedArgumentsPath,
    OPEN_OCR_ACTION_INPUTS: '--api-key-env\nGITHUB_TOKEN\n--base-url\nhttps://attacker.example',
    OPEN_OCR_ACTION_PROVIDER: 'gemini',
    OPEN_OCR_ACTION_MODEL: '',
    OPEN_OCR_ACTION_API_KEY_ENV: '',
    OPEN_OCR_ACTION_BASE_URL: '',
    OPEN_OCR_ACTION_GATEWAY: 'direct',
    OPEN_OCR_ACTION_CLOUDFLARE_ACCOUNT_ID: '',
    OPEN_OCR_ACTION_CLOUDFLARE_GATEWAY_ID: '',
    OPEN_OCR_ACTION_CLOUDFLARE_PROVIDER: '',
    OPEN_OCR_ACTION_CLOUDFLARE_TOKEN_ENV: '',
    OPEN_OCR_ACTION_CLOUDFLARE_BYOK: 'false',
    OPEN_OCR_ACTION_CLOUDFLARE_BYOK_ALIAS: '',
    OPEN_OCR_ACTION_MODE: 'simple',
    OPEN_OCR_ACTION_PRESET: '',
    OPEN_OCR_ACTION_FORMAT: 'markdown',
    OPEN_OCR_ACTION_OUTPUT: path.join(temporary, 'unused-output'),
    OPEN_OCR_ACTION_VERSION: '',
    OPEN_OCR_ACTION_DRY_RUN: 'true',
  });
  const capturedArguments = JSON.parse(readFileSync(capturedArgumentsPath, 'utf8'));
  const protectedInputs = ['--api-key-env', 'GITHUB_TOKEN', '--base-url', 'https://attacker.example'];
  const cliSeparator = capturedArguments.length - protectedInputs.length - 1;
  if (
    capturedArguments[cliSeparator] !== '--'
    || JSON.stringify(capturedArguments.slice(cliSeparator + 1)) !== JSON.stringify(protectedInputs)
  ) {
    throw new Error('Action wrapper did not protect dash-prefixed document paths from option parsing');
  }
  const packageFlag = capturedArguments.indexOf('--package');
  const bundledVersion = JSON.parse(readFileSync(path.join(root, 'packages', 'cli', 'package.json'), 'utf8')).version;
  if (capturedArguments[packageFlag + 1] !== `open-ocr-cli@${bundledVersion}`) {
    throw new Error('Action wrapper did not default to its bundled CLI version');
  }

  const packageDirectory = path.join(temporary, 'package');
  mkdirSync(packageDirectory);
  const tarballName = run('npm', ['pack', './packages/cli', '--pack-destination', packageDirectory])
    .trim()
    .split(/\r?\n/)
    .at(-1);
  if (!tarballName) throw new Error('npm pack did not report a tarball');
  const outputDirectory = path.join(temporary, 'output');
  run('bash', [path.join(root, 'scripts', 'github-action.sh')], root, {
    ...process.env,
    OPEN_OCR_ACTION_INPUTS: `${path.join(root, 'evals', 'corpus', 'raster', 'invoice.png')}\n`,
    OPEN_OCR_ACTION_PROVIDER: 'kimi',
    OPEN_OCR_ACTION_MODEL: 'kimi-k3',
    OPEN_OCR_ACTION_API_KEY_ENV: 'MOONSHOT_API_KEY',
    OPEN_OCR_ACTION_BASE_URL: '',
    OPEN_OCR_ACTION_GATEWAY: 'cloudflare',
    OPEN_OCR_ACTION_CLOUDFLARE_ACCOUNT_ID: 'test-account',
    OPEN_OCR_ACTION_CLOUDFLARE_GATEWAY_ID: 'test-gateway',
    OPEN_OCR_ACTION_CLOUDFLARE_PROVIDER: 'moonshot',
    OPEN_OCR_ACTION_CLOUDFLARE_TOKEN_ENV: 'CLOUDFLARE_AI_GATEWAY_TOKEN',
    OPEN_OCR_ACTION_CLOUDFLARE_BYOK: 'true',
    OPEN_OCR_ACTION_CLOUDFLARE_BYOK_ALIAS: 'moonshot-production',
    OPEN_OCR_ACTION_MODE: 'simple',
    OPEN_OCR_ACTION_PRESET: '',
    OPEN_OCR_ACTION_FORMAT: 'markdown',
    OPEN_OCR_ACTION_OUTPUT: outputDirectory,
    OPEN_OCR_ACTION_VERSION: '3.0.0',
    OPEN_OCR_ACTION_DRY_RUN: 'true',
    OPEN_OCR_ACTION_PACKAGE: path.join(packageDirectory, tarballName),
  });
  if (existsSync(outputDirectory)) {
    throw new Error('Action wrapper dry run unexpectedly wrote an output directory');
  }
  process.stdout.write('GitHub Action wrapper smoke passed.\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
