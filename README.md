# Open OCR CLI + MCP

[![CI](https://github.com/cyanxxy/open-ocr-cli-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cyanxxy/open-ocr-cli-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/open-ocr-cli)](https://www.npmjs.com/package/open-ocr-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

OCR for images, PDFs, and web pages, usable by people from a terminal and by
coding agents over MCP or a versioned JSON protocol. Bring a key for Gemini,
Kimi, Meta Muse, OpenRouter, or any OpenAI-compatible endpoint.

```bash
npm install --global open-ocr-cli
export GEMINI_API_KEY=...
open-ocr-cli extract invoice.pdf
```

## Why

Vision models read documents well. Wiring them into real work is the hard
part, and this tool handles that part:

- **Results you can check.** Every document ends as `succeeded`, `partial`,
  `failed`, or `skipped`, with a typed error code and a next step. Truncated,
  empty, or schema-invalid model output is never reported as success.
- **Structured data, not just text.** Use Markdown, a built-in preset
  (invoice, receipt, resume, business card), or your own JSON Schema. Returned
  values are validated against the schema.
- **Batches that survive interruption.** Directories and globs, bounded
  concurrency, and resume from a manifest. Existing files are never
  overwritten unless you ask.
- **Bounded spend.** `--max-cost`, request-rate limits, and per-model price
  estimates, plus `--dry-run` to validate a job without a key or a request.
- **One interface across providers.** Switch models with a flag. Thinking
  levels are checked against what each model actually supports.

## MCP server

`open-ocr-cli mcp` runs a stdio server on MCP revision **2026-07-28**. Install
the CLI first, then register it.

**Claude Code**

```bash
claude mcp add --transport stdio --scope user open-ocr -- open-ocr-cli mcp
```

Start Claude with the provider key in its environment, then check with `/mcp`.
Also set `MCP_PROTOCOL_NEGOTIATION=auto` in Claude Code's environment: when it
is unset, Claude Code can skip probing a stdio server for 7 days after a failed
probe (for example one made before upgrading Claude Code or this CLI).
Claude Code aborts a stdio tool call that sends no response or progress for 30
minutes (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`); a single document may run up to
`timeoutSeconds` (at most 3600), so keep that under 1800 or raise the window.

**Codex** (`~/.codex/config.toml`)

```toml
[features]
mcp_2026_07_28 = true   # under development, off by default (from Codex source)

[mcp_servers.open-ocr]
command = "open-ocr-cli"
args = ["mcp"]
# Without this Codex uses the legacy handshake for stdio servers (from Codex source).
env = { CODEX_MCP_PROTOCOL_VERSION = "2026-07-28" }
env_vars = ["GEMINI_API_KEY"]
cwd = "/absolute/path/to/documents"
tool_timeout_sec = 600
```

Codex's official guide does not document this opt-in yet; the two settings come
from its source. If either client cannot connect, use the CLI protocol or the
portable skill (see [agent integrations](docs/agent-integrations.md)), which
need no MCP support.

| Tool | What it does |
| --- | --- |
| `ocr_capabilities` | Providers, models, modes, schemas, and limits. Call it first. |
| `ocr_extract` | Extract files as Markdown, a preset, or a custom schema |
| `ocr_run_agentic` | Iterative field extraction with regional re-reads |
| `ocr_web` | Extract content from public URLs |
| `ocr_read_artifact` | Read a saved result in bounded chunks |

The server's working directory (Claude Code's launch directory, or Codex's
`cwd`) is its boundary: inputs, `configPath`, `schemaPath`, and
`outputDirectory` must resolve inside it. Endpoint, credential variable, and
limits such as `maxCostUsd` belong to whoever starts the server, through
`~/.config/open-ocr-cli/config.json` or its environment; tool arguments can
lower those limits but not raise them, reroute requests, or change the token
prices the cost ceiling is computed from.

Set `OPEN_OCR_MCP_CONFIRM=1` in the server environment to approve each paid
run, with the real document count, cost ceiling, destination host, and
credential variable shown first. Setup for other hosts, a custom endpoint, and
the full contract: [agent integrations](docs/agent-integrations.md).

## CLI

```bash
# Markdown to stdout
open-ocr-cli extract scan.png

# Structured fields from a preset
open-ocr-cli extract invoice.pdf --preset invoice --format json

# Your own JSON Schema
open-ocr-cli extract invoice.pdf --schema examples/invoice.schema.json --format json

# Iterative extraction for hard documents (several billed requests)
open-ocr-cli extract contract.pdf --mode agentic --format json

# A folder, with a spend cap for the whole job; rerun the same command to
# resume (finished documents are skipped, and the $2 cap counts every run)
open-ocr-cli extract ./scans --output ./ocr --max-cost 2

# Public web pages
open-ocr-cli web https://example.com/pricing

# Check the plan without a key or any request
open-ocr-cli extract ./scans --dry-run
```

Batches are crash-safe: a run killed at any point resumes with the same
command, re-extracting only documents whose content changed or that never
finished. `--max-cost` is enforced on the directory's cumulative spend, and fails
closed when a paid provider returns no usage. `status` shows last-run and
cumulative usage, interrupted and not-started documents, untracked files, and
stale locks. Output names never start with a dot or match an agent
instruction file: `.mcp.png` is written as `_.mcp.md`, `CLAUDE.png` as
`CLAUDE.ocr.md`.

Other commands: `init` (guided config), `interactive` (guided command menu),
`doctor` (environment check), `status` (inspect a batch), `models`,
`providers`, `presets`. Run any command with `--help`.

### For agents and scripts

```bash
open-ocr-cli capabilities --json                     # full machine contract
open-ocr-cli schema request                          # JSON Schema for requests
open-ocr-cli run --request job.json --response-format jsonl
```

`run` takes a protocol v2 request and streams lifecycle events that end in
`run.completed` or `run.failed`. Exit codes: `0` success, `1` failed, partial,
or cost-limited, `2` invalid command or config, `130` interrupted by SIGINT,
`143` terminated by SIGTERM. Request examples are in the
[CLI reference](docs/cli-reference.md#machine-requests-and-events).

## Providers

| `--provider` | Key variable | Suggested models (default first) |
| --- | --- | --- |
| `gemini` (default) | `GEMINI_API_KEY` | `gemini-3.8-flash`, `gemini-4-argon`, `gemini-3.5-flash-lite` |
| `kimi` | `MOONSHOT_API_KEY` | `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`, `kimi-k3` |
| `muse` | `META_API_KEY` | `muse-spark-1.3`, `muse-wonder-1.0` |
| `openrouter` | `OPENROUTER_API_KEY` | Gemini, GPT-6.x, Claude 5.x, Muse, Grok 4.7, Mistral Medium 3.5 |
| `openai-compatible` | `OPEN_OCR_API_KEY` | Any vision model, for example a local Ollama server |

```bash
open-ocr-cli extract scan.png --provider openrouter --model anthropic/claude-sonnet-5.5
open-ocr-cli extract scan.png --provider openai-compatible \
  --base-url http://localhost:11434/v1 --model your-vision-model
```

`open-ocr-cli models --provider <id>` lists current IDs. Gemini and Muse read
PDFs natively; Kimi extracts PDF text first; the generic compatible profile
takes images only. Cloudflare AI Gateway routing is supported with
`--gateway cloudflare`.

## Installation

Requires Node.js 20.19+, 22.13+, or 24+. Node.js 20 is end-of-life; support
for it will be removed in the next major release.

**npm**

```bash
npm install --global open-ocr-cli
open-ocr-cli doctor
```

**Docker**

```bash
docker run --rm -e GEMINI_API_KEY -v "$PWD:/work" \
  ghcr.io/cyanxxy/open-ocr-cli extract invoice.pdf
```

**GitHub Actions**

```yaml
- uses: cyanxxy/open-ocr-cli-mcp@v4
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
  with:
    inputs: docs/scans
    preset: invoice
    format: json
    output: ocr-results
```

All inputs are listed in [action.yml](action.yml). The action uses the
runner's `node` when it satisfies `^20.19.0 || ^22.13.0 || >=24.0.0`.
Otherwise it runs `actions/setup-node` with Node.js 22.x, which, like any
setup-node step, changes `node` and `PATH` for the rest of the job; add your
own `actions/setup-node` step before this action to keep a specific version.

**Agent skill.** A portable skill for Claude Code and Codex ships in the npm
package and in [integrations/open-ocr](integrations/open-ocr/skills/open-ocr).
Copy the folder to `~/.claude/skills/` or `~/.agents/skills/`; details are in
[agent integrations](docs/agent-integrations.md#portable-skill).

## Configuration

`open-ocr-cli init` writes a project `.open-ocr-cli.json`; `init --global`
writes `~/.config/open-ocr-cli/config.json`. Flags override environment
variables, which override config files. Keys are referenced by variable name
and never stored. A project config is treated as untrusted: it cannot redirect
requests to another endpoint or credential. See
[configuration](docs/cli-reference.md#configuration) and the
[example config](.open-ocr-cli.example.json). Set `OPEN_OCR_DEBUG=1` to add a
stack trace to fatal errors on stderr; the full list of environment variables
is in `open-ocr-cli --help`.

## Quality

The [eval suite](evals/README.md) scores OCR output against references:
24 local cases plus pinned public subsets of CORD (receipts), OmniDocBench
(mixed layouts), and olmOCR-bench (PDFs). It reports edit similarity, coverage,
field F1, and unit-test pass rate per provider and model.

## Development

```bash
npm ci
npm run typecheck && npm run lint && npm run test:coverage
```

`packages/cli` is the published package; `packages/engine` is the shared OCR
engine bundled into it.

[CLI reference](docs/cli-reference.md) · [Agent integrations](docs/agent-integrations.md) ·
[Evaluations](evals/README.md) · [Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
