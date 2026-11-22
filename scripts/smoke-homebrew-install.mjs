// Install a packed CLI tarball the way the rendered Homebrew formula does with
// std_npm_args: stage the package, drop its pack lifecycle scripts, pack it
// with --ignore-scripts, install that tarball globally into libexec, then
// delete the staging directory as Homebrew does before the formula test runs.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [tarball] = process.argv.slice(2);
if (!tarball) throw new Error('Usage: node scripts/smoke-homebrew-install.mjs <tarball>');
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(root, 'packages', 'cli', 'package.json'), 'utf8')).version;
const temporary = mkdtempSync(path.join(tmpdir(), 'open-ocr-homebrew-'));
const buildpath = path.join(temporary, 'buildpath');
const libexec = path.join(temporary, 'libexec');

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: path.join(temporary, 'npm-cache') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

try {
  mkdirSync(buildpath);
  run('tar', ['-xzf', path.resolve(tarball), '-C', buildpath, '--strip-components=1'], temporary);
  const manifestPath = path.join(buildpath, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const script of ['prepare', 'prepack', 'postpack']) delete manifest.scripts?.[script];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = run('npm', ['pack', '--ignore-scripts'], buildpath).trim().split(/\r?\n/).at(-1);
  if (!packed) throw new Error('npm pack did not report a tarball');
  mkdirSync(path.join(libexec, 'lib'), { recursive: true });
  // std_npm_args also passes --build-from-source, which only affects install
  // scripts; --ignore-scripts already skips those, and npm 11 warns about it.
  run('npm', ['install', '--global', '--ignore-scripts', `--prefix=${libexec}`, path.join(buildpath, packed)], temporary);
  const installed = path.join(libexec, 'lib', 'node_modules', 'open-ocr-cli');
  if (lstatSync(installed).isSymbolicLink()) {
    throw new Error('The Homebrew-style install linked to the build directory instead of installing the package');
  }
  rmSync(buildpath, { recursive: true, force: true });

  const executable = path.join(libexec, 'bin', 'open-ocr-cli');
  const reported = run(executable, ['--version'], temporary).trim();
  if (reported !== version) throw new Error(`Homebrew-style install reported ${reported}, expected ${version}`);
  const providers = JSON.parse(run(executable, ['providers', '--json'], temporary));
  if (!Array.isArray(providers) || !providers.some((entry) => entry.id === 'openrouter')) {
    throw new Error('Homebrew-style install did not expose the OpenRouter provider');
  }
  process.stdout.write(`Homebrew-style install smoke passed: ${path.basename(tarball)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
