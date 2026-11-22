# CLI reference

The npm package and executable are `open-ocr-cli`. Run any command with `--help`
for flags. Use `capabilities --json` for provider/model limits and
`schema request|result|event|error|capabilities` for the exact machine contracts.
Bundled schemas use Draft 2020-12; their `$id` values are identifiers, not URLs
to fetch. Protocol **v2** is the sole supported machine contract.

## Commands and modes

| Command | Purpose |
| --- | --- |
| `extract <inputs...>` | Local files, directories, quoted globs, or binary stdin (`-`) |
| `web [urls...]` | Public URLs or `--file <path>` URL list; individual, combined, or comparison analysis |
| `run --request <file>` | Validated machine request; JSON result or JSONL events |
| `mcp` | Stdio MCP server; see [agent setup](agent-integrations.md) |
| `capabilities`, `schema` | Discover contracts and limits |
| `models`, `providers`, `presets` | Discover supported extraction choices |
| `init`, `interactive` | Explicit guided setup/extraction |
| `doctor --json` | Diagnose runtime/configuration; add `--check-credentials` to probe the provider |
| `status [output] --json` | Audit batch summaries and artifact presence |

`simple` is the default. A preset selects `template` mode. Use `agentic` for
iterative tool calls and region re-OCR; it may issue several billed requests.
Custom JSON schemas require simple mode, JSON output, and no preset. Schemas
are checked before credentials: 1 MB maximum, depth 32, portable keyword subset,
local `$ref` only (JSON Pointer or `$anchor`). Valid uses of the subset such as
an open `prefixItems` tuple, `anyOf` branches that only add `required`, or
`minimum` without `type` are accepted. A `$ref` that leads back to a schema
already applying to the same value (`{"$ref": "#"}` at the root) is refused as
`SCHEMA_INVALID`; recursion through `properties` or `items` is fine. Returned
values must validate against the original schema.
Start with [invoice.schema.json](../examples/invoice.schema.json).

## Provider selection

```bash
open-ocr-cli extract scan.png --provider kimi
open-ocr-cli extract scan.png --provider muse
open-ocr-cli extract scan.png --provider openrouter --model anthropic/claude-sonnet-5.5
open-ocr-cli extract scan.png --provider openai-compatible \
  --base-url http://localhost:11434/v1 --model your-vision-model
```

| Profile | Credential variable | Documents |
| --- | --- | --- |
| `gemini` | `GEMINI_API_KEY` | PNG, JPEG, WebP, HEIC/HEIF; native PDFs |
| `kimi` | `MOONSHOT_API_KEY` | PNG, JPEG, WebP, GIF, HEIC/HEIF; PDF text via file extraction |
| `muse` | `META_API_KEY` | PNG, JPEG, WebP, GIF; native PDFs |
| `openrouter` | `OPENROUTER_API_KEY` | PNG, JPEG, WebP, GIF; PDFs/tools/schema depend on model |
| `openai-compatible` | `OPEN_OCR_API_KEY` | Images depend on endpoint; PDFs rejected locally |

Use `--api-key-env NAME` to choose the credential variable. Never pass the
secret itself. `models --provider <id>` lists current recommended IDs;
non-Gemini profiles also accept upstream IDs. The capabilities
response publishes known per-model thinking levels and defaults. Omit
`--thinking` to use the selected model's default. A dry run verifies local
constraints; it cannot prove upstream access or support for an arbitrary model.
The compatible profile requires `--model` and defaults to
`http://localhost:11434/v1`; local endpoints do not require an API key.

| Gemini model | `--thinking` levels | Default |
| --- | --- | --- |
| `gemini-3.8-flash` (default), `gemini-4-argon`, `gemini-4-carbon` | `low`, `medium`, `high` | `medium` |
| `gemini-4-hydrogen`, `gemini-4-neon` | `low`, `medium`, `high`, `xhigh` | `high` |
| `gemini-3.5-flash-lite` | `minimal`, `low`, `medium`, `high` | `minimal` |

The same levels apply to these models' `google/` routes on OpenRouter. `xhigh`
is accepted wherever a model's known levels include it (Gemini 4 Hydrogen and
Neon, the Muse models), and on Muse and OpenRouter models without a known
contract. Built-in prices for Gemini 4 Carbon, Hydrogen, and Neon were checked
on 2026-11-21 against secondary sources (Google's pricing page could not be
reached); Carbon's rates double on 2026-12-01 (UTC), like Argon's.

An OpenRouter route with no known reasoning contract (a model outside
`models --provider openrouter`, other than `moonshotai/kimi-k3*`) is sent a
`reasoning` parameter only when a level was chosen: `--thinking` (or a
request's `extraction.thinking`), `OPEN_OCR_THINKING`, or a config-file
`thinking` written for that provider and model. Otherwise the route keeps its
own default, and a schema, preset, or agentic request (which requires every
parameter to be supported) can still route to an endpoint that does not reason.
`init --yes` leaves `thinking` unset for such a route, and `interactive`
always passes the level you pick.

Cloudflare AI Gateway is a route, selected with `--gateway cloudflare`. Set
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID`. Authenticated gateways
also use `CLOUDFLARE_AI_GATEWAY_TOKEN`. Kimi, Muse, and generic endpoints need
`--cloudflare-provider <custom-provider-slug>`; Gemini/OpenRouter use native
routes. `--cloudflare-byok` uses a provider credential stored at Cloudflare
and requires gateway authentication. `--cloudflare-byok-alias` selects a stored
key. See [Cloudflare authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
and [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/).

## Configuration

Precedence, lowest to highest: user config
`~/.config/open-ocr-cli/config.json`, project `.open-ocr-cli.json`, explicit
`--config`, supported environment overrides, CLI flags. Repeated `exclude` and
`instructions` values from config and flags are appended.

Config files are layered key by key, except where a higher file switches what
the lower one's settings were written for. A higher file that sets another
`provider` drops the lower files' `model`, `thinking`, `baseUrl`, `apiKeyEnv`,
`cloudflareProvider`, `cloudflareByok`, `cloudflareByokAlias`, `maxTokens`, and
prices, so a project that switches to Kimi uses Kimi's endpoint and
`MOONSHOT_API_KEY`, never the user config's Gemini endpoint and key variable.
Another `gateway` drops `baseUrl` and the BYOK keys; another `model` drops
`thinking`, `maxTokens`, and prices. Gateway account settings and every other
key are still inherited. `init` says which endpoint and key variable a new
project config will use.

A config-file `maxTokens` applies to simple and agentic runs only. Template
mode keeps its 16384-token default unless `--max-tokens` (or a request's
`extraction.maxTokens`) sets it, so a small budget configured for simple runs
never caps preset extraction.

Environment overrides: `OPEN_OCR_PROVIDER`, `OPEN_OCR_GATEWAY`, `OPEN_OCR_MODEL`,
`OPEN_OCR_THINKING`. `OPEN_OCR_MODEL` and `OPEN_OCR_THINKING` belong to the
ambient provider and are dropped when `--provider` selects a different one;
`interactive` follows the same rule. A variable that is exported but empty
(these four, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`) counts as
unset, and a blank numeric flag such as `--retries ""` fails with
`CONFIG_INVALID` instead of reading as 0. A model ID longer than 256
characters, or one holding a control, line-separator, or
bidirectional-formatting character, is refused from any source.
Configure credentials with `apiKeyEnv`, the environment variable name. Raw key
fields and other unknown config keys are warned about and ignored.

A project is untrusted input: `.open-ocr-cli.json` cannot set `baseUrl`,
`apiKeyEnv`, a non-`direct` `gateway`, any `cloudflare*` key, or `overwrite`,
and its `output` must resolve (symbolic links included) inside the project and
outside `.git`; otherwise the run fails with `CONFIG_INVALID`. A project `.env`
is read per run, never installed into the process environment, and supplies only the default
credential variables (`GEMINI_API_KEY`, `MOONSHOT_API_KEY`, `META_API_KEY`,
`OPENROUTER_API_KEY`, `OPEN_OCR_API_KEY`, `CLOUDFLARE_AI_GATEWAY_TOKEN`); a
missing-key message suggests the project `.env` only for those names. A `.env`
that is not a regular file (a FIFO, a device, a directory) is skipped with a
warning and never read, and one over 1 MB fails with `CONFIG_INVALID`. Put
routing in the user config, an explicit `--config` file, or flags. `--no-config` or protocol
`noConfig: true` skips config files and `.env` and cannot be combined with an
explicit config path; `run --no-config` refuses a request that names
`configPath`. `OPEN_OCR_NO_CONFIG=1` skips ambient config and `.env`,
but still allows an explicit `--config` or protocol `configPath` to load that
one file. Ambient environment overrides still apply; set explicit options and
forward a controlled environment for reproducible runs. Over MCP the caller's
`configPath` follows the project rules for routing keys and must sit inside
the server working directory; see
[agent integrations](agent-integrations.md#trust-boundary).

`init` writes project config by default, using the provider's default endpoint
and key variable; `--global` writes user config and is required for a custom
endpoint, key variable, or gateway.
Writes are atomic with mode `0600`; replacement requires confirmation or
`--force`. `--yes` accepts setup defaults; `--skip-validation` avoids a provider
credential check. No-argument invocation prints help without prompting.

## Discovery and limits

Directories are recursive. Hidden paths and `node_modules`, `dist`, `build`,
`vendor`, and `target` subtrees are skipped by default. Warnings count skipped
unsupported files and default-excluded directories, not hidden or custom-excluded
paths. `--hidden` includes hidden paths; `--exclude <glob>` adds exclusions.
An exclude pattern is matched relative to the working directory for every
input, and additionally relative to a scanned folder (so `--exclude 'drafts/**'`
with input `docs` keeps working); an exclude that matched nothing is reported
as a `Discovery:` warning. Explicitly named files are never excluded.
Use `--no-default-excludes`, explicitly name a default-excluded directory, or
use a quoted glob to include those trees. Hidden/custom exclusions still apply
to directory and glob discovery. Discovery does not follow symlinks encountered
while walking; inputs that resolve to the same file (a named symlink and its
target) are extracted once, with a warning. Quote globs to let the CLI expand them.

Images: **70 MB raw**; a `.heif` file whose brands name an HEVC codec (as most
encoders write them) is accepted as HEIF. PDFs: **50 MB, 1,000 pages**.
Default batch limits: **1,000 files / 5,120 MB**, concurrency **2** (range **1–16**). Formats accepted
by a provider may be narrower than discovery. Video is not an OCR input.

URLs: Gemini reads pages through its URL-context tool, whose page tokens are
priced as input. Other providers get each page fetched locally from public
addresses only (every redirect is checked again, and IPv4-compatible IPv6
literals such as `[::127.0.0.1]` count as private), with at most 5 redirects
and 10 MB, within a 120-second deadline. HTML, XML, and SVG are converted to
text on a worker thread with a 15-second budget; an SVG document keeps its
title, description, and text elements. A page too large or too deeply nested
to convert, a host that does not resolve, or a TLS failure fails as
non-retryable `INPUT_INVALID`; a reset, refused, or cut-off connection is a
retryable `INPUT_INVALID`.

`--requests-per-minute` spaces request starts evenly, including agent
continuations. `--max-cost` stops future requests once recorded estimates reach
the budget; in-flight requests can exceed it. In an output directory with a
resume manifest the budget is **cumulative**: it covers the spend recorded by
every resumed run of that directory, so rerunning a cost-limited batch with the
same `--max-cost` resumes finished documents and starts no new paid work (raise
the cap to continue). `--overwrite` and `--no-resume` start a fresh total.
Under `--max-cost`, spend is written to the manifest as each paid response
arrives (at most about a second of it is lost to a `SIGKILL`), not only when a
document finishes. The fail-closed rule for responses without usage (below)
carries over too: once a run in the directory sent a paid request that
reported no usage, a capped rerun starts no new paid work, and raising
`--max-cost` cannot reopen it; rerun with `--overwrite` to start a new total,
or without `--max-cost`. Known models use paid-tier token estimates; OpenRouter
reports cost when available. With OpenRouter BYOK, the upstream inference cost
it reports is added to its own fee, and a BYOK response that reports no
upstream cost is counted at the fee plus the local estimate. For other
providers, unknown prices require both `--input-price` and `--output-price` when enforcing a cost
limit. Cached-input rates and provider-reported cache usage are included where
available. `usage.requests` counts every HTTP attempt, including failed and
retried ones. A response that carries no token usage is counted in
`usage.unreportedUsageRequests` with a warning, and so is a stream that
started generating and then failed or was cut off before its usage arrived;
under `--max-cost` with non-zero prices the run fails closed: no further paid
documents start, the rest are skipped as `COST_LIMIT`, and the exit code is 1.

Retries (`--retries`, simple and template modes) wait for the provider's
`Retry-After` (seconds or HTTP-date, also Gemini `RetryInfo`) on 429/503, capped
at 60 s, instead of the jittered backoff; a requested wait that does not fit in
the remaining `--timeout` fails the document at once with the provider error.
Out-of-quota and out-of-credit responses (OpenAI `insufficient_quota`, billing
limits, HTTP 402, Gemini per-day or zero-limit quotas) are never retried.
Model output that breaks the requested shape (`OUTPUT_INVALID`) is retried on
every provider; the engine's own errors are classified by their type, never by
digits in their message. Gemini Interactions requests (agentic and web runs)
are sent once per attempt, without the SDK's hidden retries, and keep the
server's `RetryInfo` delay.
`--timeout` is one budget for the document, shared by all of its attempts; an
attempt is never cut short and re-sent while the provider may still be working
on it, because that would bill the same work twice. Node.js's own 300-second
fetch header and body timeouts are turned off, so a slow non-streaming request
runs until `--timeout`, and a local transport timeout is never retried.

## Output and resume

Artifact names never match files coding agents load as instructions or tools
load as configuration. An input named `CLAUDE.png` (or `AGENTS`, `GEMINI`,
`copilot-instructions`, and similar) is written as `CLAUDE.ocr.md`. No
directory or file name in the output tree starts with a dot: every hidden
segment of the input path gains a leading `_`, so `.claude/x.png` is written
under `_.claude/`, `.devcontainer/devcontainer.png` as
`_.devcontainer/devcontainer.json`, and `.mcp.png` as `_.mcp.json` rather than a
project MCP configuration. This applies to every run, CLI and MCP alike. A
resumed entry whose recorded artifact still has a hidden name or an agent
instruction name such as `CLAUDE.md` (written by 4.3.0 or earlier) is
re-extracted into the new layout. Extracted text is untrusted document
content.

Single-file `extract` normally prints content to stdout. `--output` or
`--format all` writes artifacts; batch `extract` defaults to `./open-ocr-output`.
Machine/MCP reference jobs default to `.open-ocr-results/<runId>`.

Directories with resume metadata contain `.open-ocr-manifest.json` and
`batch-summary.json`; `.open-ocr.lock` marks the directory's owning process. A
lock left by a dead process on the same host — or one whose PID now belongs to
a different process (checked against the recorded process start time) — is
reclaimed automatically with a warning, so `--force-unlock` is accepted but no
longer needed; a live, cross-host, or unreadable lock is an `OUTPUT_CONFLICT`.
Concurrent reclaimers of one stale lock get exactly one winner; the others
report `OUTPUT_CONFLICT`.

Resume is crash-safe. Before any artifact is committed, one manifest write
records a `pending` claim for every document the run will extract, naming
every path each may write, and the manifest itself is replaced atomically.
Finished documents are then recorded at least once a second and when the run
ends, so a large batch rewrites the manifest a handful of times rather than
twice per document; a claim for a document the run never started (fail-fast,
cost limit, cancellation) is withdrawn when it ends. A run killed at any point
(including `SIGKILL`) therefore leaves only files the next run recognises as
its own: it re-extracts the interrupted documents (at most the last second's
finished documents are extracted again), removes leftover
`<artifact>.<pid>-<uuid>.tmp` staging files, and puts back any `.bak` an
interrupted replacement had moved aside. Cleanup runs under the batch lock, so
a leftover last modified before the lock was taken is removed even when its
embedded PID now belongs to another live process. Each entry also keeps every artifact
path it has ever written, so switching `--format` back and forth reuses the
directory without conflicts. Resume compares a streamed SHA-256 of each input
(plus path, size, and output-affecting settings), not its mtime: a content
change that preserves size and mtime is re-extracted, and a touch that changes
nothing is not. Entries written by 4.3.0 and earlier (size/mtime fingerprints)
are trusted once and upgraded. Cancelling during that hashing pass stops it at
once and writes no claims. Every manifest, summary, lock, and artifact write is
flushed to disk (`fsync`) before it replaces the old file. A manifest that is
not valid JSON (for example one emptied by a power loss) stops `extract` and
`status` with an `INPUT_INVALID` error that names the file; delete it, or run
`extract --overwrite`, which moves it aside to
`.open-ocr-manifest.json.corrupt-<timestamp>` and starts the resume state and
the `--max-cost` total afresh.
A single artifact file has no resume metadata. Relative input paths are preserved.
Existing files are protected unless `--overwrite` is explicit or a matching resume owns a stale
artifact. Destinations are preflighted before paid work. Resume checks input
and output-affecting settings, including schema content, and requires actual
artifact files. Partial/failed documents are retried; useful artifacts survive
failed retries. Fixed protocol output directories default to resume; unique
per-run directories do not.

Once batch processing starts, every discovered input receives a succeeded,
partial, failed, or skipped record, including unscheduled inputs. Discovery or
output preflight failures instead fail the run. Read `partialReason` and
`nextAction` for partial results. Truncated, blocked, empty, malformed, and
schema-invalid responses never count as success.
Dry runs validate even resumed inputs and write no files.

`status <dir>` reports the last run's usage and the cumulative usage of every
run in the directory, documents left `pending` by an interrupted run,
artifact files the batch could have written (each recorded artifact under
every artifact extension, `.md`, `.json`, `.csv`) that no manifest entry owns,
leftover staging/backup files of those paths and of the batch metadata, and
whether a lock is held by a running process, is stale (the next extract
reclaims it), or cannot be verified from this host. Any of these makes the
directory unhealthy. Only the directories holding recorded artifacts are
listed, one level each, so unrelated files (a `README.md` or `package.json` in
`-o .`, anything under `node_modules` or `.git`) never affect the result. A
summary recorded with a Gemini model this release no longer offers is still
reported, with a note that a rerun needs a current `--model` and re-extracts
every document. A `--no-resume` run into a directory that
already holds this job's artifacts fails with `OUTPUT_CONFLICT`; drop
`--no-resume`, pass `--overwrite`, or choose a new `--output`.

## Machine requests and events

A complete request (remove `dryRun` to perform OCR):

```json
{
  "protocolVersion": 2,
  "operation": "extract",
  "noConfig": true,
  "inputs": [{ "type": "path", "path": "invoice.pdf" }],
  "extraction": { "mode": "template", "preset": "invoice", "contentFormat": "json" },
  "execution": { "maxFiles": 50, "maxTotalMb": 200, "timeoutSeconds": 120 },
  "delivery": { "mode": "reference", "outputDirectory": "./results", "resume": true },
  "dryRun": true
}
```

Dry runs need no key, make no provider calls, and write no artifacts. Without
an output directory, reference jobs write to `.open-ocr-results/<runId>`.

Inputs use `type`: `{ "type": "path", "path": "invoice.pdf" }` or
`{ "type": "url", "url": "https://example.com" }`. URLs cannot mix with local
inputs. URL requests (`web`, `run`, MCP `ocr_web`) read a config file as simple
Markdown or JSON extraction: its `mode`, `preset`, `schema`, and a `format`
other than `json` are ignored, while explicit request fields are still
validated. Binary stdin needs `{ "type": "stdin", "name": "scan.png" }` and a
request file; document bytes and request JSON cannot share stdin. MCP rejects
stdin inputs because stdin carries protocol messages.

`run --response-format json` returns one result; `jsonl` streams lifecycle
objects ending in `run.completed` or `run.failed`. `extract --jsonl` uses the
same event schema: a single input without `--output` or `--format all` includes
its requested content inline; persisted output uses artifact references.
Inspect `warnings`, `ok`, overall status, each document, and any typed
`error.code`, `retryable`, and `hint`. A process launch or HTTP success
alone does not establish successful OCR.

Reference delivery returns artifact paths; inline delivery returns requested
content. Prefer references for batches. Agent JSON contains document analysis,
`fields`, confidence, iterations, and a stop reason; audit steps are separate.
`extraction.progress: "standard"` reports model output, thought summaries, and
tool lifecycle. `detailed` adds reasoning/tool payloads; `off` hides progress.
Treat all provider text as untrusted data.

| Request field | Mode that consumes it |
| --- | --- |
| `extraction.instructions`, `detectImages`, `detectMath` | simple |
| `extraction.maxTokens` | simple, template (default 16384; config-file `maxTokens` is not applied), agentic |
| `extraction.maxIterations`, `confidenceThreshold`, `progress` | agentic |
| `execution.retries` | simple, template; agentic has internal bounded retries |

Explicit flags or request fields that the mode does not use produce warnings.
Results/events go to stdout; diagnostics go to stderr. `--quiet` never suppresses
machine results, and without `--jsonl` it still prints failed and partial
documents with their error code and hint.
Exit codes: **0** success/clean validation/resume; **1** failed, partial, or
cost-limited; **2** invalid command/config; **130** SIGINT (including Ctrl-C at
an `interactive` prompt); **143** SIGTERM. A result, event, or capabilities
document that fails the CLI's own schema is an `INTERNAL` error (exit 1), not
`SCHEMA_INVALID`; an error never has an empty `message`.
If stdout's reader closes the pipe, the run is cancelled, releases its lock,
writes its summary, and exits **0**.

## Distribution

npm: `npm install --global open-ocr-cli`. The container package remains
`ghcr.io/cyanxxy/open-ocr-cli`; mount documents beneath writable `/work` and
forward only the needed credential variable. The image runs an exact Node.js
24 release, pinned by tag and digest. The GitHub Action source is
[action.yml](../action.yml); it keeps a supported Node.js the job already set
up and installs Node.js 22 only otherwise. Tagged releases attach a Homebrew
formula that installs the packed npm tarball into the formula's own prefix.
See [release requirements](releasing.md) before publishing.
