import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { dockerfileNodeImage, newestSecurityRelease, securityLag } from './check-container-node.mjs';

const root = path.resolve(import.meta.dirname, '..');
const digest = `sha256:${'d'.repeat(64)}`;
const index = [
  { version: 'v26.13.1', security: true },
  { version: 'v24.22.4', security: false },
  { version: 'v24.22.3', security: true },
  { version: 'v24.22.1', security: true },
  { version: 'v24.18.1', security: true },
  { version: 'v24.18.0', security: false },
  { version: 'v22.23.5', security: true },
];

test('both Dockerfile stages pin one exact Node.js release by digest', () => {
  const image = dockerfileNodeImage(readFileSync(path.join(root, 'Dockerfile'), 'utf8'));
  assert.match(image.version, /^24\.\d+\.\d+$/u);
  assert.equal(image.variant, 'bookworm-slim');
  assert.match(image.digest, /^sha256:[0-9a-f]{64}$/u);
});

test('floating, unpinned, or diverging base images are rejected', () => {
  const stages = (first, second = first) => `FROM ${first} AS build\nRUN true\nFROM ${second} AS runtime\n`;
  assert.deepEqual(dockerfileNodeImage(stages(`node:24.22.3-bookworm-slim@${digest}`)), {
    image: `node:24.22.3-bookworm-slim@${digest}`, version: '24.22.3', variant: 'bookworm-slim', digest,
  });
  // A floating major tag hides which Node.js release the digest contains.
  assert.throws(() => dockerfileNodeImage(stages(`node:24-bookworm-slim@${digest}`)), /exact/u);
  assert.throws(() => dockerfileNodeImage(stages('node:24.22.3-bookworm-slim')), /exact/u);
  assert.throws(() => dockerfileNodeImage(stages(`node:24.22.3-bookworm-slim@${digest}`, `node:24.22.1-bookworm-slim@${digest}`)), /one base image/u);
  assert.throws(() => dockerfileNodeImage('RUN true\n'), /no FROM/u);
});

test('the base image is compared with the newest security release on its major line', () => {
  assert.equal(newestSecurityRelease(index, 24), '24.22.3');
  assert.equal(newestSecurityRelease(index, 26), '26.13.1');
  assert.equal(newestSecurityRelease(index, 20), undefined);
  assert.match(securityLag('24.18.0', index), /24\.18\.0, older than the 24\.22\.3 security release/u);
  assert.match(securityLag('24.22.1', index), /24\.22\.3/u);
  assert.equal(securityLag('24.22.3', index), undefined);
  assert.equal(securityLag('24.22.4', index), undefined);
  assert.equal(securityLag('20.20.2', index), undefined);
  assert.equal(newestSecurityRelease([null, { version: 'v24.99.0-rc.1', security: true }, ...index], 24), '24.22.3');
});

test('Dependabot keeps npm security-only but proposes Docker base-image updates', () => {
  const config = readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8');
  const blocks = Object.fromEntries(config.split(/^ {2}- package-ecosystem: /mu).slice(1)
    .map((block) => [block.slice(0, block.indexOf('\n')).trim(), block]));
  const limit = (block) => Number(/^ {4}open-pull-requests-limit: (\d+)$/mu.exec(block)?.[1]);
  assert.equal(limit(blocks.npm), 0);
  assert.match(blocks.npm, /applies-to: security-updates/u);
  // Security updates never cover the Node.js or Debian patch level of the base image.
  assert.ok(limit(blocks.docker) >= 1, 'docker base-image updates must stay enabled');
  assert.match(blocks.docker, /dependency-name: node\n\s+update-types:\n\s+- version-update:semver-major/u);
});
