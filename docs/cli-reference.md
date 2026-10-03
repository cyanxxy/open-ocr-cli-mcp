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
local `$ref` only. Returned values must validate against the original schema.
Start with [invoice.schema.json](../examples/invoice.schema.json).

## Provider selection

```bash
open-ocr-cli extract scan.png --provider kimi
open-ocr-cli extract scan.png --provider muse
open-ocr-cli extract scan.png --provider openrouter --model moonshotai/kimi-k3
open-ocr-cli extract scan.png --provider openai-compatible \
  --base-url http://localhost:11434/v1 --model your-vision-model
```

| Profile | Credential variable | Documents |
| --- | --- | --- |
| `gemini` | `GEMINI_API_KEY` | PNG, JPEG, WebP, HEIC/HEIF; native PDFs |
| `kimi` | `MOONSHOT_API_KEY` | PNG, JPEG, WebP, GIF; PDF text via file extraction |
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

Environment overrides: `OPEN_OCR_PROVIDER`, `OPEN_OCR_GATEWAY`, `OPEN_OCR_MODEL`,
`OPEN_OCR_THINKING`. Configure credentials with `apiKeyEnv`, the environment
variable name. Raw key fields and other unknown config keys are warned about
and ignored. Project `.env` can supply credentials. `--no-config` or protocol
`noConfig: true` skips config files and `.env` and cannot be combined with an
explicit config path. `OPEN_OCR_NO_CONFIG=1` skips ambient config and `.env`,
but still allows an explicit `--config` or protocol `configPath` to load that
one file. Ambient environment overrides still apply; set explicit options and
forward a controlled environment for reproducible runs.

`init` writes project config by default; `--global` selects user config.
Writes are atomic with mode `0600`; replacement requires confirmation or
`--force`. `--yes` accepts setup defaults; `--skip-validation` avoids a provider
credential check. No-argument invocation prints help without prompting.

## Discovery and limits

Directories are recursive. Hidden paths and `node_modules`, `dist`, `build`,
`vendor`, and `target` subtrees are skipped by default. Warnings count skipped
unsupported files and default-excluded directories, not hidden or custom-excluded
paths. `--hidden` includes hidden paths; `--exclude <glob>` adds exclusions.
Use `--no-default-excludes`, explicitly name a default-excluded directory, or
use a quoted glob to include those trees. Hidden/custom exclusions still apply
to directory and glob discovery. Discovery does not follow symlinks encountered
while walking. Quote globs to let the CLI expand them.

Images: **70 MB raw**. PDFs: **50 MB, 1,000 pages**. Default batch limits:
**1,000 files / 5,120 MB**, concurrency **2** (range **1–16**). Formats accepted
by a provider may be narrower than discovery. Video is not an OCR input.

`--requests-per-minute` spaces request starts evenly, including agent
continuations. `--max-cost` stops future requests once recorded estimates reach
the budget; in-flight requests can exceed it. Known models use paid-tier token
estimates; OpenRouter reports cost when available. For other providers, unknown
prices require both `--input-price` and `--output-price` when enforcing a cost
limit. Cached-input rates and provider-reported cache usage are included where
available.

## Output and resume

Single-file `extract` normally prints content to stdout. `--output` or
`--format all` writes artifacts; batch `extract` defaults to `./open-ocr-output`.
Machine/MCP reference jobs default to `.open-ocr-results/<runId>`.

Directories with resume metadata contain `.open-ocr-manifest.json` and
`batch-summary.json`; `.open-ocr.lock` exists only while the run owns the directory.
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

## Machine requests and events

Inputs use `type`: `{ "type": "path", "path": "invoice.pdf" }` or
`{ "type": "url", "url": "https://example.com" }`. URLs cannot mix with local
inputs. Binary stdin needs `{ "type": "stdin", "name": "scan.png" }` and a
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
| `extraction.maxTokens` | simple, agentic |
| `extraction.maxIterations`, `confidenceThreshold`, `progress` | agentic |
| `execution.retries` | simple, template; agentic has internal bounded retries |

Explicit flags or request fields that the mode does not use produce warnings.
Results/events go to stdout; diagnostics go to stderr. `--quiet` never suppresses
machine results.
Exit codes: **0** success/clean validation/resume; **1** failed, partial, or
cost-limited; **2** invalid command/config; **130** SIGINT; **143** SIGTERM.

## Distribution

npm: `npm install --global open-ocr-cli`. The container package remains
`ghcr.io/cyanxxy/open-ocr-cli`; mount documents beneath writable `/work` and
forward only the needed credential variable. The GitHub Action source is
[action.yml](../action.yml); tagged releases attach a Homebrew formula.
See [release requirements](releasing.md) before publishing.
