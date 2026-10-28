# open-ocr-cli

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
**MCP:** `open-ocr-cli mcp` (protocol 2026-07-28).
The package ships an agent skill in `skills/open-ocr/` and schemas in `schemas/`.

[CLI reference](https://github.com/cyanxxy/open-ocr-cli-mcp/blob/main/docs/cli-reference.md) ·
[Agent setup](https://github.com/cyanxxy/open-ocr-cli-mcp/blob/main/docs/agent-integrations.md) ·
[Source](https://github.com/cyanxxy/open-ocr-cli-mcp) · MIT
