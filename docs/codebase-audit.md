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
- Pin PDF.js to Node 20-compatible 5.5.207, outside the
  [affected later 5.x range](https://github.com/advisories/GHSA-hq66-cqwq-w95j).
  Add engine-strict installation and real PDF checks on the minimum runtime.

Verification: 820 unit tests and 11 release-automation tests pass. Full lint,
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
