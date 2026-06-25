// HTTP / Streamable transport (the "anywhere / containerized" mode).
//
// Hardened by design:
//   • MCP_AUTH_TOKEN is REQUIRED — the server refuses to start without one.
//   • Binds 127.0.0.1 by default (MCP_HTTP_HOST to expose; pair with a reverse
//     proxy + TLS for any non-loopback use).
//   • One MCP Server + one Session per connection, so concurrent clients are
//     fully isolated (a set_repo_root in one never leaks into another).

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Session, Transport } from "./security.js";

export interface HttpDeps {
  createServer: (session: Session) => Server;
  makeSession: (transport: Transport) => Session;
}

// Length-safe constant-time-ish token comparison.
function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export async function startHttpServer(deps: HttpDeps): Promise<void> {
  const host = process.env.MCP_HTTP_HOST || "127.0.0.1";
  const port = Number(process.env.MCP_HTTP_PORT || 3000);
  const token = process.env.MCP_AUTH_TOKEN;

  if (!token) {
    console.error(
      "FATAL: HTTP transport requires MCP_AUTH_TOKEN. Set it to a long random secret and restart."
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json({ limit: "8mb" }));

  // Unauthenticated liveness probe for container healthchecks.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, transport: "http" });
  });

  function authorized(req: Request, res: Response): boolean {
    const header = String(req.headers["authorization"] ?? "");
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || !tokenMatches(provided, token!)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: missing or invalid bearer token." },
        id: null,
      });
      return false;
    }
    return true;
  }

  // sessionId → transport. Each entry owns its own MCP Server + Session.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req: Request, res: Response) => {
    if (!authorized(req, res)) return;

    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;

    if (!transport) {
      // Only an initialize request may open a new session.
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid session. Send an initialize request first." },
          id: null,
        });
        return;
      }

      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, newTransport);
        },
      });
      newTransport.onclose = () => {
        if (newTransport.sessionId) transports.delete(newTransport.sessionId);
      };

      // Fresh, isolated server + session for this connection.
      const server = deps.createServer(deps.makeSession("http"));
      // SDK concrete transports type `onclose` as `(() => void) | undefined`,
      // which trips exactOptionalPropertyTypes against Transport's optional
      // `onclose?`. The class is structurally a valid Transport — assert at this
      // boundary only.
      await server.connect(newTransport as unknown as Parameters<typeof server.connect>[0]);
      transport = newTransport;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // GET = open the SSE stream; DELETE = terminate the session. Both route by id.
  const bySession = async (req: Request, res: Response) => {
    if (!authorized(req, res)) return;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      res.status(400).send("Unknown or missing mcp-session-id.");
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);

  app.listen(port, host, () => {
    console.error(
      `dev-context-mcp v3 running (http, hardened) on http://${host}:${port}/mcp — bearer token required.`
    );
  });
}
