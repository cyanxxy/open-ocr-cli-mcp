import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { satisfiesEngineRange } from './github-action-node.mjs';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'github-action-node.mjs');
const engines = JSON.parse(readFileSync(path.join(root, 'packages', 'cli', 'package.json'), 'utf8')).engines.node;

test('the action accepts exactly the Node.js releases an engines range admits', () => {
  const range = '^20.19.0 || ^22.13.0 || >=24.0.0';
  for (const version of ['20.19.0', 'v20.20.2', '22.13.0', '22.23.5', '24.0.0', 'v24.22.3', '26.13.1', '27.0.0']) {
    assert.equal(satisfiesEngineRange(version, range), true, version);
  }
  for (const version of ['18.20.8', '20.18.3', '21.7.3', '22.12.0', '23.11.1', '26.0.0-nightly20261001', 'v24', '', undefined]) {
    assert.equal(satisfiesEngineRange(version, range), false, String(version));
  }
});

test('every alternative of the CLI engines range is in a form the action understands', () => {
  // An unrecognized alternative never matches, which would make the action
  // install Node.js 22 over a supported job runtime instead of reusing it.
  for (const alternative of engines.split('||')) {
    const minimum = /^(?:\^|>=)(\d+\.\d+\.\d+)$/u.exec(alternative.trim())?.[1];
    assert.ok(minimum, `unrecognized engines alternative ${alternative.trim()}`);
    assert.equal(satisfiesEngineRange(minimum, engines), true, minimum);
  }
});

test('unrecognized engines ranges fail closed', () => {
  assert.equal(satisfiesEngineRange('22.13.0', undefined), false);
  assert.equal(satisfiesEngineRange('22.13.0', '22.x'), false);
  assert.equal(satisfiesEngineRange('22.13.0', '>=20 <23'), false);
  assert.equal(satisfiesEngineRange('0.5.0', '^0.4.0'), false);
  // Only the alternatives in a known form can match.
  assert.equal(satisfiesEngineRange('21.0.0', '^20.19.0 || 21.x'), false);
  assert.equal(satisfiesEngineRange('20.19.0', '^20.19.0 || 21.x'), true);
});

test('the --check command exits non-zero unless the running Node.js is supported', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'open-ocr-action-node-'));
  try {
    const check = (range) => {
      const manifest = path.join(temporary, 'package.json');
      writeFileSync(manifest, JSON.stringify(range === undefined ? {} : { engines: { node: range } }));
      return spawnSync(process.execPath, [script, '--check', manifest], { encoding: 'utf8' }).status;
    };
    assert.equal(check(`>=${process.versions.node}`), 0);
    assert.equal(check('>=999.0.0'), 1);
    assert.equal(check(undefined), 1);
    assert.notEqual(spawnSync(process.execPath, [script, '--check', path.join(temporary, 'missing.json')]).status, 0);
    assert.equal(spawnSync(process.execPath, [script, '--check', path.join(root, 'packages', 'cli', 'package.json')]).status, 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('action.yml only runs setup-node when the job lacks a supported Node.js', () => {
  const action = readFileSync(path.join(root, 'action.yml'), 'utf8');
  const steps = action.slice(action.indexOf('  steps:\n')).split(/^ {4}- name: /mu).slice(1);
  const checkIndex = steps.findIndex((step) => step.startsWith('Check for a supported Node.js\n'));
  const setupIndex = steps.findIndex((step) => /^ {6}uses: actions\/setup-node@/mu.test(step));
  assert.ok(checkIndex >= 0 && setupIndex > checkIndex, 'the Node.js check must run before setup-node');
  assert.match(steps[checkIndex], /^ {6}id: node$/mu);
  assert.match(steps[checkIndex], /scripts\/github-action-node\.mjs" --check "\$\{\{ github\.action_path \}\}\/packages\/cli\/package\.json"/u);
  assert.match(steps[checkIndex], /command -v npx/u);
  assert.match(steps[setupIndex], /^ {6}if: steps\.node\.outputs\.supported != 'true'$/mu);

  // Run the check step's script as the runner would, against different PATHs.
  const runBlock = /^ {6}run: \|\n((?: {8}.*\n|\n)+)/mu.exec(steps[checkIndex])?.[1];
  assert.ok(runBlock, 'the check step must have a run block');
  const commands = runBlock.replace(/^ {8}/gmu, '').replaceAll('${{ github.action_path }}', root);
  const temporary = mkdtempSync(path.join(tmpdir(), 'open-ocr-action-path-'));
  try {
    const nodeOnly = path.join(temporary, 'node-only');
    mkdirSync(nodeOnly);
    symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
    const outputFor = (searchPath) => {
      const output = path.join(temporary, `output-${Math.random().toString(16).slice(2)}`);
      writeFileSync(output, '');
      const result = spawnSync('/bin/bash', ['-e', '-c', commands], {
        env: { PATH: searchPath, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(output, 'utf8');
    };
    // The test runs on a supported Node.js whose directory also holds npx.
    assert.equal(outputFor(path.dirname(process.execPath)), 'supported=true\n');
    assert.equal(outputFor(nodeOnly), 'supported=false\n');
    assert.equal(outputFor(path.join(temporary, 'empty')), 'supported=false\n');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
