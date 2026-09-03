#!/usr/bin/env node
// camofox-browser MCP server
//
// Standalone Model Context Protocol server that exposes the camofox-browser
// REST API (default http://localhost:9377) as MCP tools. Tool names, schemas,
// REST routes, request bodies, auth, and response shaping are imported from
// mcp/lib/tool-contracts.mjs — the SAME source of truth the OpenClaw plugin
// (plugin.ts) uses — so behavior is identical whether an agent reaches camofox
// via OpenClaw or MCP. Drift is structurally impossible.
//
// Transport: stdio (Claude Code / Codex / agy / Cursor / opencode spawn this as
// a child process). The camofox REST server itself must be running (npm start) —
// this server only forwards calls, it does not launch the browser.
//
// Auth:
//   - CAMOFOX_ACCESS_KEY (global): forwarded as `Authorization: Bearer` on every
//     request so globally-authenticated REST servers accept MCP traffic.
//   - CAMOFOX_API_KEY (cookie import): forwarded as `Authorization: Bearer` on
//     the cookie-import route only.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { loadMcpConfig } from "./lib/config.mjs";
import {
  TOOL_DEFS,
  runTool,
  adaptResponse,
} from "./lib/tool-contracts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Version from this package's own package.json (single source — no hardcoded
// duplicate). mcp/ is an independently installable package (@askjo/camofox-browser-ai-mcp)
// with its own manifest, so this reads locally rather than the parent repo's.
const VERSION = JSON.parse(
  readFileSync(join(__dirname, "package.json"), "utf8")
).version;

// Server config (apiKey / accessKey / cookiesDir / port). The standalone
// package reads only its own environment settings; CAMOFOX_BASE_URL overrides
// the derived local URL.
const CONFIG = loadMcpConfig();
const BASE_URL = process.env.CAMOFOX_BASE_URL || `http://localhost:${CONFIG.port}`;

// Per-MCP-server userId so each host session gets an isolated camofox session
// (cookie/storage partition). Falls back to a random id.
const USER_ID = process.env.CAMOFOX_USER_ID || `mcp-${randomUUID()}`;
// sessionKey partitions tabs within a user (matches plugin.ts fallback "default").
const SESSION_KEY = process.env.CAMOFOX_SESSION_KEY || "default";

// Adapter-LOCAL tools (not REST-proxied) + per-call profile routing (level 2).
// The sanitized registry proxyctl writes on the host (id/port/country/hasProxy/
// loggedIn/status — no creds) is read here; the REST server can't serve it (a
// container only sees its own profile). `camofox_use_profile` switches the ACTIVE
// routing (baseUrl + userId) so subsequent REST tools hit that profile's browser
// — one adapter drives the whole fleet, no per-profile MCP registration needed.
const REGISTRY_FILE = process.env.CAMOFOX_REGISTRY_FILE || "/run/camofox-registry.json";

// Mutable active routing (per MCP-server process = per host session). Defaults to
// the env-configured profile; use_profile overrides it.
let activeBaseUrl = BASE_URL;
let activeUserId = USER_ID;

function readRegistry() {
  return JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
}

const LOCAL_TOOLS = [
  {
    name: "camofox_list_profiles",
    description:
      "List camofox fleet profiles (id, port, country, hasProxy, loggedIn, status). Each is a separate browser with its own proxy/identity and possibly a saved login. Use camofox_use_profile to switch to one.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "camofox_use_profile",
    description:
      "Switch the ACTIVE profile for subsequent tools: routes calls to that profile's browser (its proxy/identity/login) using its userId. Pass the `profile` id from camofox_list_profiles. Tabs are per-profile — switching starts fresh (old tabIds won't apply). Default profile is used until you call this.",
    inputSchema: {
      type: "object",
      properties: { profile: { type: "string", description: "profile id (from camofox_list_profiles)" } },
      required: ["profile"],
    },
  },
  {
    name: "camofox_current_profile",
    description: "Show the currently active routing (baseUrl + userId).",
    inputSchema: { type: "object", properties: {} },
  },
];

function handleLocalTool(name, args) {
  if (name === "camofox_list_profiles") {
    try {
      return { content: [{ type: "text", text: readFileSync(REGISTRY_FILE, "utf8") }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `registry unavailable: ${err.message}`, path: REGISTRY_FILE }) }] };
    }
  }
  if (name === "camofox_current_profile") {
    return { content: [{ type: "text", text: JSON.stringify({ baseUrl: activeBaseUrl, userId: activeUserId }) }] };
  }
  if (name === "camofox_use_profile") {
    const pid = (args && args.profile) || "";
    let reg;
    try {
      reg = readRegistry();
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `registry unavailable: ${err.message}` }) }] };
    }
    const entry = reg.find((p) => p.id === pid);
    if (!entry) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `unknown profile '${pid}'`, available: reg.map((p) => p.id) }) }] };
    }
    activeBaseUrl = entry.baseUrl || `http://127.0.0.1:${entry.port}`;
    activeUserId = entry.userId || entry.id;
    return { content: [{ type: "text", text: JSON.stringify({ active: entry.id, baseUrl: activeBaseUrl, userId: activeUserId, loggedIn: entry.loggedIn }) }] };
  }
  return null;
}

// The standalone package declares the SDK directly. Surface a clear,
// actionable error if an incomplete installation is missing it.
let Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema;
try {
  const serverMod = await import("@modelcontextprotocol/sdk/server/index.js");
  Server = serverMod.Server;
  const stdioMod = await import("@modelcontextprotocol/sdk/server/stdio.js");
  StdioServerTransport = stdioMod.StdioServerTransport;
  const typesMod = await import("@modelcontextprotocol/sdk/types.js");
  CallToolRequestSchema = typesMod.CallToolRequestSchema;
  ListToolsRequestSchema = typesMod.ListToolsRequestSchema;
} catch {
  console.error(
    "[camofox-browser-mcp] @modelcontextprotocol/sdk is not installed.\n" +
      "Install the adapter dependencies with: npm install\n" +
      "from the @askjo/camofox-browser-ai-mcp package directory."
  );
  process.exit(1);
}

const server = new Server(
  { name: "camofox-browser", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...TOOL_DEFS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    ...LOCAL_TOOLS,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const local = handleLocalTool(name, args);
  if (local) return local;
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }
  try {
    const { spec, payload } = await runTool(
      name,
      args || {},
      { userId: activeUserId, sessionKey: SESSION_KEY },
      activeBaseUrl,
      CONFIG
    );
    const content = adaptResponse(spec, payload);
    return { content };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `camofox error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[camofox-browser-mcp] v${VERSION} connected → ${BASE_URL} (user=${USER_ID})`
);
