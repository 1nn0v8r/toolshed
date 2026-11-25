# syntax=docker/dockerfile:1

FROM node:22-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY cli ./cli
COPY tools ./tools

# Install & build dev-context-mcp (and repo-pack's single dependency)
RUN npm --prefix tools/dev-context-mcp ci --ignore-scripts \
    && npm --prefix tools/dev-context-mcp run build \
    && npm --prefix tools/repo-pack ci --omit=dev --ignore-scripts \
    && npm cache clean --force

RUN useradd -r -u 10001 -m appuser \
    && mkdir -p /workspace && chown -R appuser:appuser /app /workspace
USER appuser

EXPOSE 4317 3000

CMD ["node", "bin/toolshed.js", "ui", "--host", "0.0.0.0", "--port", "4317", "--no-open"]
