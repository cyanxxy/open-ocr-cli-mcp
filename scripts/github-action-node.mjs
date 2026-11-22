// action.yml runs `node scripts/github-action-node.mjs --check <manifest>` to
// decide whether the job already has a Node.js the CLI supports. When it does,
// the action skips actions/setup-node: setup-node prepends its toolchain to
// PATH for every later step of the calling job, not just this action.
// Any failure (an old Node.js that cannot parse this module, a missing
// manifest, an unrecognized range) exits non-zero, so the action falls back
// to installing Node.js rather than running on an unsupported one.
import { readFileSync } from 'node:fs';

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(text).trim());
  return match ? match.slice(1, 4).map(Number) : undefined;
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Supports the comparator forms the CLI's engines field uses: `^X.Y.Z` and
 * `>=X.Y.Z` alternatives joined by `||`. An alternative in any other form
 * never matches, so an unfamiliar range can only narrow what is accepted.
 */
export function satisfiesEngineRange(version, range) {
  const actual = parseVersion(version);
  if (!actual || typeof range !== 'string') return false;
  return range.split('||').some((alternative) => {
    const match = /^(\^|>=)(\d+\.\d+\.\d+)$/u.exec(alternative.trim());
    if (!match) return false;
    const minimum = parseVersion(match[2]);
    if (compare(actual, minimum) < 0) return false;
    if (match[1] === '>=') return true;
    return minimum[0] > 0 && actual[0] === minimum[0];
  });
}

if (process.argv[2] === '--check') {
  const manifest = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  process.exit(satisfiesEngineRange(process.versions.node, manifest.engines?.node) ? 0 : 1);
}
