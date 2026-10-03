import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repositoryName = 'cyanxxy/open-ocr-cli-mcp';
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function compareVersions(left, right) {
  if (!stableVersion.test(left) || !stableVersion.test(right)) {
    throw new Error('Release versions must be stable semantic versions.');
  }
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function releaseTagVersion(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v') || !stableVersion.test(tag.slice(1))) {
    throw new Error('Select a stable release tag such as v4.1.0, not a branch or moving major tag.');
  }
  return tag.slice(1);
}

/** Pure selection logic: only successful CI for trusted main pushes can publish. */
export function automaticReleasePlan({ event, repository, headSha, version, previousVersion, tags, tagCommit, tagIsAncestor }) {
  const run = event.workflow_run;
  if (repository !== repositoryName || event.action !== 'completed'
    || run?.name !== 'CI Pipeline' || run.event !== 'push' || run.conclusion !== 'success'
    || run.head_branch !== 'main' || run.head_repository?.full_name !== repository) {
    throw new Error('Automatic releases require successful CI Pipeline push runs on this repository’s main branch.');
  }
  if (!/^[0-9a-f]{40}$/u.test(run.head_sha) || headSha !== run.head_sha) {
    throw new Error('Release checkout must match the successful CI run exactly.');
  }
  compareVersions(version, version);
  const tag = `v${version}`;
  if (tags.includes(tag)) {
    if (tagCommit === headSha) return { tag, sha: headSha, createTag: false };
    if (!tagIsAncestor) throw new Error(`${tag} already points outside this commit’s history; refusing to move it.`);
    return undefined; // An ordinary later main commit with an already released version.
  }
  // Squash/merge commits compare against main's previous version. Do not let a
  // later docs-only push silently choose different bytes for an untagged bump.
  if (compareVersions(version, previousVersion) <= 0) return undefined;
  const newerTag = tags.find((value) => stableVersion.test(value.slice(1))
    && value.startsWith('v') && compareVersions(value.slice(1), version) >= 0);
  if (newerTag) return undefined;
  return { tag, sha: headSha, createTag: true };
}

export async function readJson(url, { token, method = 'GET', body, allowNotFound = false, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404 && allowNotFound) return undefined;
  if (!response.ok) throw new Error(`${method} ${url} failed with HTTP ${response.status}; refusing to assume absence.`);
  return response.status === 204 ? undefined : response.json();
}

export function releaseIsComplete(release) {
  return release?.draft === false && release?.prerelease === false && Boolean(release.published_at);
}

export async function dispatchAutomaticRelease(plan, { repository, api }) {
  if (!plan) return 'No unreleased version bump on this commit.';
  const base = `/repos/${repository}`;
  const release = await api(`${base}/releases/tags/${plan.tag}`, { allowNotFound: true });
  if (releaseIsComplete(release)) return `${plan.tag} is already released.`;
  const runs = await api(`${base}/actions/workflows/release.yml/runs?head_sha=${plan.sha}&per_page=100`);
  if (!Array.isArray(runs?.workflow_runs)) throw new Error('GitHub did not return a workflow run list.');
  if (runs.workflow_runs.some((run) => run.head_sha === plan.sha
    && ['push', 'workflow_dispatch'].includes(run.event) && run.status !== 'completed')) {
    return `${plan.tag} already has a release run queued or in progress.`;
  }
  if (plan.createTag) {
    // Never force or replace a stable tag. A competing creation fails closed.
    await api(`${base}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${plan.tag}`, sha: plan.sha } });
  }
  // GITHUB_TOKEN tag pushes do not trigger workflows; dispatch is an explicit exception.
  // Running at the tag keeps GITHUB_SHA/GITHUB_REF and npm provenance tied to these bytes.
  await api(`${base}/actions/workflows/release.yml/dispatches`, { method: 'POST', body: { ref: plan.tag } });
  return `Dispatched ${plan.tag} at verified CI commit ${plan.sha}.`;
}

export async function npmPublicationState({ version, integrity, request = readJson }) {
  compareVersions(version, version);
  const base = 'https://registry.npmjs.org/open-ocr-cli';
  const published = await request(`${base}/${version}`, { allowNotFound: true });
  if (published && published.dist?.integrity !== integrity) {
    throw new Error(`open-ocr-cli@${version} already exists with different package bytes.`);
  }
  const latest = await request(`${base}/latest`, { allowNotFound: true });
  if (latest && compareVersions(version, latest.version) < 0) {
    throw new Error(`${version} must not be older than npm latest ${latest.version}.`);
  }
  return published !== undefined;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function isAncestor(older, newer) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', older, newer]);
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error('Unable to verify Git commit ancestry.');
  return result.status === 0;
}

function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  const [mode, tarball] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository !== repositoryName) throw new Error('Releases are restricted to the upstream repository.');
  const api = (endpoint, options = {}) => readJson(`https://api.github.com${endpoint}`, {
    ...options, token: process.env.GH_TOKEN,
  });

  if (mode === 'dispatch') {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_run') throw new Error('Expected a workflow_run event.');
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const headSha = git('rev-parse', 'HEAD');
    git('fetch', '--no-tags', 'origin', 'main');
    if (!isAncestor(headSha, 'origin/main')) throw new Error('CI commit is no longer on main.');
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
    const previousVersion = JSON.parse(git('show', 'HEAD^:package.json')).version;
    const tags = git('tag', '--list').split('\n');
    const tag = `v${version}`;
    const tagCommit = tags.includes(tag) ? git('rev-parse', `${tag}^{commit}`) : undefined;
    const plan = automaticReleasePlan({
      event, repository, headSha, version, previousVersion, tags, tagCommit,
      tagIsAncestor: tagCommit ? isAncestor(tagCommit, headSha) : false,
    });
    if (plan) {
      execFileSync(process.execPath, ['scripts/assert-release-version.mjs'], {
        env: { ...process.env, GITHUB_REF_NAME: plan.tag }, stdio: 'inherit',
      });
    }
    process.stdout.write(`${await dispatchAutomaticRelease(plan, { repository, api })}\n`);
  } else if (mode === 'status') {
    releaseTagVersion(process.env.GITHUB_REF_NAME);
    if (process.env.GITHUB_REF_TYPE !== 'tag') throw new Error('Publishing requires a tag ref.');
    const release = await api(`/repos/${repository}/releases/tags/${process.env.GITHUB_REF_NAME}`, { allowNotFound: true });
    output('needed', !releaseIsComplete(release));
  } else if (mode === 'npm-state') {
    const version = releaseTagVersion(process.env.GITHUB_REF_NAME);
    if (!tarball) throw new Error('npm-state requires the verified tarball path.');
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    output('already_published', await npmPublicationState({ version, integrity }));
  } else {
    throw new Error('Expected dispatch, status, or npm-state.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
