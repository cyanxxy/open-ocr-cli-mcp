# OCR evaluation suite

The suite measures OCR quality across the same five providers as the CLI.
Local cases and ground-truth references are versioned; downloaded datasets and
timestamped model outputs stay in ignored directories. Run commands from the
repository root after `npm ci`.

## Commands

```bash
npm run evals:validate       # validate installed cases and file paths; no API calls
npm run evals:matrix:check   # validate matrix configuration; no API calls
npm run evals:setup          # download pinned public subsets into evals/cache
npm run evals:fixtures       # rebuild committed local fixtures

# Live runs require the selected provider's API key in the environment.
npm run evals:canary
npm run evals
npm run evals:benchmark
npm run evals:stability
npm run evals:canary -- --repeat 2
```

Rebuilding fixtures requires Poppler (`pdftoppm`) plus the Python packages in
`evals/requirements.txt`. The generated fixtures are committed, so ordinary
evaluation runs do not require Python or Poppler.

- `canary`: 17 local cases, including three raster cases, plus the first five
  selected cases from each installed public dataset.
- `full` (`npm run evals`): all 24 local cases and all installed public cases.
- `benchmark`: only installed CORD and OmniDocBench cases; run setup first.

Set `EVAL_REPEATS` or pass `--repeat` to the canary, full, or benchmark command
to collect 1–10 samples per case. `evals:stability` fixes the benchmark repeat
count at three. Repeats count as separate results in aggregate metrics; raw
artifact filenames use one-based repeat numbers and metadata uses zero-based
`repeatIndex` values.

`evals:setup` is optional. Local cases continue to work without downloaded
datasets. Re-running setup replaces only the generated `evals/cache` directory.

## Providers and configuration

The runner defaults to Gemini `gemini-3.8-flash`. Credentials and settings come
from the process environment; CLI configuration files are not read.

| Provider (`EVAL_PROVIDER`) | Default model | Default key variable |
| --- | --- | --- |
| `gemini` | `gemini-3.8-flash` | `GEMINI_API_KEY` |
| `kimi` | `kimi-k3` | `MOONSHOT_API_KEY` |
| `muse` | `muse-spark-1.3` | `META_API_KEY` |
| `openrouter` | `google/gemini-3.8-flash` | `OPENROUTER_API_KEY` |
| `openai-compatible` | Set `OPEN_OCR_MODEL` | `OPEN_OCR_API_KEY` |

Use `OPEN_OCR_MODEL` to select a model, `OPEN_OCR_THINKING` to select a supported
reasoning level, `EVAL_API_KEY_ENV` to name another credential variable, and
`OPEN_OCR_BASE_URL` for a custom endpoint. Thinking defaults and allowed levels
follow the CLI's per-model rules. A loopback OpenAI-compatible endpoint does
not require a key. List current choices with `npm run cli -- models --json`.
The generic OpenAI-compatible profile supports image inputs only; the local
canary/full PDF cases will fail on that profile. The installed public benchmark
contains images and is suitable for comparing compatible vision endpoints.

```bash
EVAL_PROVIDER=kimi npm run evals:canary
EVAL_PROVIDER=openrouter OPEN_OCR_MODEL=moonshotai/kimi-k3 npm run evals:canary
```

`EVAL_GATEWAY=cloudflare` uses `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_AI_GATEWAY_ID`. An authenticated gateway also needs
`CLOUDFLARE_AI_GATEWAY_TOKEN`; set `CLOUDFLARE_AI_GATEWAY_BYOK=1` when the gateway
holds the upstream key. Custom provider routes use
`CLOUDFLARE_AI_GATEWAY_PROVIDER`, and a stored-key alias can be selected with
`CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS`. See the
[provider reference](../docs/cli-reference.md) for endpoint setup.

## Provider matrix

Copy [providers.example.json](providers.example.json), retain the routes you
intend to run, and point `EVAL_MATRIX_CONFIG` at your file. Each entry requires
`id`, `provider`, and `model`; optional keys are `gateway`, `apiKeyEnv`,
`baseUrl`, and `cloudflareProvider`. IDs must be unique ignoring case, contain
1–80 letters, digits, underscores, or hyphens, and start with a letter or digit.

```bash
EVAL_MATRIX_CONFIG=/path/to/providers.json npm run evals:matrix -- --suite canary --dry-run
EVAL_MATRIX_CONFIG=/path/to/providers.json EVAL_REPEATS=2 npm run evals:matrix -- --suite canary
```

The matrix runs entries sequentially and does not skip entries with missing
credentials. Dry run validates the matrix shape and suite name, not endpoint
access. Use `EVAL_REPEATS` for matrix repetitions; `--repeat` is not forwarded
to workers. Other settings come from the inherited environment, so clear
single-provider endpoint or thinking overrides when comparing different routes.

Per-entry summaries are saved to `evals/reports/matrix/<id>.json`; combined
reports are `matrix-latest.json` and `matrix-latest.md`. Workers also overwrite
the ordinary `latest` reports. A failed entry makes the matrix exit with code
1; interruption terminates the active worker and stops further scheduling.

## Metrics

Text references produce:

- Character error rate (CER), before and after documented OCR normalization
- Word error rate (WER)
- Normalized edit similarity
- Token coverage and unsupported-text rate

Structured references produce exact normalized field precision, recall, and
F1, critical-field exact match, and table-cell F1. Table cells are compared as
a multiset of `column:value` pairs so harmless row serialization differences do
not erase all credit.

Assertions remain useful for hard invariants. `metric_min` and `metric_max`
turn selected objective metrics into case-level gates. The report keeps the
weighted assertion score separate from macro-averaged quality metrics.

Markdown is converted to visible text before OCR scoring. Normalized scoring
uses Unicode NFKC, canonical quotes/dashes, collapsed whitespace, and lowercase
text. Strict CER retains case, punctuation, and line boundaries after Markdown
markers are removed.

## Public datasets

Selections and immutable revisions live in [`datasets.json`](datasets.json).
Sampling seeds are benchmark identifiers, not product branding; keep them
stable unless intentionally publishing a new, documented benchmark corpus.

- CORD v2 is used under CC BY 4.0. The installer selects 20 records from its
  official test split and preserves the supplied OCR and parse annotations.
- OmniDocBench supplies two pages per document source type (20 in the pinned
  selection). The manifest records that no machine-readable dataset license
  was declared when selected. The installer prints that notice and keeps
  downloaded files in the ignored local cache.

Review upstream terms before sharing cached files. Attribution and source URLs
are in `datasets.json`; `evals/cache/installed.json` records installed revisions,
case counts, and installation time. Public cases currently score text only;
saved parse annotations are not additional structured-quality benchmarks.

## Run artifacts

Every completed live run writes:

- `evals/reports/latest.json` and `latest.md`
- Raw output per case under `evals/reports/runs/<timestamp>/`
- Per-case runtime errors, duration, API requests, token usage, agent iterations,
  and processing-step count
- Aggregate metrics split by OCR mode and tags

Costs use reported provider charges when available, otherwise the shared
provider/model price catalog. Set both `EVAL_INPUT_USD_PER_MILLION` and
`EVAL_OUTPUT_USD_PER_MILLION` to nonnegative rates to override local estimates.
Each case and repetition has isolated usage accounting, including Gemini agent
continuations. Gemini thought tokens are billed as output; compatible-provider
reasoning tokens already included in completion tokens are not counted twice.
Tool-use tokens are part of input, not an extra charge. Missing or zero cost
estimates may appear as `-`; these reports are estimates, not invoices.

`npm run evals:report` only regenerates Markdown from existing `latest.json`;
it does not run models. The checked-in [latest report](reports/latest.md) is a
historical snapshot until a new live run replaces it. Validation and matrix dry
runs do not refresh model-quality results.
