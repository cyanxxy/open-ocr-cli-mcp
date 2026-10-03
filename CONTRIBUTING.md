# Contributing

Thanks for contributing to Open OCR CLI, MCP server, and shared engine.

## Good First Contributions

- Add or improve eval fixtures under `evals/cases/` and `evals/corpus/`
- Tighten README and docs
- Improve shipped preset copy or result rendering
- Add tests for non-networked logic

Look for issues labeled:

- `good first issue`
- `help wanted`
- `docs`

## Repository Layout

This is an npm workspace with two packages and no web app:

| Path | What it is |
| --- | --- |
| `packages/engine` | `@open-ocr/engine` — the shared extraction engine. Private, source-only, never published; the CLI bundles it at build time. Node-only: typechecked without DOM libs. |
| `packages/cli` | The published `open-ocr-cli` package, including the stdio MCP server. Owns its own build and protocol schemas. |
| `evals/` | Evaluation corpus and `tsx` runner. |
| `integrations/open-ocr/skills` | Agent skill source of truth (`packages/cli/skills` is a generated copy). |
| `scripts/` | Release, packaging, and smoke-test tooling. |

## Local Setup

Use Node.js 20.19+, 22.13+, or 24+; Node 24 is used for release builds.
The root `packageManager` field pins the npm version used by the release gate.

```bash
git clone https://github.com/cyanxxy/open-ocr-cli-mcp.git
cd open-ocr-cli-mcp
npm ci
npm run cli -- --help
```

`npm ci` at the repository root installs every workspace; there is no separate
install step inside `packages/`.

Before opening a PR, run:

```bash
npm run typecheck
npm run lint
npm run test:coverage
npm run cli:smoke
npm run evals:validate
npm run evals:matrix:check
npm run cli:install-smoke
```

## Pull Requests

1. Fork the repo and create a focused branch.
2. Keep changes scoped to one concern when possible.
3. Add or update tests for behavior changes.
4. Update docs when user-facing behavior changes.
5. If your change affects templates or evals, include the fixture or report impact in the PR description.

Use [Conventional Commits](https://www.conventionalcommits.org/) when practical.

## Project Contract

The project maintains one current contract and does not add fallbacks for
earlier releases. When a contract changes, delete superseded schemas, aliases,
configuration paths, migrations, negotiation branches, documentation, and
tests in the same change.

## Templates And Evals

- New presets should reuse the shared `ExtractionRule` schema.
- New eval cases should use assertion-based checks instead of prose-only expectations.
- OCR quality cases should include a ground-truth reference and objective metric thresholds.
- Do not commit private or sensitive documents to `evals/corpus/`.
- Do not commit `evals/cache/`; use `npm run evals:setup` to reproduce public subsets.
- Keep checked-in reports under `evals/reports/` readable and deterministic.
- Preserve historical reports unless you ran the corresponding live evaluation;
  validation and Markdown rendering do not produce new model-quality evidence.

See [evals/README.md](evals/README.md) for provider configuration, optional public
dataset setup, repetitions, matrix runs, and cost reporting. Live evals use
environment settings rather than `.open-ocr-cli.json`.

## Discussions

If Discussions are enabled, use:

- `show-and-tell` for sharing presets or workflows
- `eval-failures` for reporting misses and regressions

## Intentionally Untracked Files

Some files are excluded from the repo on purpose via `.gitignore`, so don't be surprised if you can't find them:

- `AGENTS.md` and `CLAUDE.md` — local AI-agent context, kept per-developer.
- `ROADMAP.md`, `docs/2026-agentic-ocr-evals-plan.md`, and `docs/launch-playbook.md` — internal planning notes that are not maintained as public docs.
- `evals/reports/runs/` and `evals/reports/matrix*` — local benchmark artifacts.

Keep these local files out of commits. Use GitHub Issues and Discussions for
roadmap and planning conversations.

## Releases

Releases are created from matching semantic version tags after the release
checklist in [docs/releasing.md](docs/releasing.md) is complete:

```bash
VERSION=$(node -p "require('./packages/cli/package.json').version")
git tag "v$VERSION"
git push origin "v$VERSION"
```

The release workflow repeats the quality and security gates, publishes the npm
tarball with provenance, builds the container, attaches the Homebrew formula,
creates the GitHub Release, and updates the matching major GitHub Action tag.
