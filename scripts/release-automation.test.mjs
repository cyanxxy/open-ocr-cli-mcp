import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  automaticReleasePlan,
  compareVersions,
  dispatchAutomaticRelease,
  npmPublicationState,
  readJson,
  releaseIsComplete,
  releaseTagVersion,
} from './release-automation.mjs';

const repository = 'cyanxxy/open-ocr-cli-mcp';
const sha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);
function candidate(overrides = {}) {
  return {
    repository, headSha: sha, version: '4.1.0', previousVersion: '4.0.0', tags: ['v4', 'v4.0.0'],
    event: {
      action: 'completed',
      workflow_run: {
        name: 'CI Pipeline', event: 'push', conclusion: 'success', head_branch: 'main',
        head_sha: sha, head_repository: { full_name: repository },
      },
    },
    ...overrides,
  };
}

test('only exact successful upstream main CI can select an automatic release', () => {
  assert.deepEqual(automaticReleasePlan(candidate()), { tag: 'v4.1.0', sha, createTag: true });
  for (const field of [
    { event: 'pull_request' }, { event: 'merge_group' }, { conclusion: 'failure' },
    { conclusion: 'cancelled' }, { head_branch: 'feature' }, { name: 'Other CI' },
    { head_repository: { full_name: 'attacker/fork' } }, { head_sha: oldSha },
  ]) {
    const input = candidate();
    Object.assign(input.event.workflow_run, field);
    assert.throws(() => automaticReleasePlan(input));
  }
  assert.throws(() => automaticReleasePlan(candidate({ repository: 'attacker/fork' })));
  const requested = candidate();
  requested.event.action = 'requested';
  assert.throws(() => automaticReleasePlan(requested));
});

test('only version-increasing commits create tags, including merge/squash bumps', () => {
  assert.equal(automaticReleasePlan(candidate({ previousVersion: '4.1.0' })), undefined);
  assert.equal(automaticReleasePlan(candidate({ previousVersion: '4.2.0' })), undefined);
  assert.equal(automaticReleasePlan(candidate({ tags: ['v4.2.0'] })), undefined);
  assert.throws(() => automaticReleasePlan(candidate({ version: '4.1.0-rc.1' })));
});

test('an existing exact tag is retryable, a later commit is a no-op, and divergent tags fail', () => {
  const tagged = { tags: ['v4.0.0', 'v4.1.0'], tagCommit: sha, previousVersion: '4.1.0' };
  assert.deepEqual(automaticReleasePlan(candidate(tagged)), { tag: 'v4.1.0', sha, createTag: false });
  assert.equal(automaticReleasePlan(candidate({ ...tagged, tagCommit: oldSha, tagIsAncestor: true })), undefined);
  assert.throws(() => automaticReleasePlan(candidate({ ...tagged, tagCommit: oldSha, tagIsAncestor: false })), /refusing to move/u);
});

test('stable versions and release refs are validated without lexical ordering or integer rounding', () => {
  assert.equal(compareVersions('4.10.0', '4.9.9'), 1);
  assert.equal(compareVersions('4.1.0', '4.1.0'), 0);
  assert.equal(compareVersions('4.1.0', '5.0.0'), -1);
  assert.equal(releaseTagVersion('v4.1.0'), '4.1.0');
  for (const invalid of ['main', 'v4', 'v4.01.0', 'v4.1.0-beta', 'v4.1.0\n', undefined]) {
    assert.throws(() => releaseTagVersion(invalid));
  }
});

test('automatic tag creation explicitly dispatches at that tag, never at main', async () => {
  const calls = [];
  const api = async (endpoint, options) => {
    calls.push({ endpoint, ...options });
    if (endpoint.includes('/runs?')) return { workflow_runs: [] };
    return undefined;
  };
  await dispatchAutomaticRelease({ tag: 'v4.1.0', sha, createTag: true }, { repository, api });
  assert.deepEqual(calls.slice(2), [
    { endpoint: `/repos/${repository}/git/refs`, method: 'POST', body: { ref: 'refs/tags/v4.1.0', sha } },
    { endpoint: `/repos/${repository}/actions/workflows/release.yml/dispatches`, method: 'POST', body: { ref: 'v4.1.0' } },
  ]);
});

test('a dispatch failure can retry an existing tag without replacing it', async () => {
  const calls = [];
  const api = async (endpoint, options) => {
    calls.push({ endpoint, ...options });
    if (endpoint.includes('/runs?')) return { workflow_runs: [] };
    return undefined;
  };
  await dispatchAutomaticRelease({ tag: 'v4.1.0', sha, createTag: false }, { repository, api });
  assert.equal(calls.length, 3);
  assert.ok(calls[2].endpoint.endsWith('/dispatches'));
  assert.ok(!calls.some((call) => call.endpoint.endsWith('/git/refs')));
});

test('completed releases and active tag runs suppress duplicate dispatches', async () => {
  const completed = { draft: false, prerelease: false, published_at: '2026-10-03T00:00:00Z' };
  assert.equal(releaseIsComplete(completed), true);
  assert.equal(releaseIsComplete({ ...completed, draft: true }), false);
  assert.equal(releaseIsComplete(undefined), false);
  for (const finished of [true, false]) {
    const calls = [];
    await dispatchAutomaticRelease({ tag: 'v4.1.0', sha, createTag: false }, {
      repository,
      api: async (endpoint, options) => {
        calls.push({ endpoint, ...options });
        if (endpoint.includes('/runs?')) return { workflow_runs: [{ head_sha: sha, event: 'workflow_dispatch', status: 'queued' }] };
        return finished ? completed : undefined;
      },
    });
    assert.equal(calls.length, finished ? 1 : 2);
    assert.ok(calls.every((call) => !call.method));
  }
});

test('draft releases and completed failed attempts remain retryable', async () => {
  const calls = [];
  await dispatchAutomaticRelease({ tag: 'v4.1.0', sha, createTag: false }, {
    repository,
    api: async (endpoint, options) => {
      calls.push({ endpoint, ...options });
      if (endpoint.includes('/runs?')) return { workflow_runs: [
        { head_sha: sha, event: 'workflow_dispatch', status: 'completed', conclusion: 'failure' },
        { head_sha: sha, event: 'workflow_run', status: 'in_progress' },
        { head_sha: oldSha, event: 'push', status: 'queued' },
      ] };
      return { draft: true };
    },
  });
  assert.ok(calls.at(-1).endpoint.endsWith('/dispatches'));
});

test('failed tag creation never dispatches a potentially unrelated tag', async () => {
  const calls = [];
  await assert.rejects(dispatchAutomaticRelease({ tag: 'v4.1.0', sha, createTag: true }, {
    repository,
    api: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint.endsWith('/git/refs')) throw new Error('Tag creation conflict');
      return endpoint.includes('/runs?') ? { workflow_runs: [] } : undefined;
    },
  }), /Tag creation conflict/u);
  assert.ok(!calls.some((endpoint) => endpoint.endsWith('/dispatches')));
});

test('only explicit HTTP 404 is absence; auth, rate-limit and network errors fail closed', async () => {
  const fetchStatus = (status) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => ({ ok: true }) });
  assert.equal(await readJson('https://example.invalid', { allowNotFound: true, fetchImpl: fetchStatus(404) }), undefined);
  assert.equal(await readJson('https://example.invalid', { fetchImpl: fetchStatus(204) }), undefined);
  assert.deepEqual(await readJson('https://example.invalid', { fetchImpl: fetchStatus(200) }), { ok: true });
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(readJson('https://example.invalid', { allowNotFound: true, fetchImpl: fetchStatus(status) }), /refusing to assume absence/u);
  }
  await assert.rejects(readJson('https://example.invalid', { fetchImpl: fetchStatus(404) }));
  await assert.rejects(readJson('https://example.invalid', { fetchImpl: async () => { throw new Error('Network unavailable'); } }), /Network unavailable/u);
});

test('npm retries require exact bytes and never roll latest backwards', async () => {
  const options = { version: '4.1.0', integrity: 'sha512-current' };
  const registry = (published, latest) => async (url) => url.endsWith('/latest') ? latest : published;
  assert.equal(await npmPublicationState({ ...options, request: registry(undefined, { version: '4.0.0' }) }), false);
  assert.equal(await npmPublicationState({ ...options, request: registry({ dist: { integrity: options.integrity } }, { version: '4.1.0' }) }), true);
  await assert.rejects(npmPublicationState({ ...options, request: registry({ dist: { integrity: 'sha512-other' } }, undefined) }), /different package bytes/u);
  await assert.rejects(npmPublicationState({ ...options, request: registry(undefined, { version: '4.2.0' }) }), /older than npm latest/u);
  await assert.rejects(npmPublicationState({ ...options, request: registry(undefined, { version: '4.2.0-beta' }) }), /stable semantic/u);
  await assert.rejects(npmPublicationState({ ...options, request: async () => { throw new Error('Registry outage'); } }), /Registry outage/u);
});
