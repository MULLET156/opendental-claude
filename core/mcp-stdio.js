"use strict";
/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Implements initialize, ping, tools/list and tools/call — all Claude needs
 * for a tools-only server — without any npm dependencies.
 */

const readline = require("node:readline");
const { ODError } = require("./odclient");

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function createMcpHandler({ name, version, instructions, tools, log = () => {} }) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  /** Handle one parsed message; returns a response object or null for notifications. */
  return async function handle(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    }
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    const reply = (result) => (isRequest ? { jsonrpc: "2.0", id, result } : null);
    const fail = (code, message) => (isRequest ? { jsonrpc: "2.0", id, error: { code, message } } : null);

    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: tools.map(({ name: n, description, inputSchema, annotations }) => ({ name: n, description, inputSchema, annotations })),
        });
      case "tools/call": {
        const tool = toolMap.get(params.name);
        if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
        try {
          const result = await tool.run(params.arguments || {});
          return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
        } catch (e) {
          const message = e instanceof ODError ? e.message : "Unexpected error in the Open Dental connector.";
          if (!(e instanceof ODError)) log(e && e.stack);
          return reply({ content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true });
        }
      }
      default:
        if (method && method.startsWith("notifications/")) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  };
}

function serveStdio(handler, { log = () => {} } = {}) {
  const write = (m) => m && process.stdout.write(JSON.stringify(m) + "\n");
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    handler(msg)
      .then(write)
      .catch((e) => {
        log(e && e.stack);
        if (msg && msg.id != null) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } });
      });
  });
  rl.on("close", () => process.exit(0));
}

module.exports = { createMcpHandler, serveStdio, SUPPORTED_PROTOCOLS };
