# Open OCR CLI + MCP

Agent-first OCR for images, PDFs, and public URLs. Extract Markdown, validated
JSON, or structured fields with Gemini, Kimi, Meta Muse, OpenRouter, or an
OpenAI-compatible endpoint. Includes a stdio MCP server and a portable agent skill.

## Install

Requires Node.js **20.19+**, **22.13+**, or **24+**.

```bash
npm install --global open-ocr-cli
# Set GEMINI_API_KEY in your environment.
open-ocr-cli extract invoice.pdf
```

For another provider, pass `--provider kimi|muse|openrouter|openai-compatible`.
Credential defaults are `MOONSHOT_API_KEY`, `META_API_KEY`, `OPENROUTER_API_KEY`,
and `OPEN_OCR_API_KEY`. Compatible endpoints need `--model`; `--base-url`
defaults to `http://localhost:11434/v1`, where no API key is required.
Use `init` for guided setup; API keys never belong in flags or JSON config.

## Agent workflow

```bash
open-ocr-cli capabilities --json
open-ocr-cli schema request
open-ocr-cli run --request job.json --response-format jsonl
```

Example `job.json`:

```json
{
  "protocolVersion": 2,
  "operation": "extract",
  "noConfig": true,
  "inputs": [{ "type": "path", "path": "invoice.pdf" }],
  "extraction": { "mode": "template", "preset": "invoice", "contentFormat": "json" },
  "delivery": { "mode": "reference", "outputDirectory": "./results", "resume": true },
  "dryRun": true
}
```

Remove `dryRun` to perform OCR. Dry runs require no credential or provider call
and write no files. Prefer reference delivery, bound batches with `execution`
limits, and inspect every document status plus `warnings`. Without an output
directory, reference jobs use `.open-ocr-results/<runId>`.

## MCP

Launch `open-ocr-cli mcp` from your client. It exposes `ocr_capabilities`,
`ocr_extract`, `ocr_run_agentic`, `ocr_web`, and `ocr_read_artifact`.

The client must support **MCP 2026-07-28**. Follow the
[Codex / Claude Code setup](https://github.com/cyanxxy/open-ocr-cli-mcp/blob/main/docs/agent-integrations.md)
for launch commands, credentials, timeouts, and revision requirements.
The npm package also includes `skills/open-ocr/` and protocol schemas in `schemas/`.

## Examples

```bash
open-ocr-cli extract ./documents --output ./results --resume
open-ocr-cli extract invoice.pdf --schema invoice.schema.json --format json
open-ocr-cli extract scan.pdf --mode agentic --format json
open-ocr-cli web https://example.com
open-ocr-cli extract ./documents --dry-run
open-ocr-cli status ./results --json
open-ocr-cli models --provider gemini
open-ocr-cli doctor --json
```

`simple` transcribes; `template` extracts preset fields; `agentic` iterates and
re-OCRs regions. Custom schemas require simple mode and JSON output. Find a
working [invoice schema](https://github.com/cyanxxy/open-ocr-cli-mcp/blob/main/examples/invoice.schema.json)
and save it as `invoice.schema.json` before running the schema example.

Results and JSONL events use stdout; diagnostics use stderr. Exit codes:
`0` success/validation/resume, `1` failed/partial/cost-limited,
`2` invalid command/configuration, `130` SIGINT, `143` SIGTERM.

[Full CLI reference](https://github.com/cyanxxy/open-ocr-cli-mcp/blob/main/docs/cli-reference.md) ·
[Source and issues](https://github.com/cyanxxy/open-ocr-cli-mcp) ·
[License](https://github.com/cyanxxy/open-ocr-cli-mcp/blob/main/LICENSE)
