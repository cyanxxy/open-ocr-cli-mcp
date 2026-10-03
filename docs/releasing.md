# Releasing Open OCR CLI + MCP

Open OCR CLI uses one semantic version for the root project, npm package, lock
file, GitHub Release, container tag, Homebrew formula, and GitHub Action tag.

## One-time repository setup

1. On npm, configure `open-ocr-cli` to trust the GitHub Actions publisher:
   organization/user `cyanxxy`, repository `open-ocr-cli-mcp`, workflow
   `release.yml`, with the allowed action **`npm publish`** enabled for this
   workflow's direct publication. Follow npm's
   [trusted-publisher setup](https://docs.npmjs.com/trusted-publishers/).
   The workflow uses a
   GitHub-hosted runner with `id-token: write`; no long-lived npm token is
   required.
   After a repository rename, update this trusted-publisher binding on npm
   before the next release; GitHub redirects do not update npm authorization.
2. Ensure GitHub Actions can write repository contents and packages. Enable
   GHCR for the repository and keep tag protection aligned with the maintainers
   allowed to release.
3. Enable GitHub Discussions and the Marketplace listing if those community
   surfaces are wanted. The repository already contains `action.yml`, branding,
   issue forms, and discussion templates.

## Release checklist

1. Update `CHANGELOG.md` and keep the version identical in `package.json`,
   `package-lock.json`, `packages/cli/package.json`, and
   `packages/engine/package.json`. `scripts/assert-release-version.mjs` checks
   every one of them, including workspace entries and the CLI's engine dependency
   in the lockfile.
   Use a new version, move the release's changes out of `Unreleased` into its
   dated version heading, and never reuse a published version or existing tag.
2. Run the local gates:

   ```bash
   npm ci
   npm run typecheck
   npm run lint
   npm run test:coverage
   node --test scripts/release-automation.test.mjs
   npm run evals:validate
   npm run evals:matrix:check
   npm run cli:smoke
   npm pack ./packages/cli --dry-run
   npm run cli:install-smoke
   npm run action:smoke
   npx audit-ci --config audit-ci.json
   docker build --tag open-ocr-cli:release-candidate .
   VERSION=$(node -p "require('./packages/cli/package.json').version")
   node scripts/assert-release-version.mjs "v$VERSION"
   ```

3. When provider credentials are available, run the canary evaluation matrix
   with a private copy of `evals/providers.example.json`. Review quality,
   latency, and billed-cost deltas before promoting the release.
4. Create a release PR and use a squash or merge commit after required checks
   pass, so its version bump is present relative to the first parent. A successful
   `CI Pipeline` push run on `main` triggers the release workflow. It verifies
   that exact CI commit, creates its immutable `v<version>` tag, and dispatches
   `release.yml` at that tag. Ordinary commits with an already released version
   do not publish again. GitHub's token does not trigger workflows from tag
   pushes, so the explicit dispatch is required.
5. Confirm both the automatic dispatch and tagged release runs succeeded and
   published all five surfaces: npm, GitHub Release,
   `ghcr.io/cyanxxy/open-ocr-cli`, the attached Homebrew formula, and the moving
   matching major GitHub Action tag (currently `v4`). The workflow only moves
   that major tag forward from an ancestor
   and uses a force-with-lease so a concurrent tag change cannot be overwritten.
   Install from npm and run `open-ocr-cli doctor` once outside the repository.

If publication fails, fix its external prerequisite and rerun the failed
tagged `Release` workflow, or dispatch `release.yml` with the immutable tag as
the ref. Never dispatch publication from a branch. Completed releases are
skipped; a retry verifies existing npm package bytes and refuses to move
`latest` behind a newer version.

## Rollback

Never move or overwrite an immutable release tag. If a release is bad,
deprecate that npm version with a clear message and document the affected
container tag. A maintainer may explicitly restore the moving major Action tag
to a safe release; the release workflow itself refuses backward promotion.
Ship a patch release and preserve the original immutable artifacts for auditability.
