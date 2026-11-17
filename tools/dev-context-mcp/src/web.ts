// Web / browse tools.
//
//   • fetch_url    — GET a URL, return readable text (HTML stripped) or raw body.
//   • web_search   — Brave (BRAVE_API_KEY) → keyless DuckDuckGo → Tavily (TAVILY_API_KEY).
//   • browse_page  — render a JS page with Playwright (lazy/optional) and read text.
//   • screenshot   — Playwright screenshot to a file or inline image.
//
// All network egress is SSRF-guarded in hardened (HTTP) mode: only http(s),
// and private/loopback targets are blocked (checked across redirects + DNS).
// External content is wrapped as untrusted so the model treats it as data.

import dnsP from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { untrusted, safePathIn } from "./util.js";
import { confineRoot, type Session } from "./security.js";

type ToolResult = CallToolResult;

const WEB_TOOLS = new Set(["fetch_url", "web_search", "browse_page", "screenshot"]);
export function isWebTool(name: string): boolean {
  return WEB_TOOLS.has(name);
}

// ─── SSRF guard ────────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    const parts = ip.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local
  if (v.startsWith("fe80")) return true; // link-local
  return false;
}

async function assertAllowed(rawUrl: string, session: Session): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  if (session.fullPower) return u; // local trust — no private-range block

  const host = u.hostname;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Blocked by SSRF guard: private/loopback address.");
  } else {
    const addrs = await dnsP.lookup(host, { all: true });
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        throw new Error(`Blocked by SSRF guard: ${host} resolves to a private address.`);
      }
    }
  }
  return u;
}

// Fetch with a timeout, following redirects manually so each hop is re-validated.
async function safeFetch(
  rawUrl: string,
  session: Session,
  init: RequestInit = {},
  timeoutMs = 15_000
): Promise<Response> {
  let url = (await assertAllowed(rawUrl, session)).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "dev-context-mcp/3.0 (+mcp)", ...(init.headers ?? {}) },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = new URL(res.headers.get("location")!, url).toString();
        url = (await assertAllowed(next, session)).toString();
        continue;
      }
      return res;
    }
    throw new Error("Too many redirects.");
  } finally {
    clearTimeout(timer);
  }
}

// ─── HTML → text ─────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── fetch_url ─────────────────────────────────────────────────────────────

async function fetchUrl(args: Record<string, unknown>, session: Session): Promise<ToolResult> {
  const url = String(args.url ?? "").trim();
  if (!url) throw new Error("url is required.");
  const maxChars = Math.min(Number(args.maxChars ?? 15_000) || 15_000, 50_000);
  const raw = Boolean(args.raw);

  const res = await safeFetch(url, session);
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();

  const isHtml = /html/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(body);
  const text = !raw && isHtml ? htmlToText(body) : body;
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]` : text;

  const header = `URL: ${res.url || url}\nStatus: ${res.status}\nContent-Type: ${contentType || "unknown"}\n\n`;
  return { content: [{ type: "text", text: untrusted(header + clipped) }] };
}

// ─── web_search ───────────────────────────────────────────────────────────

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

async function searxngSearch(query: string, count: number, baseUrl: string): Promise<SearchHit[]> {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const u = new URL("search", root);
  u.searchParams.set("q", query);
  u.searchParams.set("format", "json");
  const res = await fetch(u, { headers: { accept: "application/json", "user-agent": "dev-context-mcp/3.0" } });
  if (!res.ok) {
    throw new Error(
      `SearXNG search failed: ${res.status}` +
        (res.status === 403 ? " — enable the JSON format in your instance's settings.yml (search.formats: [html, json])." : "")
    );
  }
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

async function tavilySearch(query: string, count: number, key: string): Promise<SearchHit[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: count }),
  });
  if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

async function duckSearch(query: string, count: number): Promise<SearchHit[]> {
  const u = new URL("https://html.duckduckgo.com/html/");
  u.searchParams.set("q", query);
  const res = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 dev-context-mcp" } });
  if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status}`);
  const html = await res.text();

  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(htmlToText(sm[1] ?? ""));

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) && hits.length < count) {
    let href = lm[1] ?? "";
    // DDG wraps links as /l/?uddg=<encoded-target>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1] ?? "");
    hits.push({ title: htmlToText(lm[2] ?? ""), url: href, snippet: snippets[i] ?? "" });
    i++;
  }
  return hits;
}

async function webSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("query is required.");
  const count = Math.min(Number(args.count ?? 6) || 6, 15);

  const searxng = process.env.SEARXNG_URL;
  const tavily = process.env.TAVILY_API_KEY;

  let hits: SearchHit[];
  let provider: string;
  try {
    if (searxng) {
      provider = "searxng";
      hits = await searxngSearch(query, count, searxng);
    } else if (tavily) {
      provider = "tavily";
      hits = await tavilySearch(query, count, tavily);
    } else {
      provider = "duckduckgo (keyless — set SEARXNG_URL for a private, reliable backend)";
      hits = await duckSearch(query, count);
    }
  } catch (e) {
    return { content: [{ type: "text", text: `Search failed: ${(e as Error).message}` }], isError: true };
  }

  if (hits.length === 0) {
    return { content: [{ type: "text", text: `No results for "${query}" (provider: ${provider}).` }] };
  }
  const body = hits
    .map((h, n) => `${n + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`.trim())
    .join("\n\n");
  return { content: [{ type: "text", text: untrusted(`Search results for "${query}" (provider: ${provider}):\n\n${body}`) }] };
}

// ─── Playwright (lazy / optional) ─────────────────────────────────────────────

const PLAYWRIGHT_HINT =
  "Playwright is not installed, so browser tools are disabled. To enable them, run:\n" +
  "  npm install playwright && npx playwright install chromium\n" +
  "(In Docker, use the 'browser' image profile.) Until then, use fetch_url for static pages.";

async function loadChromium(): Promise<any | null> {
  try {
    // Indirect specifier so tsc doesn't statically resolve the optional dep.
    const spec = "playwright";
    const pw = await import(spec);
    return pw.chromium ?? null;
  } catch {
    return null;
  }
}

// Chromium can't use its setuid sandbox as a non-root user inside a container;
// MCP_CHROMIUM_NO_SANDBOX=1 (set in the Docker browser image) drops it. The
// container itself provides the isolation.
function launchOptions(): { headless: boolean; args: string[] } {
  const args: string[] = [];
  if (process.env.MCP_CHROMIUM_NO_SANDBOX) args.push("--no-sandbox", "--disable-setuid-sandbox");
  return { headless: true, args };
}

async function browsePage(args: Record<string, unknown>, session: Session): Promise<ToolResult> {
  const url = String(args.url ?? "").trim();
  if (!url) throw new Error("url is required.");
  await assertAllowed(url, session);

  const chromium = (await loadChromium()) as
    | { launch: (o: unknown) => Promise<any> }
    | null;
  if (!chromium) return { content: [{ type: "text", text: PLAYWRIGHT_HINT }], isError: true };

  const waitMs = Math.min(Number(args.waitMs ?? 0) || 0, 15_000);
  const selector = String(args.selector ?? "").trim();
  const maxChars = Math.min(Number(args.maxChars ?? 15_000) || 15_000, 50_000);

  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (waitMs) await page.waitForTimeout(waitMs);
    const text: string = selector
      ? await page.locator(selector).first().innerText()
      : await page.evaluate(() => (globalThis as any).document.body.innerText);
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n… [truncated]` : text;
    return { content: [{ type: "text", text: untrusted(`URL: ${url}\n\n${clipped}`) }] };
  } finally {
    await browser.close();
  }
}

async function screenshot(args: Record<string, unknown>, session: Session): Promise<ToolResult> {
  const url = String(args.url ?? "").trim();
  if (!url) throw new Error("url is required.");
  await assertAllowed(url, session);

  const chromium = (await loadChromium()) as
    | { launch: (o: unknown) => Promise<any> }
    | null;
  if (!chromium) return { content: [{ type: "text", text: PLAYWRIGHT_HINT }], isError: true };

  const fullPage = Boolean(args.fullPage);
  const outPath = String(args.path ?? "").trim();

  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const buf: Buffer = await page.screenshot({ fullPage });

    if (outPath) {
      const override = String(args.repoRoot ?? "").trim();
      const root = override ? confineRoot(session, path.resolve(override)) : session.root;
      const dest = safePathIn(root, outPath);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      return { content: [{ type: "text", text: `Screenshot of ${url} saved to ${outPath} (${buf.length} bytes).` }] };
    }
    return {
      content: [
        { type: "text", text: `Screenshot of ${url} (${buf.length} bytes):` },
        { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
      ],
    };
  } finally {
    await browser.close();
  }
}

// ─── dispatch + definitions ───────────────────────────────────────────────────

export async function handleWebTool(
  toolName: string,
  args: Record<string, unknown>,
  session: Session
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case "fetch_url":
        return await fetchUrl(args, session);
      case "web_search":
        return await webSearch(args);
      case "browse_page":
        return await browsePage(args, session);
      case "screenshot":
        return await screenshot(args, session);
      default:
        throw new Error(`Unknown web tool: ${toolName}`);
    }
  } catch (e) {
    // Surface expected failures (SSRF block, bad URL, network/timeout) as a tool
    // result the model can react to, not a hard protocol error.
    return { content: [{ type: "text", text: `${toolName} failed: ${(e as Error).message}` }], isError: true };
  }
}

export function getWebToolDefinitions(): Tool[] {
  return [
    {
      name: "fetch_url",
      description:
        "Fetch a URL over http(s) and return readable text (HTML is stripped to text) or the raw body. " +
        "Use for reading docs, API responses, or static pages. For JS-heavy pages use browse_page.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." },
          raw: { type: "boolean", description: "Return the raw body instead of stripping HTML. Default false." },
          maxChars: { type: "number", description: "Max characters to return. Default 15000, max 50000." },
        },
        required: ["url"],
      },
    },
    {
      name: "web_search",
      description:
        "Search the web and return a ranked list of {title, url, snippet}. Uses a self-hosted SearXNG instance " +
        "(if SEARXNG_URL set), else Tavily (if TAVILY_API_KEY set), else a keyless DuckDuckGo fallback. " +
        "Follow up with fetch_url to read a result.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          count: { type: "number", description: "Number of results. Default 6, max 15." },
        },
        required: ["query"],
      },
    },
    {
      name: "browse_page",
      description:
        "Render a JavaScript-heavy page in a headless browser (Playwright) and return its text. " +
        "Requires Playwright to be installed; otherwise returns setup instructions. Use fetch_url for static pages.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." },
          selector: { type: "string", description: "Optional CSS selector to extract text from (else whole body)." },
          waitMs: { type: "number", description: "Extra wait after load, ms (max 15000)." },
          maxChars: { type: "number", description: "Max characters to return. Default 15000, max 50000." },
        },
        required: ["url"],
      },
    },
    {
      name: "screenshot",
      description:
        "Screenshot a page with a headless browser (Playwright). Saves to `path` (relative to repo root) if given, " +
        "otherwise returns an inline PNG. Requires Playwright; otherwise returns setup instructions.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." },
          fullPage: { type: "boolean", description: "Capture the full scrollable page. Default false." },
          path: { type: "string", description: "Optional repo-relative path to save the PNG to." },
        },
        required: ["url"],
      },
    },
  ];
}
