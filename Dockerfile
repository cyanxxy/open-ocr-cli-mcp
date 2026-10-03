FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Every workspace manifest must be present for `npm ci` to reconcile the
# lockfile, even when the install is filtered to a single workspace.
COPY packages/engine/package.json packages/engine/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN npm ci --workspace=open-ocr-cli --include-workspace-root=false
COPY . .
RUN npm run cli:build

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
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
