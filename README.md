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

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.open-ocr]
command = "open-ocr-cli"
args = ["mcp"]
env_vars = ["GEMINI_API_KEY"]
cwd = "/absolute/path/to/documents"
tool_timeout_sec = 600
```

| Tool | What it does |
| --- | --- |
| `ocr_capabilities` | Providers, models, modes, schemas, and limits. Call it first. |
| `ocr_extract` | Extract files as Markdown, a preset, or a custom schema |
| `ocr_run_agentic` | Iterative field extraction with regional re-reads |
| `ocr_web` | Extract content from public URLs |
| `ocr_read_artifact` | Read a saved result in bounded chunks |

Set `OPEN_OCR_MCP_CONFIRM=1` in the server environment to approve each paid
run, with the real document count and cost ceiling shown first. Setup for
other hosts and the full contract: [agent integrations](docs/agent-integrations.md).

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

# A folder, with a spend cap; rerun the same command to resume
open-ocr-cli extract ./scans --output ./ocr --max-cost 2

# Public web pages
open-ocr-cli web https://example.com/pricing

# Check the plan without a key or any request
open-ocr-cli extract ./scans --dry-run
```

Other commands: `init` (guided config), `doctor` (environment check),
`status` (inspect a batch), `models`, `providers`, `presets`. Run any command
with `--help`.

### For agents and scripts

```bash
open-ocr-cli capabilities --json                     # full machine contract
open-ocr-cli schema request                          # JSON Schema for requests
open-ocr-cli run --request job.json --response-format jsonl
```

`run` takes a protocol v2 request and streams lifecycle events that end in
`run.completed` or `run.failed`. Exit codes: `0` success, `1` failed, partial,
or cost-limited, `2` invalid command or config. Request examples are in the
[CLI reference](docs/cli-reference.md#machine-requests-and-events).

## Providers

| `--provider` | Key variable | Suggested models (default first) |
| --- | --- | --- |
| `gemini` (default) | `GEMINI_API_KEY` | `gemini-3.8-flash`, `gemini-4-argon`, `gemini-3.5-flash-lite` |
| `kimi` | `MOONSHOT_API_KEY` | `kimi-k3`, `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed` |
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

Requires Node.js 20.19+, 22.13+, or 24+.

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

All inputs are listed in [action.yml](action.yml).

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
[example config](.open-ocr-cli.example.json).

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
