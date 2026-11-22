# Node.js 24.22.3 (the 2026-11-10 security release) on Debian bookworm-slim.
# The tag names the exact Node.js release and the digest pins the image bytes.
# Dependabot proposes tag and digest updates for both stages; update the
# Node.js version named in these comments with them.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Every workspace manifest must be present for `npm ci` to reconcile the
# lockfile, even when the install is filtered to a single workspace.
COPY packages/engine/package.json packages/engine/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN npm ci --workspace=open-ocr-cli --include-workspace-root=false
COPY . .
RUN npm run cli:build

# Same Node.js 24.22.3 bookworm-slim image as the build stage.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
LABEL org.opencontainers.image.source="https://github.com/cyanxxy/open-ocr-cli-mcp"
LABEL org.opencontainers.image.description="Agent-first OCR CLI and MCP server"
ENV NODE_ENV=production
WORKDIR /opt/open-ocr
COPY package.json package-lock.json ./
# The engine is bundled into packages/cli/dist at build time; only its manifest
# is needed here so `npm ci` can still resolve the workspace graph.
COPY --from=build /src/packages/engine/package.json packages/engine/package.json
COPY --from=build /src/packages/cli packages/cli
RUN npm ci --omit=dev --workspace=open-ocr-cli --include-workspace-root=false \
    && ln -s /opt/open-ocr/node_modules/.bin/open-ocr-cli /usr/local/bin/open-ocr-cli \
    && npm cache clean --force \
    && mkdir -p /work \
    && chown node:node /work
WORKDIR /work
USER node
ENTRYPOINT ["open-ocr-cli"]
CMD ["--help"]
