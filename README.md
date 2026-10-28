# Open OCR CLI + MCP

[![CI](https://github.com/cyanxxy/open-ocr-cli-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cyanxxy/open-ocr-cli-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/open-ocr-cli)](https://www.npmjs.com/package/open-ocr-cli)

OCR for images, PDFs, and URLs, built for coding agents: a CLI with a versioned
JSON protocol and a stdio MCP server. Works with Gemini, Kimi, Meta Muse,
OpenRouter, or any OpenAI-compatible endpoint.

```bash
npm install --global open-ocr-cli   # Node 20.19+, 22.13+, or 24+
export GEMINI_API_KEY=...           # or --provider kimi|muse|openrouter|openai-compatible
open-ocr-cli extract invoice.pdf
```

**Agents:** `open-ocr-cli capabilities --json`, then
`open-ocr-cli run --request job.json --response-format jsonl`.
**MCP:** `open-ocr-cli mcp` (protocol 2026-07-28); see [agent setup](docs/agent-integrations.md).

## Development

```bash
npm ci && npm run typecheck && npm run lint && npm run test:coverage
```

`packages/cli` is the published package; `packages/engine` is the private
engine. The agent skill source is `integrations/open-ocr/skills`.

[CLI reference](docs/cli-reference.md) · [Agent setup](docs/agent-integrations.md) ·
[Evaluations](evals/README.md) · [Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md) · [Releases](docs/releasing.md) · [MIT license](LICENSE)
