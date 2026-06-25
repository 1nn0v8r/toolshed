// PM2 config for running dev-context-mcp as a long-lived HTTP service.
// Run `npm run build` first, then `pm2 start ecosystem.config.cjs`.
// MCP_AUTH_TOKEN must be set in the environment (the server refuses to boot without it).
module.exports = {
  apps: [
    {
      name: "dev-context-mcp",
      script: "dist/server.js",
      args: "--http",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        MCP_TRANSPORT: "http",
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "3000",
        // MCP_AUTH_TOKEN: "<set in your shell / pm2 env, not here>",
        // REPO_ROOT: "/abs/path/to/repo",
        // MCP_ALLOW_EXEC: "1",   // opt into dangerous tiers only if trusted
      },
    },
  ],
};
