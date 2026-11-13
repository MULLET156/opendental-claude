#!/usr/bin/env node
"use strict";
/**
 * Open Dental connector for Claude (desktop extension entry point).
 * Claude desktop starts this with its built-in Node runtime and passes the
 * settings from the extension's form as environment variables.
 */

// In the packed extension, core/ sits next to this file; in the repo it is two levels up.
function load(mod) {
  try {
    return require(`./core/${mod}`);
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
    return require(`../../core/${mod}`);
  }
}
const { createClient } = load("odclient");
const { buildTools } = load("tools");
const { createMcpHandler, serveStdio } = load("mcp-stdio");
const { version } = require("../manifest.json");

const log = (...a) => console.error("[opendental]", ...a);

// Unfilled optional settings can arrive as a literal "${user_config.x}".
function setting(name, fallback = "") {
  const v = (process.env[name] || "").trim();
  return !v || v.startsWith("${") ? fallback : v;
}

let od;
let configError = null;
try {
  od = createClient({
    baseUrl: setting("OD_BASE_URL"),
    developerKey: setting("OD_DEVELOPER_KEY"),
    customerKey: setting("OD_CUSTOMER_KEY"),
    maxRows: Number(setting("OD_MAX_ROWS", "500")),
    plan: setting("OD_API_PLAN", "standard"),
  });
} catch (e) {
  // Keep running so Claude can report the problem instead of a dead connector.
  configError = e;
  od = createClient({});
}
const allowWrites = setting("OD_ALLOW_WRITES", "false").toLowerCase() === "true";

let tools = buildTools(od, { allowWrites });
if (configError) {
  tools = tools.map((t) => ({ ...t, run: async () => { throw configError; } }));
}

const handler = createMcpHandler({
  name: "opendental",
  version,
  tools,
  log,
  instructions:
    "Open Dental practice data. Resolve providers and operatories to numbers first. Never guess between patients with similar names. Prefer od_run_report over custom SQL. Before any CHANGE tool, state the exact change and wait for the user's yes.",
});

serveStdio(handler, { log });
log(`started v${version}; ${od.baseUrl}; changes ${allowWrites ? "allowed" : "off"}${configError ? "; CONFIG ERROR: " + configError.message : ""}`);
