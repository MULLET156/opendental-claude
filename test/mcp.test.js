"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { startFakeOD } = require("./fake-od");
const { buildExtension } = require("../scripts/build");

/** Start a connector over stdio, send messages, collect replies to requests. */
function session(entry, env, msgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [entry], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const want = msgs.filter((m) => m.id !== undefined).length;
    const got = [];
    let buf = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("timeout; got " + JSON.stringify(got)));
    }, 15000);
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        got.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (got.length === want) {
          clearTimeout(timer);
          p.kill();
          resolve(Object.fromEntries(got.map((m) => [m.id, m])));
        }
      }
    });
    for (const m of msgs) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  });
}

const call = (id, name, args = {}) => ({ id, method: "tools/call", params: { name, arguments: args } });
const text = (m) => JSON.parse(m.result.content[0].text);
const ENTRY = path.join(__dirname, "..", "extension", "server", "index.js");

test("connector: handshake, tool list, reads, guards", async () => {
  const od = await startFakeOD();
  try {
    const env = { OD_BASE_URL: od.url, OD_DEVELOPER_KEY: "dev1", OD_CUSTOMER_KEY: "cust1", OD_ALLOW_WRITES: "false", OD_MAX_ROWS: "${user_config.max_rows}" };
    const r = await session(ENTRY, env, [
      { id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { method: "notifications/initialized" },
      { id: 1, method: "tools/list" },
      call(2, "od_connection_check"),
      call(3, "od_search_patients", { last_name: "smi", max_rows: 120 }),
      call(4, "od_run_query", { sql: "DELETE FROM patient" }),
      call(5, "od_run_report", { name: "production_by_provider", params: { from: "2026-11-01", to: "2026-11-30" } }),
      call(6, "od_add_commlog", { pat_num: 1, note: "hi" }),
      call(7, "od_get_appointments", { date_start: "11/13/2026" }),
      call(8, "od_get_patient", { pat_num: "1 OR 1=1" }),
      call(9, "nope"),
      { id: 10, method: "ping" },
    ]);
    assert.equal(r[0].result.protocolVersion, "2025-06-18");
    assert.equal(r[0].result.serverInfo.name, "opendental");
    const tools = r[1].result.tools;
    assert.equal(tools.length, 44);
    assert.equal(tools.filter((t) => t.annotations.readOnlyHint === false).length, 21);
    assert.equal(text(r[2]).results.writes_enabled, false);
    const s = text(r[3]);
    assert.equal(s.count, 120);
    assert.ok(s.truncated);
    assert.equal(s.results[0].SSN, "[redacted]");
    assert.equal(s.results[0].nested.PatientSSN, "[redacted]");
    assert.ok(r[4].result.isError);
    assert.match(text(r[4]).error, /read-only/);
    assert.equal(text(r[5]).results[0].GrossProduction, 1234.5);
    assert.ok(r[6].result.isError && /turned off/.test(text(r[6]).error));
    assert.ok(r[7].result.isError && /yyyy-MM-dd/.test(text(r[7]).error));
    assert.ok(r[8].result.isError && /whole number/.test(text(r[8]).error));
    assert.equal(r[9].error.code, -32602);
    assert.deepEqual(r[10].result, {});
    // Nothing that was refused reached Open Dental.
    assert.ok(!od.requests.some((q) => q.method !== "GET" && q.path.endsWith("/commlogs")));
    assert.ok(!od.requests.some((q) => q.body && /DELETE/.test(q.body.SqlCommand || "")));
    const sq = od.requests.find((q) => q.path.endsWith("/queries/ShortQuery"));
    assert.match(sq.body.SqlCommand, /BETWEEN '2026-11-01' AND '2026-11-30'/);
    assert.equal(sq.method, "PUT");
  } finally {
    await od.close();
  }
});

test("connector: changes go through when allowed, with exact bodies", async () => {
  const od = await startFakeOD();
  try {
    const env = { OD_BASE_URL: od.url, OD_DEVELOPER_KEY: "dev1", OD_CUSTOMER_KEY: "cust1", OD_ALLOW_WRITES: "true" };
    const r = await session(ENTRY, env, [
      call(1, "od_create_appointment", { pat_num: 1, apt_date_time: "2026-11-20 09:00:00", op: 2, prov_num: 1, pattern: "XXXXXX" }),
      call(2, "od_break_appointment", { apt_num: 9 }),
      call(3, "od_add_commlog", { pat_num: 1, note: "Pt called to reschedule", mode: "Phone", sent_or_received: "Received" }),
      call(4, "od_create_appointment", { pat_num: 1, apt_date_time: "2026-11-20 09:00:00", op: 2, pattern: "XX1" }),
    ]);
    assert.equal(text(r[1]).results.AptNum, 77);
    assert.ok(!r[2].result.isError);
    assert.ok(!r[3].result.isError);
    assert.ok(r[4].result.isError);
    const post = od.requests.find((q) => q.method === "POST" && q.path.endsWith("/appointments"));
    assert.deepEqual(post.body, { PatNum: 1, AptDateTime: "2026-11-20 09:00:00", Op: 2, ProvNum: 1, Pattern: "XXXXXX" });
    const brk = od.requests.find((q) => q.path.endsWith("/appointments/9/Break"));
    assert.deepEqual(brk.body, { sendToUnscheduledList: "true" });
    const cl = od.requests.find((q) => q.path.endsWith("/commlogs"));
    assert.deepEqual(cl.body, { PatNum: 1, Note: "Pt called to reschedule", Mode_: "Phone", SentOrReceived: "Received" });
  } finally {
    await od.close();
  }
});

test("connector: bad settings are reported, not a crash", async () => {
  const r = await session(ENTRY, { OD_BASE_URL: "http://example.com/api/v1", OD_DEVELOPER_KEY: "a", OD_CUSTOMER_KEY: "b" }, [
    { id: 1, method: "tools/list" },
    call(2, "od_connection_check"),
  ]);
  assert.equal(r[1].result.tools.length, 44);
  assert.match(text(r[2]).error, /Plain http/);
});

test("packed extension runs on its own", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odmcpb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "x.mcpb"), buildExtension());
  try {
    execFileSync("unzip", ["-q", "x.mcpb", "-d", "ext"], { cwd: dir });
  } catch {
    t.skip("unzip not available");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "ext", "manifest.json"), "utf8"));
  assert.equal(manifest.server.entry_point, "server/index.js");
  const od = await startFakeOD();
  try {
    const r = await session(path.join(dir, "ext", manifest.server.entry_point), { OD_BASE_URL: od.url, OD_DEVELOPER_KEY: "dev1", OD_CUSTOMER_KEY: "cust1" }, [
      { id: 1, method: "tools/list" },
      call(2, "od_list_providers"),
    ]);
    assert.deepEqual(r[1].result.tools.map((x) => x.name).sort(), manifest.tools.map((x) => x.name).sort());
    assert.equal(text(r[2]).results[0].Abbr, "DOC1");
  } finally {
    await od.close();
  }
});
