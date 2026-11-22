# Codebase and provider audit — 2026-10-03

Scope: every implemented provider profile, shared extraction/agent tools, CLI
input/output/resume behavior, machine schemas, MCP, dependencies, agent setup,
packaging, evaluation tooling, and public documentation. Three parallel agents
performed provider, MCP, and CLI/core reviews, followed by cross-review.

## Verified upstream contracts

| Surface | Verified source and implemented decision |
| --- | --- |
| Gemini | [Model catalog](https://ai.google.dev/gemini-api/docs/models) and [pricing](https://ai.google.dev/gemini-api/docs/pricing): add 3.8/3.7/3.6 Flash and 3.5 Flash-Lite; default to 3.8 Flash; enforce known thinking levels and time-bound published pricing. |
| Kimi | [Models](https://platform.kimi.ai/docs/models), [pricing](https://platform.kimi.ai/docs/pricing/chat), [caching](https://platform.kimi.ai/docs/guide/context-caching): retain K3, K2.7 Code/highspeed, K2.6; distinguish model reasoning controls and direct/router cached pricing. |
| Meta Muse | [Models](https://dev.meta.ai/docs/models), [pricing](https://dev.meta.ai/docs/pricing-rate-limits): add Spark 1.3/1.2; default to Standard 1.3; add known prices and model-specific MAX validation. Contributor variants require a data-sharing choice and are not curated recommendations. |
| OpenRouter | [Published catalog](https://openrouter.ai/api/v1/models) and [reasoning guide](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens): add verified Gemini, Muse, GPT-6, and Claude routes; constrain known model reasoning; preserve actual reported cost. |
| OpenAI-compatible | Endpoint/model-dependent capabilities remain explicit. Require terminal completion evidence; do not apply unrelated named-provider prices to arbitrary model IDs. |
| Cloudflare | Existing native/custom-provider routes and BYOK remain; [authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) and [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) are separate from the upstream model contract. |
| MCP | [Published revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [SDK 2.3.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.0). Keep one modern stdio contract; use SDK lifecycle and real SDK client validation. |
| Claude Code | [MCP runtimes](https://code.claude.com/docs/en/mcp#mcp-client-runtimes): document v2 host runtime and explicit stdio protocol probing. Local installed CLI: 2.1.284; no paid/model session run. |
| Codex | [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [skills](https://learn.chatgpt.com/docs/build-skills): document environment forwarding, cwd, timeouts, and portable CLI/skill routing. Local installed CLI: 0.159.0; exact MCP revision interoperability unverified. |

Model discovery is a curated snapshot, not a claim that every model is available
to every account. `capabilities --json` is the runtime source of truth. Direct
provider and router prices may differ. Google promotional pricing has an
explicit UTC expiry instead of remaining discounted indefinitely.

## Changes

- Add current model IDs/defaults, known reasoning constraints, prices, and
  fail-closed transport completion handling.
- Apply custom token prices to native Gemini usage and isolate request/cost
  accounting per execution, including web extraction and credential probes.
  Preserve typed cost-limit and cancellation errors through URL extraction.
- Preserve stale artifact ownership after failed resume attempts. Reject
  directories, file/parent collisions, and optional-output collisions before
  paid extraction. Resume/status require actual artifact files.
- Isolate custom-schema validators so repeated `$id` values work in long-lived
  MCP processes and schemas can be garbage-collected.
- Upgrade MCP to SDK 2.3.0, bound input complexity, improve cancellation/progress
  handling, and support bounded reading of issued artifact files through
  `ocr_read_artifact` and resources.
- Reject malformed nested template values instead of producing `[object Object]`
  or silently dropping malformed rows.
- Preserve valid lower-confidence field corrections and runtime validation
  feedback. Continue useful same-field refinements, reject invalid confidence,
  and preserve partial output when active agent deadlines expire. Propagate
  region re-OCR cost/cancellation failures and use the selected provider's
  reasoning contract.
- Validate actual calendar dates without locale-dependent parsing; avoid
  rejecting invoice totals when adjustments or item completeness are unknown.
  Treat prototype-named fields as data in schema aliases and memory updates.
- Validate evaluation matrix identifiers before writing reports; forward
  cancellation, join/terminate workers, stop scheduling, and fail missing reports.
- Replace vulnerable glob dependencies with streaming discovery, propagate
  cancellation, bound oversized expansions before MIME inspection, and avoid
  rescanning identical inputs.
- Update vulnerable dependencies; keep the declared Node support range.
- Make source CLI/eval scripts use `node --import tsx`, avoiding an unnecessary
  IPC listener inside restricted agent environments. Isolate smoke-test caches.
- Rename GitHub repository and local remote to `cyanxxy/open-ocr-cli-mcp`;
  update metadata, workflow repository checks, source links, and skill branding.
  The npm package/executable and container package retain their existing names.
- Rewrite both READMEs, separate the detailed CLI reference, and refresh agent
  integration instructions. Ignore default extraction output directories in Git.

## Verification

- All **805 tests in 56 files** pass on Node **20.19.0**, **22.13.0**, and
  **24.19.0**.
- Coverage gate passes: **86.04% statements**, **77.03% branches**,
  **90.85% functions**, **89.10% lines**.
- Full TypeScript checks and ESLint pass with no warnings.
- npm dependency audit reports **zero known vulnerabilities**.
- Evaluation corpus validation passes: **64 cases**, **one suite assertion**;
  provider matrix dry run and release-version consistency checks pass.
- CLI build/help, npm pack dry run, clean tarball installation (including the
  official MCP SDK stdio client), and GitHub Action wrapper smokes pass.
- Local README/documentation links resolve; `git diff --check` is clean.

## Documentation review — second pass, 2026-10-03

Reviewed all 19 repository Markdown documents, including GitHub templates, the
historical evaluation report, the source/generated skill, and ignored local
`AGENTS.md`/`CLAUDE.md`. Compared command examples, settings, output, provider
defaults, MCP metadata, evaluation setup, security guidance, and release steps
against current code and official documentation.

- Correct config/environment precedence, discovery exclusions, transient output
  metadata, artifact pagination (`nextOffset`), previous-process resume access,
  request thinking-level casing, credential defaults, provider routing/retention,
  and current Codex skill locations.
- Fix single-input `extract --jsonl` content loss: use inline content when no
  artifacts are saved and references when output is persisted. Keep explicit
  machine delivery authoritative.
- Isolate evaluation usage per case/repetition, apply Gemini custom prices to
  agent continuations, and reject incomplete, empty, negative, or non-finite
  override rates before provider work.
- Preserve historical quality reports and corpus data; dry runs are not new
  model-quality evidence.

Verification: **820 tests in 57 files** pass on Node **20.19.0**, **22.13.0**, and
**24.19.0**. Typechecking and ESLint pass. Coverage passes at **86.10% statements**,
**77.11% branches**, **90.85% functions**, and **89.16% lines**. Local links resolve
across all 19 documents; complete protocol request examples pass CLI dry runs.
The generated skill is synchronized. CLI build/help, clean tarball installation,
official MCP SDK smoke, corpus validation, matrix dry run, and diff checks pass.

## Release preparation — 4.1.0

- Align all workspace, lockfile, and bundled engine dependency versions.
- Release only the exact successful `main` CI commit that increases the version;
  create an immutable tag and explicitly dispatch publication at that tag.
  Preserve eligible CI runs, queue releases, fail closed on registry errors,
  and keep partial GitHub releases as drafts until all surfaces are complete.
- Remove credential-selector echoes and redact configured API/gateway keys,
  including escaped opaque values, before logging or persisting eval errors.
- Pin PDF.js to Node 20-compatible 5.5.207, outside the
  [affected later 5.x range](https://github.com/advisories/GHSA-hq66-cqwq-w95j).
  Add engine-strict installation and real PDF checks on the minimum runtime.

Verification: 825 unit tests and 11 release-automation tests pass. Coverage passes
at 86.12% statements and 77.16% branches. Full lint,
typechecking, coverage, corpus validation, matrix dry run, pack inspection,
clean Node 20/24 tarball installations, official MCP SDK smokes, and the GitHub
Action wrapper pass. The npm audit reports zero known vulnerabilities. Workflow
lint passes except for the installed linter's outdated schema rejecting the
[documented `queue: max` property](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Limits

Provider behavior uses deterministic fixtures and mocked/local transports;
no billed live OCR or quality benchmark was run. The real MCP SDK client checks
stdio interoperability, not an end-to-end Codex/Claude/Pi model session. The
server is stdio-only, calls block until completion, and Tasks are not implemented.
The audit itself did not publish a package or create a release tag. Publishing
after the repository rename requires npm's trusted publisher to use the new
repository name; see [release setup](releasing.md). The local Docker daemon was
unavailable, so no container build was run locally. Passing checks establishes tested behavior, not
absence of every possible defect.

## Codebase audit, 2026-11-21

Scope: release 4.4.0 as published on 2026-11-01. The audit covered the engine
(provider clients and cost accounting, the Gemini client, agent tools,
templates, eval metrics), the CLI (MCP surface and trust boundary, batch and
resume state, configuration and entry points, machine protocol contracts), the
documentation against upstream sources (Gemini models and pricing, MCP client
behavior in Claude Code and Codex, provider catalogs), and the runtime
dependencies, CI, container, GitHub Action, and Homebrew packaging.

Method: ten scoped auditors, one per area (C1 engine providers, C2 engine
Gemini, C3 engine agent and templates, C4 CLI and MCP surface, C5 CLI batch
state, C6 CLI configuration and entry points, C7 CLI protocol contracts, D1
Gemini documentation, D2 MCP and provider documentation, D3 runtime,
dependencies, and CI). Each finding came with evidence and a concrete failure
scenario. An adversarial verifier per area then tried to refute every finding
with its own reproduction (scripts against the real SDKs and local HTTP
servers, upstream documentation fetched on 2026-11-21) and gave a verdict, a
severity, and the fix to implement, including its regression test. The fixes
were then made in parallel lanes (engine providers and Gemini, engine agent
and templates, CLI batch and MCP, CLI configuration, web, and boundary,
tooling and release, documentation). Each fix comes with a regression test
written to fail without it, except documentation-only items.

Results: **73 findings**. **69 confirmed**, **1 uncertain** (C1-3, fixed
together with D2-1), and **3 refuted** (C4-11, C6-2, D1-3). Of the 70 kept,
**3 are high** (C4-1, C6-1, D3-1), **28 medium**, and **39 low**.

### Fixed

The user-visible changes are listed under "Unreleased" in the
[changelog](../CHANGELOG.md). In short:

- Security: configuration layers no longer carry an operator's endpoint and
  key variable across a provider switch (C6-1); the MCP glob `..` guard works
  on the compiled pattern and outside matches are not named (C4-2); Windows
  UNC paths are refused before any filesystem call (C4-8); the confirmation
  prompt cannot be forged through the model ID (C4-9); IPv4-compatible IPv6
  literals are not public (C1-5); ambient Google SDK variables cannot reroute
  Gemini traffic (C2-4, D1-2); hostile pages, a FIFO `.env`, endless redirect
  bodies, and huge PDF pages can no longer stall or exhaust the server (C4-3,
  C6-3, C4-6, C4-7); model text is escaped in template Markdown (C3-5); the
  container follows Node.js 24 security releases (D3-3).
- Cost and retries: OpenRouter BYOK, Gemini URL-context tokens, and failed
  streams are counted (C1-1, C2-1, C1-4); unmetered paid usage keeps a capped
  resume closed and spend is persisted per response (C5-1, C5-5); Node.js
  fetch's 300-second timeouts no longer cut and re-bill requests (C1-2); the
  Interactions SDK's hidden retries are off and `RetryInfo` is kept (C2-2,
  C2-3); engine errors are classified by type (C2-5).
- Providers and models: OpenRouter reasoning is sent to unlisted routes only
  when chosen (C1-3, D2-1); Gemini 4 Carbon, Hydrogen, and Neon with `xhigh`
  (D1-1); Claude Fable 5.2 on OpenRouter (D2-5); streamed truncation and
  `CONTINUATION` stops are reported accurately (D2-2, D1-4).
- Web: host-name URLs work for non-Gemini providers (C4-1); SVG text, cut-off
  bodies, and typed transport errors (C4-4, C4-5, C4-10); URL requests ignore
  extract-only configuration (C7-3).
- Batches: durable writes and recovery from an unreadable manifest (C5-2),
  retired Gemini models in `status` (C5-3), old agent-instruction artifact
  names (C5-4), cancellation while hashing (C5-6), HEVC-branded `.heif`
  (C5-7).
- Agentic and templates: field merging, aliases, dates, amounts, signs,
  document labels, field-name checks, region keys, re-OCR locations, page
  count, and preset validation (C3-1 to C3-11); region crops no longer crash
  on PDF images or blank JPEG 2000 images (D3-1, D3-5); linear-time Markdown
  normalization (C2-6).
- Configuration and CLI: `.env` guidance, empty environment values, blank
  numeric flags, `run --no-config`, and interactive cancellation and defaults
  (C6-4 to C6-8); non-empty error messages and `INTERNAL` self-validation
  failures (C7-1); per-item validation messages (C7-2); the documented schema
  subset (C7-4).
- Evals: CER and table-cell F1 scoring, invalid character references, and
  unscorable cases (C3-12 to C3-15).
- Distribution: the Homebrew formula (D3-2), Node.js 26 in CI (D3-4, the
  non-breaking part), the Docker build context (D3-6), and the GitHub Action's
  Node.js (D3-7).
- Documentation: Claude Code's 7-day stdio probe skip and the
  `MCP_PROTOCOL_NEGOTIATION=auto` remedy, consistent across the README, the
  agent guide, and the skill (C7-5, D2-3).

C4-2 is closed twice: the compiled-pattern check refuses every known spelling
of `..`, and discovery hands every match to the MCP boundary check before it
stats or opens any of them, so an unknown spelling still cannot read an
outside file. One fix is partial on purpose. C4-8 refuses foreign UNC and
device paths on Windows only; a general lexical pre-check before `realpath`
would break the documented acceptance of absolute globs through a
symbolic-link alias of the working directory.

An independent review of the change set found four defects it had introduced,
all fixed with regression tests: the batch field review depended on the order
of the batch (now reviewed to a fixed point against the whole batch); evals
did not mark an `OPEN_OCR_THINKING` level as explicit; `doctor` and `init`
credential probes had no deadline once undici's 300 s defaults were removed
(now 60 s); and current `<name>.steps.*` artifacts were mistaken for the
4.3.0 instruction-file layout and never resumed.

### Deferred

- Dropping Node.js 20, which reached end of life on 2026-04-30, is a
  semver-major change left for 5.0.0. It blocks the dependency majors that
  need Node.js 22 or later: `@google/genai` 3.x, `pdfjs-dist` 6.x,
  `commander` 15, `vitest` 5, `tsup` 9, and TypeScript 7. Node.js 26 is now
  tested in CI; `engines` is unchanged.
- Meta Muse Ember (`muse-ember-1.0`) is not added: it had no first-party price
  source, because Meta's model and pricing pages could not be reached.
- Refuted, no change: C4-11 (MCP 2026-07-28 requires only `-32602` for a
  missing resource; `data.uri` comes from a non-normative example), C6-2 (a
  project that can set `output` can commit those files directly, and `.git`
  stays refused), and D1-3 (`^2.32.0` cannot resolve to `@google/genai` 3.x,
  and the D1-2 fix already pins `apiVersion`).
- Known gaps left open: `interactive` always passes the chosen `--thinking`,
  so it counts as explicit on an unlisted OpenRouter route; `evals/run.ts`
  does not pass a page count, so agentic eval artifacts still report 1; the
  Dockerfile comments naming the Node.js version are not updated by
  Dependabot. With `OPEN_OCR_MCP_CONFIRM=1`, a request that would send
  nothing runs without a prompt, so a file added to the folder between the
  plan and that run is sent unasked; only someone who can already write to
  the folder can do that, within milliseconds.

### Limits

No live provider request was made: provider behavior was checked with
fixtures, mocked transports, and the real SDKs against local HTTP servers. No
live Claude Code or Codex session was run. Docker builds and GitHub Actions
workflows were not run locally; their changes are covered by static tests and
local equivalents of the smoke steps. The Gemini 4 prices come from secondary
sources because ai.google.dev could not be reached, and the OpenRouter catalog
could not be reached either, so the Claude Fable 5.2 effort contract follows
Fable 5.1's, its fallback price is Anthropic's list price, and the new
`google/gemini-4-*` OpenRouter suggestions are not confirmed against that
catalog. Passing checks
establish tested behavior, not the absence of every defect.

Verification: all **1429 tests in 79 files** pass on Node **22.23.5** (the
1416-test set before the review fixes also passed on **20.19.0**); 10 of the
79 test files are new. Coverage passes its gate at **89.12% statements**,
**81.83% branches**, **93.09% functions**, and **92.10% lines** (thresholds
83 / 74 / 89 / 87). Full
TypeScript checks and ESLint pass with no warnings. The **26 release and
packaging script tests** in 5 files pass on Node 22.23.5 and 20.19.0 (and on
26.13.1 in the tooling lane). Evaluation corpus validation passes (**24
cases**, one suite assertion), as does the provider matrix dry run. The CLI
build, `--help`, and `capabilities --json` pass. The engine-strict packed
tarball installation, including the official MCP SDK stdio smoke, passes on
Node 22.23.5 and 20.19.0. Release-version consistency and release-note
extraction pass for v4.4.0. The npm audit reports zero known vulnerabilities,
`npm ls` reports a consistent tree, and `git diff --check` is clean.
