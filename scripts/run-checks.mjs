#!/usr/bin/env node
// Run the repository's small checks concurrently and report every failure.
//
// Each check runs to completion even when another fails, so one CI run lists
// all of them instead of stopping at the first. Output is buffered per check
// and printed whole, failures last, so interleaved logs never hide which
// check said what. Exit status is 1 when any check failed.
//
//   node scripts/run-checks.mjs            run every check
//   node scripts/run-checks.mjs lint types run only the named checks
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(root, 'packages', 'cli', 'package.json'), 'utf8')).version;

/** Every check: a short name and the shell command that runs it from the repository root. */
export const CHECKS = [
  // TypeScript 7 semantics, every project in the root tsconfig references.
  { name: 'types', command: 'bun check -b' },
  // .oxlintrc.json, type-aware (options.typeAware).
  { name: 'lint', command: 'bun lint' },
  // The one ESLint rule bun lint does not fully cover: its no-unused-vars
  // counts `x += 1` as a read, so a variable only ever updated that way is
  // not reported. No type information, so this stays a few seconds.
  { name: 'unused-vars', command: 'npx --no-install eslint -c eslint.unused.config.js .' },
  { name: 'scripts', command: 'node --test scripts/*.test.mjs' },
  {
    name: 'release-notes',
    // The script prefers GITHUB_REF_NAME (a tag in release runs); on a PR that
    // is "<n>/merge", so point it at the version being released.
    command: `GITHUB_REF_NAME=v${version} node scripts/assert-release-version.mjs`
      + ` && node scripts/extract-release-notes.mjs v${version} ${path.join(tmpdir(), `release-notes-${process.pid}.md`)}`,
  },
  { name: 'evals', command: 'npm run -s evals:validate && npm run -s evals:matrix:check' },
  { name: 'audit', command: 'npx --no-install audit-ci --config audit-ci.json' },
];

function run({ name, command }) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => chunks.push(Buffer.from(`${error.stack ?? error}\n`)));
    child.on('close', (code, signal) => resolve({
      name,
      command,
      ok: code === 0,
      code: code ?? signal,
      seconds: (performance.now() - started) / 1000,
      output: Buffer.concat(chunks).toString('utf8'),
    }));
  });
}

async function main() {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((name) => !CHECKS.some((check) => check.name === name));
  if (unknown.length > 0) {
    process.stderr.write(`Unknown check(s): ${unknown.join(', ')}. Known: ${CHECKS.map((check) => check.name).join(', ')}\n`);
    process.exit(2);
  }
  const selected = wanted.length > 0 ? CHECKS.filter((check) => wanted.includes(check.name)) : CHECKS;
  const results = await Promise.all(selected.map(run));
  const failed = results.filter((result) => !result.ok);
  for (const result of [...results.filter((entry) => entry.ok), ...failed]) {
    process.stdout.write(`\n::group::${result.ok ? 'ok  ' : 'FAIL'} ${result.name} (${result.seconds.toFixed(1)}s): ${result.command}\n`);
    process.stdout.write(result.output.endsWith('\n') || result.output === '' ? result.output : `${result.output}\n`);
    process.stdout.write('::endgroup::\n');
  }
  process.stdout.write('\nCheck            Result  Seconds\n');
  for (const result of results) {
    process.stdout.write(`${result.name.padEnd(16)} ${(result.ok ? 'ok' : `FAIL (${result.code})`).padEnd(7)} ${result.seconds.toFixed(1).padStart(7)}\n`);
  }
  if (failed.length > 0) {
    process.stdout.write(`\n${failed.length} of ${results.length} checks failed: ${failed.map((result) => result.name).join(', ')}\n`);
    for (const result of failed) process.stdout.write(`::error title=${result.name} failed::${result.command} exited with ${result.code}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === import.meta.filename) await main();
