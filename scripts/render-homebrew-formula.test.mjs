import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { renderHomebrewFormula } from './render-homebrew-formula.mjs';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'render-homebrew-formula.mjs');

test('the Homebrew formula installs a packed tarball with std_npm_args, never a linked build directory', () => {
  const formula = renderHomebrewFormula({ version: '4.4.0', sha256: 'a'.repeat(64) });
  assert.match(formula, /^ {4}system "npm", "install", \*std_npm_args$/mu);
  assert.match(formula, /^ {4}bin\.install_symlink libexec\.glob\("bin\/\*"\)$/mu);
  // A directory install only symlinks libexec to Homebrew's temporary buildpath.
  assert.doesNotMatch(formula, /"--prefix", libexec/u);
  assert.doesNotMatch(formula, /"install", "--global"/u);
  assert.doesNotMatch(formula, /libexec, "\."/u);
  assert.match(formula, /^ {2}url "https:\/\/registry\.npmjs\.org\/open-ocr-cli\/-\/open-ocr-cli-4\.4\.0\.tgz"$/mu);
  assert.match(formula, new RegExp(`^ {2}sha256 "${'a'.repeat(64)}"$`, 'mu'));
  assert.match(formula, /^ {2}depends_on "node"$/mu);
});

test('the formula renderer rejects malformed versions and checksums', () => {
  assert.throws(() => renderHomebrewFormula({ version: '4.4', sha256: 'a'.repeat(64) }));
  assert.throws(() => renderHomebrewFormula({ version: '4.4.0', sha256: 'A'.repeat(64) }));
  assert.throws(() => renderHomebrewFormula({ version: '4.4.0', sha256: 'a'.repeat(63) }));
});

test('the release command hashes the exact tarball and refuses another version', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'open-ocr-formula-'));
  try {
    const { version } = JSON.parse(readFileSync(path.join(root, 'packages', 'cli', 'package.json'), 'utf8'));
    const tarball = path.join(temporary, `open-ocr-cli-${version}.tgz`);
    writeFileSync(tarball, 'tarball bytes');
    const output = path.join(temporary, 'open-ocr-cli.rb');
    execFileSync(process.execPath, [script, tarball, output], { cwd: root, stdio: 'pipe' });
    const sha256 = createHash('sha256').update('tarball bytes').digest('hex');
    assert.equal(readFileSync(output, 'utf8'), renderHomebrewFormula({ version, sha256 }));

    const wrongTarball = path.join(temporary, 'open-ocr-cli-0.0.1.tgz');
    writeFileSync(wrongTarball, 'tarball bytes');
    assert.throws(() => execFileSync(process.execPath, [script, wrongTarball, output], { cwd: root, stdio: 'pipe' }));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
