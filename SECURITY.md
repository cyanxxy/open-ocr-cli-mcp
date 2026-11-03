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

### MCP Server Trust Boundary

`open-ocr-cli mcp` treats its caller (an agent, possibly following
instructions planted in a document) as untrusted relative to the operator who
started the server and controls its environment, working directory, and
`~/.config/open-ocr-cli/config.json`. Over MCP:

- Only the operator's user configuration and the server environment may choose
  the endpoint (`baseUrl`, `gateway`, `cloudflare*`) or the credential variable
  (`apiKeyEnv`, `cloudflareTokenEnv`). A caller's `configPath` file that sets
  any of them is refused, as a project `.open-ocr-cli.json` already was,
  including under `OPEN_OCR_NO_CONFIG=1`.
- Inputs, globs, `configPath`, `schemaPath`, and `outputDirectory` must resolve
  inside the server working directory with symbolic links followed. Output may
  not go into a hidden directory other than `.open-ocr-results`, which keeps
  writes away from `.git`, `.claude`, and similar agent or tool configuration.
  Start the server in the folder that holds the documents, never in `/` or a
  home directory.
- An input that exists is confined as the literal path it names, even when the
  name contains glob characters (`Scan (1).pdf`, or any file under a working
  directory named `Project (2024)`); only a path that does not exist is expanded
  as a glob. An absolute glob is accepted only when it starts with the working
  directory or its literal prefix resolves inside it, a glob may not contain
  `..`, and every match is realpath-checked again after expansion.
- The operator's `maxFiles`, `maxTotalMb`, `maxCostUsd`, `requestsPerMinute`,
  and `concurrency` are ceilings a caller can lower but not raise, and
  `noConfig` does not remove them.
- Token prices (`inputPricePerMillionUsd`, `outputPricePerMillionUsd`) come only
  from the operator's user configuration or the verified price table. A
  caller's `configPath` or a project `.open-ocr-cli.json` that sets them is
  refused, because a price of 0 would make every request free on paper and
  defeat both the `maxCostUsd` ceiling and the fail-closed stop for a paid
  response that reports no usage. The operator's prices are dropped when the
  caller's configuration switches the provider or model they describe.
- With `OPEN_OCR_MCP_CONFIRM=1`, the confirmation names the destination host
  and the credential variable, and approval is invalidated if the resolved run
  changes before it executes.

The `run` command and the other CLI commands are driven by the person at the
terminal and keep accepting any path and an explicit `--config` route. See
[agent integrations](docs/agent-integrations.md#trust-boundary).

### Artifact Paths

These apply to every run, CLI and MCP alike, because extracted text and input
file names are document-controlled:

- No directory or file an extraction writes starts with a dot. Artifact paths
  mirror the input's relative path, so an input `.mcp.png` would otherwise
  become `.mcp.json` (a project MCP server configuration Claude Code loads) and
  `.devcontainer/devcontainer.png` would become `.devcontainer/devcontainer.json`.
  Each hidden segment gains a leading `_` (`_.mcp.json`,
  `_.devcontainer/`), and agent instruction names such as `CLAUDE` or `AGENTS`
  gain `.ocr` (`CLAUDE.ocr.md`).
- Missing artifact directories are created one level at a time from the output
  directory. Each existing component is checked first, and a non-directory or a
  symbolic link that resolves outside the output directory is refused before
  anything is created beneath it, so a directory swapped for a link cannot make
  the run create directories elsewhere. (Node has no per-component
  `openat`/`O_NOFOLLOW`, so this narrows the race rather than closing it.)

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

- **Credential Isolation**: Keys are read from environment variables only, never serialized or echoed.
  Error text is scrubbed of credential-shaped strings and of the actual
  credential values the process is using, and configuration or schema parse
  errors never quote the file
- **MCP Boundary**: Caller-supplied paths are confined to the server working
  directory, caller configuration cannot route requests or credentials, and
  operator limits are ceilings (see above)
- **Input Validation**: Strict file type and size validation
- **SSRF Protection**: URL extraction blocks private ranges, link-local, and tunnel hosts, and pins DNS across redirects.
  Each local fetch has a 30-second idle timeout and a 120-second total deadline
- **Untrusted Output**: Extracted document text is treated as third-party content, never as instructions to the calling agent
- **Diagnostics**: The shared engine logger writes only to stderr and is
  disabled outside development by default. CLI diagnostics still run; redact
  private document text and local paths before sharing logs.
