"use strict";
/**
 * Gateway mode: the same client interface as createClient() in odclient.js,
 * but every call goes through the Open Dental app gateway with this module's
 * own app key, instead of straight to Open Dental. The office's Open Dental
 * keys never reach the module.
 *
 *   const od = createGatewayClient({ url: "http://127.0.0.1:8787", key: process.env.GATEWAY_KEY });
 *   await od.request("GET", "/patients/12");                 -> GET  {url}/v1/od/patients/12
 *   await od.getAll("/appointments", { date: "2026-11-16" }); -> GET  {url}/v1/od/appointments?all=true
 *   await od.runReport("daysheet", { date: "2026-11-16" });   -> POST {url}/v1/reports/daysheet
 *   await od.shortQuery("SELECT ...");                        -> POST {url}/v1/query (only for rawSql apps)
 *
 * The connector's tools (notes, group notes, planning, priorities, read-back
 * checks) take any client with this interface, so they work unchanged.
 *
 * Safety: the key is only sent to the configured gateway URL; redirects are
 * never followed; plain http only for this computer or the office network;
 * error messages never include the key.
 */

const { ODError, guardReadOnlySql } = require("./odclient");

const KEY_RE = /^[A-Za-z0-9_\-]{16,200}$/;

function isPrivateHost(host) {
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !host.includes(".") || /\.(local|lan|internal|home\.arpa)$/.test(host);
}

/** Accepts http://host:8787, http://host:8787/v1 or http://host:8787/v1/od; returns the root. */
function normalizeGatewayUrl(raw) {
  const value = String(raw || "").trim() || "http://127.0.0.1:8787";
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new ODError("GATEWAY_URL is not a valid URL.", { code: "config" });
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new ODError("GATEWAY_URL must not contain a username, password, query or fragment.", { code: "config" });
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ODError("GATEWAY_URL must start with https:// or http://.", { code: "config" });
  if (u.protocol === "http:" && !isPrivateHost(u.hostname)) {
    throw new ODError("Plain http is only allowed for the gateway on this computer or the office network. Use https for anything else.", { code: "config" });
  }
  u.pathname = u.pathname.replace(/\/+$/, "").replace(/\/v1(\/od)?$/i, "");
  return u.toString().replace(/\/+$/, "");
}

/**
 * @param {object} opts
 * @param {string} [opts.url]           Gateway root (default http://127.0.0.1:8787). "/v1/od" may be included.
 * @param {string} opts.key             This module's gateway app key.
 * @param {number} [opts.maxRows=500]
 * @param {number} [opts.timeoutMs=60000]
 * @param {number} [opts.maxResponseBytes=20MB]
 * @param {Function} [opts.fetch]       Injected fetch for tests.
 */
function createGatewayClient(opts = {}) {
  const root = normalizeGatewayUrl(opts.url);
  const key = String(opts.key || "").trim();
  const maxRows = Math.max(1, Math.min(Number(opts.maxRows) || 500, 100000));
  const timeoutMs = opts.timeoutMs || 60000;
  const maxResponseBytes = opts.maxResponseBytes || 20 * 1024 * 1024;
  const fetchImpl = opts.fetch || globalThis.fetch;

  function checkKey() {
    if (!key) throw new ODError("GATEWAY_KEY is not set.", { code: "config" });
    if (!KEY_RE.test(key)) throw new ODError("GATEWAY_KEY has unexpected characters. Paste it again exactly as the gateway printed it.", { code: "config" });
  }

  function url(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) for (const x of v) qs.append(k, String(x));
      else qs.append(k, String(v));
    }
    const s = qs.toString();
    return root + path + (s ? "?" + s : "");
  }

  async function call(method, path, { params, body, auth = true } = {}) {
    if (auth) checkKey();
    let res;
    try {
      res = await fetchImpl(url(path, params), {
        method,
        redirect: "manual",
        headers: {
          ...(auth ? { Authorization: `Bearer ${key}` } : {}),
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e && e.name === "TimeoutError" ? "timed out" : (e && e.cause && e.cause.code) || "network error";
      throw new ODError(`Could not reach the Open Dental gateway at ${root} (${why}). Check GATEWAY_URL and that the gateway is running.`, { code: "unreachable" });
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ODError(`The gateway answered with a redirect (${res.status}); check GATEWAY_URL.`, { status: res.status, code: "redirect" });
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len > maxResponseBytes) throw new ODError("The gateway's response was too large; narrow the request.", { code: "too_large" });
    const text = await res.text();
    if (Buffer.byteLength(text) > maxResponseBytes) throw new ODError("The gateway's response was too large; narrow the request.", { code: "too_large" });
    let data;
    try {
      data = text.trim() ? JSON.parse(text) : { ok: true, status: res.status };
    } catch {
      data = { ok: true, status: res.status, text: text.slice(0, 2000) };
    }
    if (res.status >= 400) {
      const err = data && data.error ? data.error : {};
      const message = String(err.message || `The gateway returned ${res.status}.`).split(key).join("[key]");
      throw new ODError(message, { status: res.status, code: err.code || "upstream" });
    }
    return { data, headers: res.headers };
  }

  function odPath(path) {
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("..") || /[?#\\]/.test(path)) {
      throw new ODError("Invalid API path.", { code: "bad_input" });
    }
    return "/v1/od" + path;
  }

  /** One Open Dental request through the gateway. Same contract as the direct client. */
  async function request(method, path, { params, body } = {}) {
    method = String(method || "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "DELETE"].includes(method)) throw new ODError("Unsupported method.", { code: "bad_input" });
    return (await call(method, odPath(path), { params, body })).data;
  }

  /** Paged GET: the gateway follows Open Dental's paging (all=true) and caps rows. */
  async function getAll(path, params = {}, { limit, method = "GET", body, allRows = false } = {}) {
    if (method !== "GET" || body !== undefined) throw new ODError("Through the gateway, paged reads are GET only. Use a report for queries.", { code: "bad_input" });
    const cap = Math.max(1, Math.min(Number(limit) || (allRows ? 100000 : maxRows), allRows ? 100000 : maxRows));
    const { data, headers } = await call("GET", odPath(path), { params: { ...params, all: "true", limit: cap } });
    const rows = Array.isArray(data) ? data : [data];
    return { rows, truncated: headers.get("x-truncated") === "true" };
  }

  /** Named report: POST /v1/reports/<name>. Returns { rows, truncated }. */
  async function runReport(name, params = {}, { limit } = {}) {
    if (typeof name !== "string" || !/^[a-z0-9_]{1,60}$/.test(name)) throw new ODError("Invalid report name.", { code: "bad_input" });
    const { data } = await call("POST", `/v1/reports/${name}`, { params: limit ? { limit } : undefined, body: { params } });
    return { rows: data.rows || [], truncated: !!data.truncated };
  }

  /** Read-only SQL through POST /v1/query (only works for apps the gateway allows rawSql). */
  async function shortQuery(sql, { limit } = {}) {
    const safe = guardReadOnlySql(sql);
    const { data } = await call("POST", "/v1/query", { body: { sql: safe, ...(limit ? { limit } : {}) } });
    return { rows: data.rows || [], truncated: !!data.truncated };
  }

  /** GET /health (no key). In the design stage it must report "fake": true. */
  async function health() {
    return (await call("GET", "/health", { auth: false })).data;
  }

  return { mode: "gateway", baseUrl: root, isCloud: false, maxRows, minIntervalMs: 0, request, getAll, runReport, shortQuery, health };
}

/**
 * Module startup check (CONTRACT.md: Two stages). In TDC_STAGE=design the
 * gateway must be the demo gateway with fake data; otherwise refuse to start.
 * Returns the health answer.
 */
async function checkStage(client, stage) {
  const s = String(stage || "").trim().toLowerCase();
  if (s !== "design" && s !== "live") throw new ODError('TDC_STAGE must be "design" or "live".', { code: "config" });
  const h = await client.health();
  if (s === "design" && h.fake !== true) {
    throw new ODError("TDC_STAGE is design, but the gateway at GATEWAY_URL is not the demo gateway with fake data. Refusing to start.", { code: "config" });
  }
  if (s === "live" && h.fake === true) {
    throw new ODError("TDC_STAGE is live, but the gateway at GATEWAY_URL is the demo gateway with fake data.", { code: "config" });
  }
  return h;
}

/** Build a gateway client from GATEWAY_URL and GATEWAY_KEY (CONTRACT.md §8). */
function gatewayClientFromEnv(env = process.env, extra = {}) {
  return createGatewayClient({ url: env.GATEWAY_URL, key: env.GATEWAY_KEY, ...extra });
}

module.exports = { createGatewayClient, normalizeGatewayUrl, checkStage, gatewayClientFromEnv };
