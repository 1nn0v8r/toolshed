# syntax=docker/dockerfile:1

# ── builder: install all deps and compile TS → dist/ ──────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ── runtime (light): fetch_url + web_search, ripgrep, no browser ──────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# ripgrep powers the fast search path.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Non-root; /workspace is the only writable mount (the repo you operate on).
RUN useradd -r -u 10001 -m appuser \
    && mkdir -p /workspace && chown appuser:appuser /workspace
USER appuser

ENV MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000 \
    REPO_ROOT=/workspace \
    MCP_ROOT_BASE=/workspace
EXPOSE 3000

# MCP_AUTH_TOKEN must be supplied at runtime — the server refuses to boot without it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]

# ── browser (heavy): adds Playwright + Chromium for browse_page/screenshot ────
# Build with:  docker build --target browser -t dev-context-mcp:browser .
FROM runtime AS browser
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    MCP_CHROMIUM_NO_SANDBOX=1
RUN npm install playwright@^1 \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rx /ms-playwright \
    && chown -R appuser:appuser /app
USER appuser
