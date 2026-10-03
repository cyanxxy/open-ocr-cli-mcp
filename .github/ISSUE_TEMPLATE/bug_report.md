---
name: Bug Report
about: Create a report to help us improve
title: "[BUG] "
labels: bug, needs-triage
assignees: ''

---

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
The exact command that fails and how the input was produced:

```bash
open-ocr-cli extract ...
```

**Expected behavior**
A clear and concise description of what you expected to happen.

**Output**
The relevant stderr/stdout, including any typed error code (`code`,
`category`, `hint`). Redact document contents you cannot share; never paste
API keys.

**Environment**
  - open-ocr-cli version: [e.g. `open-ocr-cli --version`]
  - Node.js version: [e.g. 22.13.0]
  - OS: [e.g. macOS 15, Ubuntu 24.04, Windows 11]
  - Provider and model: [e.g. gemini / gemini-3.8-flash]
  - Install method: [npm / Docker / GitHub Action / Homebrew]

**Additional context**
Add any other context about the problem here — config file contents (redacted),
whether `--dry-run` reproduces it, MCP host if using `open-ocr-cli mcp`.
