// @ts-check

/**
 * @typedef {import('./config.js').AuditOptions} AuditOptions
 * @typedef {import('./config.js').Finding} Finding
 * @typedef {import('./config.js').Severity} Severity
 * @typedef {import('./mcp-client.js').McpTool} McpTool
 * @typedef {import('./mcp-client.js').McpPrompt} McpPrompt
 * @typedef {import('./mcp-client.js').McpResource} McpResource
 *
 * @typedef {{
 *   server: string,
 *   name: string,
 *   totalBytes: number,
 *   totalTokens: number,
 *   descriptionChars: number,
 *   descriptionTokens: number,
 *   schemaTokens: number,
 *   schemaDepth: number,
 *   topLevelProps: number,
 *   hasAnnotations: boolean,
 * }} ToolAudit
 *
 * @typedef {{
 *   name: string,
 *   transport: 'stdio' | 'remote' | 'json',
 *   status: 'ok' | 'disabled' | 'skipped' | 'error',
 *   error?: string,
 *   serverInfo?: { name?: string, version?: string },
 *   protocolVersion?: string,
 *   toolCount: number,
 *   promptCount: number,
 *   resourceCount: number,
 *   toolTokens: number,
 *   promptTokens: number,
 *   resourceTokens: number,
 *   totalTokens: number,
 *   totalBytes: number,
 *   tools: ToolAudit[],
 * }} ServerReport
 *
 * @typedef {{
 *   source: string,
 *   strict: boolean,
 *   budget: number | null,
 *   budgetExceededBy: number,
 *   totalTokens: number,
 *   totalBytes: number,
 *   totalTools: number,
 *   totalPrompts: number,
 *   totalResources: number,
 *   servers: ServerReport[],
 *   topTools: ToolAudit[],
 *   findings: Finding[],
 *   counts: { error: number, warn: number, info: number },
 *   ok: boolean,
 * }} AuditReport
 */

/**
 * Estimate token count using the offline 4-chars-per-token heuristic.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Inspect JSON Schema structural complexity.
 * @param {unknown} schema
 * @param {number} [depth]
 * @param {Set<object>} [seen]
 * @returns {{ depth: number, topLevelProps: number, maxEnumSize: number }}
 */
export function inspectSchema(schema, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== "object") {
    return { depth, topLevelProps: 0, maxEnumSize: 0 };
  }
  if (seen.has(schema)) {
    return { depth, topLevelProps: 0, maxEnumSize: 0 };
  }
  seen.add(schema);

  const obj = /** @type {Record<string, unknown>} */ (schema);
  const props =
    obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)
      ? /** @type {Record<string, unknown>} */ (obj.properties)
      : null;

  const topLevelProps = depth === 0 && props ? Object.keys(props).length : 0;
  let maxDepth = depth;
  let maxEnumSize = Array.isArray(obj.enum) ? obj.enum.length : 0;

  /** @param {unknown} child @param {number} nextDepth */
  const visit = (child, nextDepth) => {
    if (!child || typeof child !== "object") return;
    const res = inspectSchema(child, nextDepth, seen);
    if (res.depth > maxDepth) maxDepth = res.depth;
    if (res.maxEnumSize > maxEnumSize) maxEnumSize = res.maxEnumSize;
  };

  if (props) {
    for (const propSchema of Object.values(props)) {
      visit(propSchema, depth + 1);
    }
  }
  if (obj.items) {
    if (Array.isArray(obj.items)) {
      for (const item of obj.items) visit(item, depth + 1);
    } else {
      visit(obj.items, depth + 1);
    }
  }
  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    visit(obj.additionalProperties, depth + 1);
  }
  for (const comb of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(obj[comb])) {
      for (const branch of /** @type {unknown[]} */ (obj[comb])) {
        visit(branch, depth + 1);
      }
    }
  }
  if (obj.$defs && typeof obj.$defs === "object") {
    for (const def of Object.values(/** @type {Record<string, unknown>} */ (obj.$defs))) {
      visit(def, depth + 1);
    }
  }

  return { depth: maxDepth, topLevelProps, maxEnumSize };
}

/**
 * Audit a single MCP tool definition.
 * @param {string} serverName
 * @param {McpTool} tool
 * @param {AuditOptions} opts
 * @returns {{ audit: ToolAudit, findings: Finding[] }}
 */
export function auditTool(serverName, tool, opts) {
  const name = typeof tool.name === "string" ? tool.name : "(unnamed)";
  const description = typeof tool.description === "string" ? tool.description : "";
  const schema = tool.inputSchema ?? {};
  const serializedTool = JSON.stringify(tool);
  const serializedSchema = JSON.stringify(schema);

  const totalBytes = Buffer.byteLength(serializedTool, "utf8");
  const totalTokens = estimateTokens(serializedTool);
  const descriptionChars = description.length;
  const descriptionTokens = estimateTokens(description);
  const schemaTokens = estimateTokens(serializedSchema);
  const { depth: schemaDepth, topLevelProps, maxEnumSize } = inspectSchema(schema);
  const hasAnnotations =
    Boolean(tool.annotations) &&
    typeof tool.annotations === "object" &&
    Object.keys(/** @type {object} */ (tool.annotations)).length > 0;

  /** @type {Finding[]} */
  const findings = [];

  if (totalTokens >= opts.maxToolTokens) {
    findings.push({
      rule: "tool.bloated",
      severity: "error",
      server: serverName,
      tool: name,
      message: `Tool schema costs ~${totalTokens} tokens (max ${opts.maxToolTokens}); trim description or split nested parameters`,
    });
  } else if (totalTokens >= opts.warnToolTokens) {
    findings.push({
      rule: "tool.bloated",
      severity: "warn",
      server: serverName,
      tool: name,
      message: `Tool schema costs ~${totalTokens} tokens (warn threshold ${opts.warnToolTokens})`,
    });
  }

  if (description.trim() === "") {
    findings.push({
      rule: "description.missing",
      severity: "warn",
      server: serverName,
      tool: name,
      message: "Missing tool description; agents rely on concise descriptions to pick the right tool",
    });
  } else if (descriptionChars > opts.maxDescriptionChars) {
    findings.push({
      rule: "description.verbose",
      severity: "warn",
      server: serverName,
      tool: name,
      message: `Description is ${descriptionChars} chars (>${opts.maxDescriptionChars}); long descriptions repeat on every turn`,
    });
  }

  if (schemaDepth > opts.maxSchemaDepth) {
    findings.push({
      rule: "schema.deep",
      severity: "warn",
      server: serverName,
      tool: name,
      message: `inputSchema nesting depth is ${schemaDepth} (>${opts.maxSchemaDepth}); deep schemas increase parameter hallucinations`,
    });
  }

  if (topLevelProps > opts.maxSchemaProps) {
    findings.push({
      rule: "schema.wide",
      severity: "warn",
      server: serverName,
      tool: name,
      message: `inputSchema has ${topLevelProps} top-level properties (>${opts.maxSchemaProps})`,
    });
  }

  if (maxEnumSize > 25) {
    findings.push({
      rule: "schema.unbounded-enum",
      severity: "warn",
      server: serverName,
      tool: name,
      message: `inputSchema contains an enum with ${maxEnumSize} values (>25), inflating every prompt turn`,
    });
  }

  if (!hasAnnotations) {
    findings.push({
      rule: "annotations.missing",
      severity: "info",
      server: serverName,
      tool: name,
      message: "No MCP tool annotations (readOnlyHint/destructiveHint) declared",
    });
  }

  return {
    audit: {
      server: serverName,
      name,
      totalBytes,
      totalTokens,
      descriptionChars,
      descriptionTokens,
      schemaTokens,
      schemaDepth,
      topLevelProps,
      hasAnnotations,
    },
    findings,
  };
}

/**
 * @typedef {{
 *   name: string,
 *   transport: 'stdio' | 'remote' | 'json',
 *   status: 'ok' | 'disabled' | 'skipped' | 'error',
 *   error?: string,
 *   serverInfo?: { name?: string, version?: string },
 *   protocolVersion?: string,
 *   tools: McpTool[],
 *   prompts: McpPrompt[],
 *   resources: McpResource[],
 *   staticFindings: Finding[],
 * }} ServerAuditInput
 */

/**
 * Build the complete AuditReport across all audited servers.
 * @param {{
 *   source: string,
 *   servers: ServerAuditInput[],
 *   options: AuditOptions,
 *   strict: boolean,
 *   top: number,
 * }} params
 * @returns {AuditReport}
 */
export function buildReport({ source, servers, options, strict, top }) {
  /** @type {Finding[]} */
  const allFindings = [];
  /** @type {ServerReport[]} */
  const serverReports = [];
  /** @type {ToolAudit[]} */
  const allTools = [];
  /** @type {Map<string, string[]>} */
  const toolNameOwners = new Map();

  for (const srv of servers) {
    allFindings.push(...srv.staticFindings);

    if (srv.status === "error") {
      allFindings.push({
        rule: "server.connect-failed",
        severity: "error",
        server: srv.name,
        message: srv.error ?? "Failed to inspect server",
      });
    }

    /** @type {ToolAudit[]} */
    const toolAudits = [];
    let toolBytes = 0;
    let toolTokens = 0;

    for (const tool of srv.tools) {
      const { audit, findings } = auditTool(srv.name, tool, options);
      toolAudits.push(audit);
      allTools.push(audit);
      allFindings.push(...findings);
      toolBytes += audit.totalBytes;
      toolTokens += audit.totalTokens;

      const owners = toolNameOwners.get(audit.name) ?? [];
      owners.push(srv.name);
      toolNameOwners.set(audit.name, owners);
    }

    const promptsJson = srv.prompts.length > 0 ? JSON.stringify(srv.prompts) : "";
    const resourcesJson = srv.resources.length > 0 ? JSON.stringify(srv.resources) : "";
    const promptBytes = Buffer.byteLength(promptsJson, "utf8");
    const resourceBytes = Buffer.byteLength(resourcesJson, "utf8");
    const promptTokens = estimateTokens(promptsJson);
    const resourceTokens = estimateTokens(resourcesJson);

    serverReports.push({
      name: srv.name,
      transport: srv.transport,
      status: srv.status,
      ...(srv.error ? { error: srv.error } : {}),
      ...(srv.serverInfo ? { serverInfo: srv.serverInfo } : {}),
      ...(srv.protocolVersion ? { protocolVersion: srv.protocolVersion } : {}),
      toolCount: srv.tools.length,
      promptCount: srv.prompts.length,
      resourceCount: srv.resources.length,
      toolTokens,
      promptTokens,
      resourceTokens,
      totalTokens: toolTokens + promptTokens + resourceTokens,
      totalBytes: toolBytes + promptBytes + resourceBytes,
      tools: toolAudits,
    });
  }

  // Detect tool name collisions across multiple enabled servers
  for (const [toolName, owners] of toolNameOwners.entries()) {
    const uniqueOwners = [...new Set(owners)];
    if (uniqueOwners.length > 1) {
      allFindings.push({
        rule: "tool.duplicate-name",
        severity: "error",
        server: uniqueOwners.join(", "),
        tool: toolName,
        message: `Tool name "${toolName}" is exposed by multiple servers (${uniqueOwners.join(", ")})`,
      });
    }
  }

  const ignored = new Set(options.ignoreRules);
  const findings = allFindings.filter((f) => !ignored.has(f.rule));

  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) {
    counts[f.severity]++;
  }

  const totalTokens = serverReports.reduce((sum, s) => sum + s.totalTokens, 0);
  const totalBytes = serverReports.reduce((sum, s) => sum + s.totalBytes, 0);
  const totalTools = serverReports.reduce((sum, s) => sum + s.toolCount, 0);
  const totalPrompts = serverReports.reduce((sum, s) => sum + s.promptCount, 0);
  const totalResources = serverReports.reduce((sum, s) => sum + s.resourceCount, 0);

  const budgetExceededBy =
    options.budget !== null && totalTokens > options.budget ? totalTokens - options.budget : 0;

  allTools.sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
  const topTools = top > 0 ? allTools.slice(0, top) : allTools;

  const ok =
    budgetExceededBy === 0 &&
    counts.error === 0 &&
    (!strict || counts.warn === 0);

  return {
    source,
    strict,
    budget: options.budget,
    budgetExceededBy,
    totalTokens,
    totalBytes,
    totalTools,
    totalPrompts,
    totalResources,
    servers: serverReports,
    topTools,
    findings,
    counts,
    ok,
  };
}

/**
 * Format report as human-readable terminal text.
 * @param {AuditReport} report
 * @param {{ showInfo?: boolean }} [opts]
 * @returns {string}
 */
export function formatHumanReport(report, opts = {}) {
  const lines = [];
  lines.push(`mcp-audit: ${report.source} (offline estimate: chars / 4)`);
  lines.push("");

  if (report.servers.length === 0) {
    lines.push("No MCP servers found.");
    return lines.join("\n") + "\n";
  }

  lines.push("Servers:");
  lines.push("  tokens   share   tools  prompts  resources  status    server");
  for (const srv of report.servers) {
    const share =
      report.totalTokens > 0
        ? `${((srv.totalTokens / report.totalTokens) * 100).toFixed(1)}%`
        : "0.0%";
    lines.push(
      `  ${formatNum(srv.totalTokens).padStart(6)}  ${share.padStart(6)}  ${String(srv.toolCount).padStart(5)}  ${String(srv.promptCount).padStart(7)}  ${String(srv.resourceCount).padStart(9)}  ${srv.status.padEnd(8)}  ${srv.name}`,
    );
  }
  lines.push("");

  if (report.topTools.length > 0) {
    lines.push(`Top tools (${report.topTools.length} of ${report.totalTools}):`);
    lines.push("  tokens   desc  schema  depth  server/tool");
    for (const t of report.topTools) {
      lines.push(
        `  ${formatNum(t.totalTokens).padStart(6)}  ${formatNum(t.descriptionTokens).padStart(4)}  ${formatNum(t.schemaTokens).padStart(6)}  ${String(t.schemaDepth).padStart(5)}  ${t.server}/${t.name}`,
      );
    }
    lines.push("");
  }

  const visibleFindings = opts.showInfo
    ? report.findings
    : report.findings.filter((f) => f.severity !== "info");

  if (visibleFindings.length > 0) {
    lines.push(`Findings (${visibleFindings.length}):`);
    for (const f of visibleFindings) {
      const tag = `[${f.severity.toUpperCase()}]`.padEnd(7);
      const target = f.tool ? `${f.server}/${f.tool}` : f.server;
      lines.push(`  ${tag} ${f.rule} (${target}): ${f.message}`);
    }
    lines.push("");
  }

  const hiddenInfoCount = opts.showInfo ? 0 : report.counts.info;
  const infoNote = hiddenInfoCount > 0 ? ` (${hiddenInfoCount} info hidden; pass --verbose to show)` : "";
  lines.push(
    `Total: ${formatNum(report.totalTokens)} tokens (${formatNum(report.totalBytes)} bytes) across ${report.totalTools} tools, ${report.totalPrompts} prompts, ${report.totalResources} resources`,
  );
  if (report.budget !== null) {
    if (report.budgetExceededBy > 0) {
      lines.push(
        `Budget: EXCEEDED ${formatNum(report.budget)} token budget by ${formatNum(report.budgetExceededBy)} tokens`,
      );
    } else {
      lines.push(`Budget: OK (${formatNum(report.totalTokens)} / ${formatNum(report.budget)} tokens)`);
    }
  }
  lines.push(
    `Summary: ${report.counts.error} errors, ${report.counts.warn} warnings, ${report.counts.info} info${infoNote}`,
  );
  lines.push(report.ok ? "Status: OK" : "Status: Problems found.");
  return lines.join("\n") + "\n";
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatNum(n) {
  return n.toLocaleString("en-US");
}
