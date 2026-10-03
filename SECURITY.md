# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Latest released version | :white_check_mark: |
| Earlier versions | :x: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security Advisories](https://github.com/cyanxxy/open-ocr-cli-mcp/security/advisories) page
2. Click "Report a vulnerability"
3. Fill out the form with details about the vulnerability

### What to Include

- A description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any suggested fixes (optional)

### What to Expect

- **Acknowledgment**: We will acknowledge your report within 48 hours
- **Updates**: We will keep you informed about our progress
- **Resolution**: We aim to resolve critical vulnerabilities within 7 days
- **Credit**: We will credit you in the release notes (unless you prefer to remain anonymous)

## Security Best Practices for Users

### API Key Handling

Hosted providers normally require an API key. A local OpenAI-compatible
endpoint may run without one; Cloudflare BYOK uses a stored provider key and
gateway authentication. For credentials you manage:

1. **Never commit API keys** to version control
2. **Rotate keys regularly** if you suspect they may have been exposed
3. **Use restricted API keys** with only the permissions needed

### How the CLI Reads Credentials

Keys are read **only** from an environment variable, named by the `apiKeyEnv`
config setting (default `GEMINI_API_KEY`, `MOONSHOT_API_KEY`, `META_API_KEY`,
`OPENROUTER_API_KEY`, or `OPEN_OCR_API_KEY`). Project `.env` files may populate
those variables unless configuration loading is disabled. The CLI never accepts a raw key as a command-line
argument or a config-file value, and never writes one to a config file, a run
record, an artifact, or a log line. Consider:

- Keeping keys in your shell profile or a secret manager, not in shell history
- Using `--no-config` to skip config files and `.env`. `OPEN_OCR_NO_CONFIG=1`
  also skips ambient config but permits an explicitly selected config file.
  Ambient environment overrides still apply, so also control the process
  environment and set explicit provider/model options for reproducibility
- Running `open-ocr-cli doctor` to confirm which variable is being read, without
  printing its value

The CLI does not write credentials. Protect any `.env` or secret-manager files
you create yourself.

### Content Security

- Documents are read locally and sent to the configured provider, potentially
  through OpenRouter or Cloudflare AI Gateway. Public URL extraction can use
  hosted retrieval or fetch page content locally before sending it to a model.
- Gemini agent mode uses stored Interactions chaining (`previous_interaction_id`)
  with `store: true`; Gemini Web OCR sends `store: false`. Review Google's
  [Interactions retention policy](https://ai.google.dev/gemini-api/docs/interactions-overview#data-retention)
  and the policies of every provider/router/gateway involved. Other agent
  transports carry their conversation history in requests.
- Kimi PDF extraction uploads a file to its file-extract API and attempts
  deletion afterward. Cleanup is best effort and does not guarantee immediate
  upstream deletion or override provider retention policies.
- File size is limited by MIME type: 70MB raw for inline images (safe below the 100MB payload ceiling after base64), 50MB and 1,000 pages for PDFs
- Only supported file types (images, PDFs) are accepted

## Security Features

- **Credential Isolation**: Keys are read from environment variables only, never serialized or echoed
- **Input Validation**: Strict file type and size validation
- **SSRF Protection**: URL extraction blocks private ranges, link-local, and tunnel hosts, and pins DNS across redirects
- **Untrusted Output**: Extracted document text is treated as third-party content, never as instructions to the calling agent
- **Diagnostics**: The shared engine logger writes only to stderr and is
  disabled outside development by default. CLI diagnostics still run; redact
  private document text and local paths before sharing logs.
