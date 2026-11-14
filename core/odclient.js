"use strict";
/**
 * Open Dental API client shared by the Claude connector and the app gateway.
 * No npm dependencies; needs Node 18+ (global fetch).
 *
 * Safety properties:
 *  - Credentials are only ever sent to the configured base URL. Redirects are
 *    never followed, so a redirect can't carry the keys to another host.
 *  - Plain http is only allowed for loopback and private (office LAN) addresses.
 *  - Paths are built from validated parts; record IDs must be positive integers.
 *  - Responses over a size limit are rejected; SSNs and similar fields are
 *    removed at every depth before anything is returned.
 *  - Remote (cloud) requests are paced and 429 Retry-After is honored, with a
 *    bounded retry budget.
 *  - Error messages never include the keys.
 */

const CLOUD_URL = "https://api.opendental.com/api/v1";

/**
 * Open Dental throttles cloud (Remote) requests per customer key by API plan.
 * Local API and API Service requests are not throttled.
 *   read-all    Read All permission only: 1 request / 5 s
 *   standard    any paid permission: 1 request / s
 *   enterprise  Enterprise permission: 1 request / 500 ms
 */
const PLAN_INTERVAL_MS = { "read-all": 5000, standard: 1000, enterprise: 500 };

function planInterval(plan) {
  const p = String(plan || "standard").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PLAN_INTERVAL_MS, p)) {
    throw new ODError(`Unknown Open Dental API plan "${plan}". Use one of: ${Object.keys(PLAN_INTERVAL_MS).join(", ")}.`, { code: "config" });
  }
  return PLAN_INTERVAL_MS[p];
}

const DEFAULT_REDACT = ["SSN", "ssn", "PatientSSN", "DriverLicense", "DriversLicense"];

class ODError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "ODError";
    if (status) this.status = status;
    if (code) this.code = code;
  }
}

// ------------------------------------------------------------------ validation

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkDate(name, v, { required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ODError(`${name} is required (yyyy-MM-dd).`, { code: "bad_input" });
    return;
  }
  if (typeof v !== "string" || !validDate(v)) {
    throw new ODError(`${name} must be a real date in yyyy-MM-dd form.`, { code: "bad_input" });
  }
}

function checkDateTime(name, v) {
  if (typeof v !== "string" || !DATETIME_RE.test(v) || !validDate(v.slice(0, 10))) {
    throw new ODError(`${name} must be "yyyy-MM-dd HH:mm:ss".`, { code: "bad_input" });
  }
}

/** Positive integer record ID (PatNum, AptNum...). Accepts numeric strings of digits. */
function recordId(name, v, { required = true } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ODError(`${name} is required.`, { code: "bad_input" });
    return undefined;
  }
  if (typeof v === "string" && /^\d{1,18}$/.test(v)) v = Number(v);
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    throw new ODError(`${name} must be a positive whole number.`, { code: "bad_input" });
  }
  return v;
}

function checkPattern(v) {
  if (v !== undefined && v !== null && v !== "" && !/^[X/]{1,200}$/.test(v)) {
    throw new ODError("pattern may only contain 'X' and '/' characters (5 minutes each).", { code: "bad_input" });
  }
}

// ------------------------------------------------------------------ base URL

function isPrivateHost(host) {
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // Single-label names (e.g. "odserver") and .local / .lan names resolve on the office network.
  return !host.includes(".") || /\.(local|lan|internal|home\.arpa)$/.test(host);
}

function normalizeBaseUrl(raw) {
  const value = (raw || "").trim() || CLOUD_URL;
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new ODError("The Open Dental API URL is not a valid URL.", { code: "config" });
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new ODError("The Open Dental API URL must not contain a username, password, query or fragment.", { code: "config" });
  }
  if (u.protocol === "http:" && !isPrivateHost(u.hostname)) {
    throw new ODError(
      "Plain http is only allowed for addresses on your own network (API Service / Local API). Use https for anything else.",
      { code: "config" }
    );
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new ODError("The Open Dental API URL must start with https:// or http://.", { code: "config" });
  }
  return u.toString().replace(/\/+$/, "");
}

function checkKey(name, v) {
  if (!v) {
    throw new ODError(`${name} is not set.`, { code: "config" });
  }
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(v)) {
    throw new ODError(`${name} has unexpected characters. Paste it again exactly as Open Dental issued it.`, { code: "config" });
  }
}

// ------------------------------------------------------------------ redaction

function makeRedactor(extraFields = []) {
  const fields = new Set([...DEFAULT_REDACT, ...extraFields]);
  const walk = (obj, depth = 0) => {
    if (depth > 50) throw new ODError("Open Dental returned data nested too deeply.", { code: "bad_response" });
    if (Array.isArray(obj)) return obj.map((o) => walk(o, depth + 1));
    if (obj && typeof obj === "object") {
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k] = fields.has(k) ? "[redacted]" : walk(v, depth + 1);
      return out;
    }
    return obj;
  };
  return walk;
}

const redact = makeRedactor();

// ------------------------------------------------------------------ SQL guard

const READONLY_START = /^\s*(SELECT|WITH|SET|SHOW|DESCRIBE|DESC|EXPLAIN|CREATE\s+TEMPORARY\s+TABLE|DROP\s+TEMPORARY\s+TABLE)\b/i;
const BLOCKED = /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|TRUNCATE|GRANT|REVOKE|RENAME|CALL|HANDLER|LOAD|LOAD_FILE|LOCK|UNLOCK|INTO\s+OUTFILE|INTO\s+DUMPFILE|SLEEP|BENCHMARK|GLOBAL|PASSWORD|PREPARE|EXECUTE)\b/i;
// Leave ordinary table creation blocked even though "CREATE TEMPORARY TABLE" is allowed.
const CREATE_NON_TEMP = /\bCREATE\s+(?!TEMPORARY\b)/i;
const DROP_NON_TEMP = /\bDROP\s+(?!TEMPORARY\b)/i;

/** Throws unless every statement in `sql` is read-only. Returns the SQL ready to send. */
function guardReadOnlySql(sql) {
  if (typeof sql !== "string" || !sql.trim()) throw new ODError("sql is required.", { code: "bad_input" });
  if (sql.length > 20000) throw new ODError("Query is too long.", { code: "bad_input" });
  // Strip string literals and comments before checking keywords.
  const stripped = sql
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(--|#)[^\n]*/g, " ");
  const statements = stripped.split(";").map((s) => s.trim()).filter(Boolean);
  if (!statements.length) throw new ODError("sql is required.", { code: "bad_input" });
  for (const s of statements) {
    if (!READONLY_START.test(s) || BLOCKED.test(s) || CREATE_NON_TEMP.test(s) || DROP_NON_TEMP.test(s)) {
      throw new ODError("Only read-only SELECT queries are allowed.", { code: "forbidden" });
    }
  }
  // Open Dental's web filter can reject '<' directly followed by text.
  return sql.replace(/<(?=[^\s=>])/g, "< ");
}

// ------------------------------------------------------------------ client

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {string} [opts.baseUrl]       Cloud, API Service or Local API root.
 * @param {string} opts.developerKey
 * @param {string} opts.customerKey
 * @param {number} [opts.maxRows=500]   Hard cap on rows any paged call returns.
 * @param {number} [opts.timeoutMs=60000]
 * @param {number} [opts.maxResponseBytes=20MB]
 * @param {string} [opts.plan]          Open Dental API plan for cloud pacing: read-all | standard | enterprise.
 * @param {number} [opts.minIntervalMs] Spacing between requests; overrides plan. Default: plan pacing for the cloud API, 0 otherwise.
 * @param {number} [opts.maxRetries=3]  Retries on 429/502/503/504.
 * @param {number} [opts.maxRetryWaitMs=30000]
 * @param {Function} [opts.fetch]       Injected fetch for tests.
 */
function createClient(opts = {}) {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const developerKey = (opts.developerKey || "").trim();
  const customerKey = (opts.customerKey || "").trim();
  const maxRows = Math.max(1, Math.min(Number(opts.maxRows) || 500, 100000));
  const timeoutMs = opts.timeoutMs || 60000;
  const maxResponseBytes = opts.maxResponseBytes || 20 * 1024 * 1024;
  const isCloud = new URL(baseUrl).hostname === "api.opendental.com";
  const planMs = planInterval(opts.plan);
  let minIntervalMs = opts.minIntervalMs;
  if (minIntervalMs === undefined || minIntervalMs === null || minIntervalMs === "") minIntervalMs = isCloud ? planMs : 0;
  minIntervalMs = Number(minIntervalMs);
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60000) {
    throw new ODError("Request spacing must be between 0 and 60000 milliseconds.", { code: "config" });
  }
  const maxRetries = opts.maxRetries ?? 3;
  const maxRetryWaitMs = opts.maxRetryWaitMs ?? 30000;
  const fetchImpl = opts.fetch || globalThis.fetch;

  // Serialize requests and keep them spaced (Open Dental throttles per customer key).
  let chain = Promise.resolve();
  let lastStart = 0;
  function schedule(fn) {
    const run = chain.then(async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  }

  function buildUrl(path, params) {
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("..") || /[?#\\]/.test(path)) {
      throw new ODError("Invalid API path.", { code: "bad_input" });
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === "") continue;
      qs.append(k, typeof v === "boolean" ? String(v) : String(v));
    }
    const s = qs.toString();
    return baseUrl + path + (s ? "?" + s : "");
  }

  async function readBody(res) {
    const len = Number(res.headers.get("content-length") || 0);
    if (len > maxResponseBytes) throw new ODError("Open Dental's response was too large; narrow the request.", { code: "too_large" });
    const text = await res.text();
    if (Buffer.byteLength(text) > maxResponseBytes) {
      throw new ODError("Open Dental's response was too large; narrow the request.", { code: "too_large" });
    }
    return text;
  }

  /** One request. Returns parsed JSON (or {ok:true} for empty bodies). */
  async function request(method, path, { params, body } = {}) {
    checkKey("Open Dental Developer Key", developerKey);
    checkKey("Open Dental Customer Key", customerKey);
    method = String(method || "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "DELETE"].includes(method)) throw new ODError("Unsupported method.", { code: "bad_input" });
    const url = buildUrl(path, params);

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await schedule(() =>
          fetchImpl(url, {
            method,
            redirect: "manual",
            headers: {
              Authorization: `ODFHIR ${developerKey}/${customerKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          })
        );
      } catch (e) {
        const why = e && e.name === "TimeoutError" ? "timed out" : (e && e.cause && e.cause.code) || "network error";
        throw new ODError(
          `Could not reach Open Dental at ${baseUrl} (${why}). Check the API URL and that the API Service or eConnector is running.`,
          { code: "unreachable" }
        );
      }

      if (res.status >= 300 && res.status < 400) {
        throw new ODError(`Open Dental answered with a redirect (${res.status}); check the API URL.`, { status: res.status, code: "redirect" });
      }

      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (retryable && attempt < maxRetries) {
        const ra = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : Math.min(500 * 2 ** attempt, 8000);
        if (waitMs <= maxRetryWaitMs) {
          await res.text().catch(() => {});
          await sleep(waitMs);
          continue;
        }
      }

      const text = await readBody(res);
      if (res.status >= 400) {
        let detail = text.replace(/\s+/g, " ").trim().slice(0, 400);
        detail = detail.split(developerKey).join("[key]").split(customerKey).join("[key]");
        const hint =
          res.status === 401 ? " (keys rejected; check the Developer and Customer keys and that the API is enabled in Open Dental)"
          : res.status === 403 ? " (this Customer Key lacks permission for that request)"
          : res.status === 429 ? " (rate limited by Open Dental; try again shortly)"
          : "";
        throw new ODError(`Open Dental returned ${res.status} for ${method} ${path}${hint}: ${detail}`, { status: res.status, code: "upstream" });
      }
      if (!text.trim()) return { ok: true, status: res.status };
      try {
        return JSON.parse(text);
      } catch {
        // Some write endpoints answer with plain text.
        return { ok: true, status: res.status, text: text.slice(0, 2000) };
      }
    }
  }

  /** Follow Open Dental's Offset paging until a short page or the row cap. */
  async function getAll(path, params = {}, { limit, method = "GET", body, allRows = false } = {}) {
    // allRows: for reference lists (e.g. procedure codes) that must be complete; still bounded.
    const ceiling = allRows ? 100000 : maxRows;
    const cap = Math.max(1, Math.min(Number(limit) || ceiling, ceiling));
    const rows = [];
    let offset = Number(params.Offset) || 0;
    let pageSize = null;
    for (;;) {
      const p = { ...params };
      if (offset) p.Offset = offset;
      else delete p.Offset;
      const page = await request(method, path, { params: p, body });
      if (!Array.isArray(page)) {
        if (rows.length) throw new ODError("Open Dental returned an unexpected page.", { code: "bad_response" });
        return { rows: [page], truncated: false };
      }
      rows.push(...page);
      if (page.length === 0) break;
      if (pageSize === null) pageSize = page.length;
      offset += page.length;
      if (rows.length >= cap) break;
      // Cloud pages hold 100 rows, local modes up to 1000; a short page is the last.
      if (page.length < 100 || page.length < pageSize) break;
    }
    return { rows: rows.slice(0, cap), truncated: rows.length >= cap };
  }

  async function shortQuery(sql, { limit } = {}) {
    const safe = guardReadOnlySql(sql);
    return getAll("/queries/ShortQuery", {}, { limit, method: "PUT", body: { SqlCommand: safe } });
  }

  return { baseUrl, isCloud, maxRows, minIntervalMs, request, getAll, shortQuery };
}

module.exports = {
  CLOUD_URL,
  PLAN_INTERVAL_MS,
  ODError,
  createClient,
  normalizeBaseUrl,
  makeRedactor,
  redact,
  guardReadOnlySql,
  checkDate,
  checkDateTime,
  checkPattern,
  recordId,
  validDate,
};
