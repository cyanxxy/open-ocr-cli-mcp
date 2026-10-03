import { readFileSync } from 'node:fs';

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!tag?.startsWith('v') || tag.length === 1) {
  throw new Error('Release tag must be supplied as v<version>');
}

const expected = tag.slice(1);
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const cliPackage = JSON.parse(readFileSync('packages/cli/package.json', 'utf8'));
const enginePackage = JSON.parse(readFileSync('packages/engine/package.json', 'utf8'));
const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const versions = new Map([
  ['package.json', rootPackage.version],
  ['packages/cli/package.json', cliPackage.version],
  ['packages/engine/package.json', enginePackage.version],
  ['package-lock.json', lockfile.version],
  ['package-lock.json packages[""]', lockfile.packages?.['']?.version],
  ['package-lock.json packages["packages/cli"]', lockfile.packages?.['packages/cli']?.version],
  ['package-lock.json packages["packages/engine"]', lockfile.packages?.['packages/engine']?.version],
  ['packages/cli/package.json devDependencies["@open-ocr/engine"]', cliPackage.devDependencies?.['@open-ocr/engine']],
  ['package-lock.json packages["packages/cli"] devDependencies["@open-ocr/engine"]', lockfile.packages?.['packages/cli']?.devDependencies?.['@open-ocr/engine']],
]);

for (const [source, version] of versions) {
  if (version !== expected) {
    throw new Error(`${source} version ${String(version)} does not match ${tag}`);
  }
}

process.stdout.write(`Release versions match ${tag}\n`);
