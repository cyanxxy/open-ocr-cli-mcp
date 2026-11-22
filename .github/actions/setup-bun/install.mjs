#!/usr/bin/env node
// Install the Bun build pinned in bun.json into <destination>/bin/bun.
// The npm tarball is verified against the pinned sha512 before it is
// unpacked, so a changed or substituted download fails the job.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const pin = JSON.parse(readFileSync(path.join(import.meta.dirname, 'bun.json'), 'utf8'));
const destination = process.argv[2];
if (!destination) throw new Error('usage: install.mjs <destination>');
const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
const platform = `${process.platform}-${arch}`;
const integrity = pin.platforms[platform];
if (!integrity) throw new Error(`No pinned Bun build for ${platform}; add it to bun.json`);

const name = `bun-${platform}`;
const url = `https://registry.npmjs.org/@oven/${name}/-/${name}-${pin.version}.tgz`;
const response = await fetch(url);
if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
if (actual !== integrity) throw new Error(`Integrity mismatch for ${url}: expected ${integrity}, got ${actual}`);

const work = mkdtempSync(path.join(tmpdir(), 'bun-pinned-'));
try {
  const archive = path.join(work, 'bun.tgz');
  writeFileSync(archive, bytes);
  execFileSync('tar', ['-xzf', archive, '-C', work, 'package/bin/bun']);
  mkdirSync(path.join(destination, 'bin'), { recursive: true });
  const target = path.join(destination, 'bin', 'bun');
  renameSync(path.join(work, 'package', 'bin', 'bun'), target);
  chmodSync(target, 0o755);
  process.stdout.write(`Installed Bun ${pin.version} (${pin.build}) for ${platform}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
