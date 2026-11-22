import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (...segments) => readFileSync(path.join(root, ...segments), 'utf8');

// Docker's .dockerignore rules (moby/patternmatcher): patterns are anchored at
// the context root, `**` spans any number of directories, `*` and `?` stay
// within one path segment, a path is excluded when it or any parent directory
// matches, and the last matching rule (including `!` exceptions) wins.
function dockerignoreMatcher(contents) {
  const rules = contents.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const exclude = !line.startsWith('!');
      const pattern = path.posix.normalize((exclude ? line : line.slice(1)).replace(/^\/+/u, ''));
      let source = '';
      for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        if (pattern.startsWith('**/', index)) {
          source += '(?:.*/)?';
          index += 2;
        } else if (pattern.startsWith('**', index)) {
          source += '.*';
          index += 1;
        } else if (character === '*') source += '[^/]*';
        else if (character === '?') source += '[^/]';
        else source += character.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
      }
      return { exclude, regex: new RegExp(`^${source}$`, 'u') };
    });
  return (file) => {
    const segments = file.split('/');
    const candidates = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
    let excluded = false;
    for (const rule of rules) {
      if (candidates.some((candidate) => rule.regex.test(candidate))) excluded = rule.exclude;
    }
    return excluded;
  };
}

test('the Docker build context excludes host installs in every workspace', () => {
  const excluded = dockerignoreMatcher(read('.dockerignore'));
  for (const file of [
    'node_modules/commander/package.json',
    // npm ci leaves nested workspace installs with host-platform native addons.
    'packages/cli/node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node',
    'packages/cli/node_modules/pdfjs-dist/node_modules/@napi-rs/canvas/index.js',
    'packages/engine/node_modules/.package-lock.json',
    'packages/cli/dist/index.js',
    '.git/HEAD',
    'open-ocr-cli-4.4.0.tgz',
  ]) {
    assert.equal(excluded(file), true, `${file} must not be sent to the Docker build`);
  }
  for (const file of [
    'package.json',
    'package-lock.json',
    'packages/cli/package.json',
    'packages/cli/src/index.ts',
    'packages/cli/tsup.config.ts',
    'packages/engine/src/index.ts',
    'scripts/sync-cli-skills.mjs',
    'integrations/open-ocr/skills/open-ocr/SKILL.md',
  ]) {
    assert.equal(excluded(file), false, `${file} is needed by the Docker build`);
  }
});

test('the dockerignore matcher follows Docker anchoring rules', () => {
  const excluded = dockerignoreMatcher('node_modules\n*.log\n**/cache\n!keep/cache\n');
  assert.equal(excluded('node_modules/a.js'), true);
  // A bare name is anchored at the root, which is why nested installs need `**/`.
  assert.equal(excluded('packages/cli/node_modules/a.js'), false);
  assert.equal(excluded('debug.log'), true);
  assert.equal(excluded('logs/debug.log'), false);
  assert.equal(excluded('a/b/cache/file'), true);
  assert.equal(excluded('keep/cache/file'), false);
});

test('CI covers both advertised minimums and the Maintenance and Active LTS lines', () => {
  const workflow = read('.github', 'workflows', 'ci.yml');
  const tests = workflow.slice(workflow.indexOf('\n  test:\n'), workflow.indexOf('\n  build:\n'));
  const matrix = /^ {8}node-version: \[([^\]]+)\]$/mu.exec(tests)?.[1].split(',').map((entry) => entry.trim());
  assert.ok(matrix, 'the test job must declare a node-version matrix');
  const engines = JSON.parse(read('packages', 'cli', 'package.json')).engines.node;
  for (const minimum of engines.matchAll(/\^(\d+\.\d+\.\d+)/gu)) assert.ok(matrix.includes(minimum[1]), minimum[1]);
  // Node 24 has been Maintenance LTS since 2026-10-20; Node 26 Active LTS since 2026-10-28.
  for (const line of ['24.x', '26.x']) assert.ok(matrix.includes(line), line);

  const build = workflow.slice(workflow.indexOf('\n  build:\n'), workflow.indexOf('\n  container:\n'));
  assert.match(build, /^ {4}name: Build Application$/mu);
  for (const [version, label] of [['22.13.0', '22'], ['26.x', '26']]) {
    const setup = build.indexOf(`node-version: '${version}'`);
    const smoke = build.indexOf(`- name: Smoke-test engine-strict CLI installation on Node ${label}\n        run: npm run cli:install-smoke\n`);
    assert.ok(setup !== -1 && smoke > setup, `Build Application must run the packed-install and MCP smoke on Node ${version}`);
  }
});

test('no CI job waits on another, and the checks job runs every check', async () => {
  const workflow = read('.github', 'workflows', 'ci.yml');
  // A `needs` edge puts one job's whole duration in front of another's.
  assert.doesNotMatch(workflow, /^ {4}needs:/mu, 'CI jobs must start in parallel: remove `needs`');
  const checks = workflow.slice(workflow.indexOf('\n  checks:\n'), workflow.indexOf('\n  test:\n'));
  assert.match(checks, /^ {8}run: node scripts\/run-checks\.mjs$/mu, 'the checks job must run every check');
  const { CHECKS } = await import('./run-checks.mjs');
  assert.deepEqual(
    CHECKS.map((check) => check.name),
    ['types', 'lint', 'unused-vars', 'scripts', 'release-notes', 'evals', 'audit'],
    'a check removed from run-checks.mjs must be removed on purpose',
  );
});
