// Checks the container base image's Node.js release. Usage:
//   node scripts/check-container-node.mjs [--image-version <node -p process.version>]
// Fails when the Dockerfile stages do not share one exact, digest-pinned
// node:<version>-<variant> image, or when the built image runs a different
// Node.js than its tag names. Warns (without failing) when a newer security
// release exists on the same major line, so CI surfaces a stale base image.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareVersions } from './release-automation.mjs';

const exactNodeImage = /^node:(\d+\.\d+\.\d+)-([a-z][a-z0-9.-]*)@sha256:([0-9a-f]{64})$/u;

export function dockerfileNodeImage(dockerfile) {
  const images = [...dockerfile.matchAll(/^FROM\s+(\S+)/gmu)].map((match) => match[1]);
  if (images.length === 0) throw new Error('The Dockerfile has no FROM instruction');
  if (new Set(images).size !== 1) throw new Error(`Every Dockerfile stage must use one base image, found ${images.join(', ')}`);
  const match = exactNodeImage.exec(images[0]);
  if (!match) {
    throw new Error(`Base image ${images[0]} must pin an exact node:<version>-<variant>@sha256:<digest>`);
  }
  return { image: images[0], version: match[1], variant: match[2], digest: `sha256:${match[3]}` };
}

/** The newest `security: true` release on a major line of nodejs.org/dist/index.json. */
export function newestSecurityRelease(index, major) {
  let newest;
  for (const release of index) {
    const version = typeof release?.version === 'string' ? release.version.replace(/^v/u, '') : '';
    if (!release?.security || !/^\d+\.\d+\.\d+$/u.test(version) || Number(version.split('.')[0]) !== major) continue;
    if (!newest || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

/** A warning message when `version` predates the newest security release on its line. */
export function securityLag(version, index) {
  const newest = newestSecurityRelease(index, Number(version.split('.')[0]));
  if (!newest || compareVersions(version, newest) >= 0) return undefined;
  return `The container base image runs Node.js ${version}, older than the ${newest} security release; `
    + 'update the Dockerfile tag and digest (or merge the Dependabot docker PR).';
}

async function main() {
  const flag = process.argv.indexOf('--image-version');
  const imageVersion = flag === -1 ? undefined : process.argv[flag + 1];
  const dockerfile = readFileSync(fileURLToPath(new URL('../Dockerfile', import.meta.url)), 'utf8');
  const { image, version } = dockerfileNodeImage(dockerfile);
  if (flag !== -1 && imageVersion !== `v${version}`) {
    throw new Error(`The built image runs Node.js ${imageVersion ?? '(missing)'}, but its base image ${image} names ${version}`);
  }
  process.stdout.write(`Container base image: ${image}\n`);
  let index;
  try {
    const response = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    index = await response.json();
    if (!Array.isArray(index)) throw new Error('unexpected index format');
  } catch (error) {
    process.stdout.write(`::warning::Could not read the Node.js release index to check the base image: ${error.message}\n`);
    return;
  }
  const lag = securityLag(version, index);
  process.stdout.write(lag ? `::warning::${lag}\n` : `Node.js ${version} includes every security release on its line.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
