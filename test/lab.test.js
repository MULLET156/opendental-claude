"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeOD } = require("./fake-od");
const { createClient } = require("../core/odclient");
const { buildLabTools } = require("../core/lab-tools");
const { buildReport } = require("../core/reports");
const { guardReadOnlySql } = require("../core/odclient");

async function setup(t, { allowWrites = true } = {}) {
  const od = await startFakeOD();
  t.after(() => od.close());
  const client = createClient({ baseUrl: od.url, developerKey: "dev1", customerKey: "cust1" });
  const tools = Object.fromEntries(buildLabTools(client, { allowWrites }).map((x) => [x.name, x]));
  const run = (name, args) => tools[name].run(args);
  const writes = () => od.requests.filter((r) => r.method !== "GET");
  return { od, run, writes, tools };
}

test("lab reports build read-only SQL with the cleanup filters", () => {
  for (const [name, params] of [
    ["lab_cases_open", {}],
    ["lab_cases_open", { lab: 1, days_ahead: 14 }],
    ["lab_turnaround", { from: "2026-01-01", to: "2026-06-30" }],
    ["lab_cases_unreceived_completed", {}],
    ["lab_cases_unreceived_completed", { before: "2026-10-01", count_only: "true" }],
  ]) {
    assert.doesNotThrow(() => guardReadOnlySql(buildReport(name, params)), name);
  }
  const sql = buildReport("lab_cases_unreceived_completed", { before: "2026-10-01" });
  assert.match(sql, /lc\.DateTimeRecd < '1880-01-01' AND a\.AptStatus = 2 AND a\.AptDateTime < '2026-10-01'/);
});

test("reads: labs with turnarounds, cases, open board", async (t) => {
  const { run } = await setup(t, { allowWrites: false });
  const labs = await run("od_list_labs", {});
  assert.deepEqual(labs.results.map((l) => l.Description), ["Smile Lab"]);
  assert.equal(labs.results[0].turnarounds[0].days_actual, 9);
  assert.equal((await run("od_list_labs", { include_hidden: true })).count, 2);
  assert.equal((await run("od_get_lab_cases", { pat_num: 1 })).count, 7);
  await assert.rejects(run("od_get_lab_cases", {}), /pat_num, apt_num or lab_num/);
  const board = await run("od_get_open_lab_cases", { days_ahead: 10 });
  assert.ok(Array.isArray(board.results));
});

test("changes are refused while schedule changes are off (preview still allowed)", async (t) => {
  const { run, writes } = await setup(t, { allowWrites: false });
  await assert.rejects(run("od_create_lab_case", { pat_num: 1, lab_num: 1, prov_num: 1 }), /turned off/);
  await assert.rejects(run("od_update_lab_case_status", { pat_num: 1, lab_case_num: 1, step: "received" }), /turned off/);
  await assert.rejects(run("od_update_lab_case", { pat_num: 1, lab_case_num: 1, due: "2026-12-01" }), /turned off/);
  await assert.rejects(run("od_mark_lab_cases_received", { lab_case_nums: [1], preview: false }), /turned off/);
  const p = await run("od_mark_lab_cases_received", { lab_case_nums: [1] });
  assert.equal(p.preview, true);
  assert.equal(writes().length, 0);
});

test("create a lab case: checks lab and appointments, computes due from turnaround", async (t) => {
  const { run, writes } = await setup(t);
  await run("od_create_lab_case", {
    pat_num: 1,
    lab_num: 1,
    prov_num: 3,
    instructions: "Zirconia crown #30, shade A2",
    turnaround_num: 4,
    apt_num: 52,
    mark_sent: true,
    lab_fee: 145,
  });
  const b = writes().at(-1).body;
  assert.equal(b.PatNum, 1);
  assert.equal(b.LaboratoryNum, 1);
  assert.equal(b.AptNum, 52);
  assert.equal(b.LabFee, 145);
  assert.match(b.DateTimeSent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const sent = new Date(b.DateTimeSent.slice(0, 10) + "T00:00:00Z");
  const due = new Date(b.DateTimeDue.slice(0, 10) + "T00:00:00Z");
  assert.equal((due - sent) / 86400000, 9);

  await run("od_create_lab_case", { pat_num: 1, lab_num: 1, prov_num: 3, due: "2026-12-04 15:00", planned_apt_num: 55 });
  assert.equal(writes().at(-1).body.DateTimeDue, "2026-12-04 15:00:00");
  assert.equal(writes().at(-1).body.PlannedAptNum, 55);

  const n = writes().length;
  await assert.rejects(run("od_create_lab_case", { pat_num: 1, lab_num: 1, prov_num: 3, apt_num: 54 }), /different patient/);
  await assert.rejects(run("od_create_lab_case", { pat_num: 1, lab_num: 1, prov_num: 3, apt_num: 50 }), /Complete, not Scheduled/);
  await assert.rejects(run("od_create_lab_case", { pat_num: 1, lab_num: 9, prov_num: 3 }), /404/);
  await assert.rejects(run("od_create_lab_case", { pat_num: 1, lab_num: 1, prov_num: 3, due: "12/04/2026" }), /yyyy-MM-dd/);
  await assert.rejects(run("od_create_lab_case", { pat_num: 1, lab_num: 1, prov_num: 3, due: "2026-02-30" }), /yyyy-MM-dd/);
  assert.equal(writes().length, n);
});

test("status steps go in order; overwrite only when asked; read back", async (t) => {
  const { run, writes, od } = await setup(t);
  const n0 = writes().length;
  await assert.rejects(run("od_update_lab_case_status", { pat_num: 1, lab_case_num: 2, step: "received" }), /never marked sent/);
  await assert.rejects(run("od_update_lab_case_status", { pat_num: 1, lab_case_num: 3, step: "checked" }), /hasn't been received/);
  await assert.rejects(run("od_update_lab_case_status", { pat_num: 1, lab_case_num: 5, step: "received" }), /already marked received.*overwrite=true/);
  await assert.rejects(run("od_update_lab_case_status", { pat_num: 2, lab_case_num: 1, step: "sent" }), /different patient/);
  await assert.rejects(run("od_update_lab_case", { pat_num: 1, lab_case_num: 1 }), /Nothing to change/);
  assert.equal(writes().length, n0);

  const r = await run("od_update_lab_case_status", { pat_num: 1, lab_case_num: 1, step: "received", when: "2026-11-13 14:05" });
  assert.equal(r.verified, "Read back from Open Dental after saving.");
  assert.equal(od.state.labcases[1].DateTimeRecd, "2026-11-13 14:05:00");
  await run("od_update_lab_case_status", { pat_num: 1, lab_case_num: 2, step: "sent" });
  assert.match(od.state.labcases[2].DateTimeSent, /^\d{4}-/);
  const o = await run("od_update_lab_case_status", { pat_num: 1, lab_case_num: 5, step: "received", when: "2020-01-01", overwrite: true });
  assert.equal(o.replaced, "2019-03-10 10:00:00 → 2020-01-01 00:00:00");
  await run("od_update_lab_case", { pat_num: 1, lab_case_num: 1, due: "2026-12-01", instructions: "Rush" });
  assert.deepEqual(writes().at(-1).body, { DateTimeDue: "2026-12-01 00:00:00", Instructions: "Rush" });

  od.state.ignoreLabPut = true;
  await assert.rejects(run("od_update_lab_case_status", { pat_num: 1, lab_case_num: 3, step: "received" }), /did not apply.*NOT made/);
});

test("unlink a lab case from another patient's appointment", async (t) => {
  const { run, writes, od } = await setup(t);
  const r = await run("od_update_lab_case", { pat_num: 3, lab_case_num: 8, unlink_appointment: true });
  assert.deepEqual(writes().at(-1).body, { AptNum: 0 });
  assert.equal(od.state.labcases[8].AptNum, 0);
  assert.equal(r.appointment, "50 → none");
  const n = writes().length;
  await assert.rejects(run("od_update_lab_case", { pat_num: 3, lab_case_num: 8, unlink_appointment: true }), /isn't linked to an appointment/);
  await assert.rejects(run("od_update_lab_case", { pat_num: 3, lab_case_num: 8, unlink_planned_appointment: true }), /isn't linked to a planned/);
  await assert.rejects(run("od_update_lab_case", { pat_num: 1, lab_case_num: 8, unlink_appointment: true }), /different patient/);
  await assert.rejects(run("od_update_lab_case", { pat_num: 1, lab_case_num: 1, apt_num: 52, unlink_appointment: true }), /either apt_num or unlink/);
  assert.equal(writes().length, n);
});

test("re-date already-received cases to a fixed date, preview first", async (t) => {
  const { run, writes, od } = await setup(t);
  const sql = require("../core/reports").buildReport("lab_cases_received_on_appointment_date", { before: "2020-01-01" });
  assert.match(sql, /lc\.DateTimeRecd = a\.AptDateTime AND a\.AptStatus = 2 AND a\.AptDateTime < '2020-01-01'/);
  // Without overwrite, already-received cases are skipped.
  let p = await run("od_mark_lab_cases_received", { lab_case_nums: [9], received_date: "2020-01-01" });
  assert.match(p.results[0].reason, /already received/);
  p = await run("od_mark_lab_cases_received", { lab_case_nums: [9, 5, 1], received_date: "2020-01-01", overwrite_received: true, before: "2020-01-01" });
  assert.equal(writes().length, 0);
  const by = Object.fromEntries(p.results.map((r) => [r.LabCaseNum, r]));
  assert.equal(by[9].result, "would re-date received");
  assert.equal(by[9].OldReceivedDate, "2019-03-15 10:30:00");
  assert.equal(by[9].ReceivedDate, "2020-01-01 00:00:00");
  assert.equal(by[1].result, "would mark received");
  const done = await run("od_mark_lab_cases_received", { lab_case_nums: [9, 5, 1], received_date: "2020-01-01", overwrite_received: true, before: "2020-01-01", preview: false });
  assert.deepEqual(done.summary, { "re-dated received": 2, "marked received": 1 });
  for (const n of [9, 5, 1]) assert.equal(od.state.labcases[n].DateTimeRecd, "2020-01-01 00:00:00");
  // Running it again changes nothing.
  const again = await run("od_mark_lab_cases_received", { lab_case_nums: [9], received_date: "2020-01-01", overwrite_received: true, preview: false });
  assert.match(again.results[0].reason, /already received on 2020-01-01/);
});

test("cleanup: preview first, then only complete-appointment cases before the cutoff", async (t) => {
  const { run, writes, od } = await setup(t);
  const all = [1, 2, 3, 4, 5, 6, 7, 99];
  const p = await run("od_mark_lab_cases_received", { lab_case_nums: all, before: "2026-10-01" });
  assert.equal(p.preview, true);
  assert.equal(writes().length, 0);
  const by = Object.fromEntries(p.results.map((r) => [r.LabCaseNum, r]));
  assert.equal(by[1].result, "would mark received");
  assert.equal(by[1].ReceivedDate, "2019-03-15 10:30:00");
  assert.equal(by[2].result, "would mark received");
  assert.equal(by[2].NeverSent, true);
  assert.match(by[3].reason, /on\/after 2026-10-01/);
  assert.match(by[4].reason, /Scheduled, not Complete/);
  assert.match(by[5].reason, /already received/);
  assert.match(by[6].reason, /no linked appointment/);
  assert.equal(by[7].result, "would mark received"); // numeric AptStatus 2 = Complete
  assert.equal(by[99].result, "skipped");
  assert.deepEqual(p.summary, { "would mark received": 3, skipped: 5 });

  const done = await run("od_mark_lab_cases_received", { lab_case_nums: all, before: "2026-10-01", preview: false });
  assert.deepEqual(done.summary, { "marked received": 3, skipped: 5 });
  const puts = writes();
  assert.deepEqual(puts.map((w) => [w.path.split("/").pop(), w.body.DateTimeRecd]), [
    ["1", "2019-03-15 10:30:00"],
    ["2", "2019-03-15 10:30:00"],
    ["7", "2020-02-02 14:00:00"],
  ]);
  assert.ok(puts.every((w) => w.method === "PUT"));
  assert.ok(!od.requests.some((r) => r.method === "DELETE"));

  await assert.rejects(run("od_mark_lab_cases_received", { lab_case_nums: [] }), /1-50/);
  await assert.rejects(run("od_mark_lab_cases_received", { lab_case_nums: Array.from({ length: 51 }, (_, i) => i + 1) }), /1-50/);
  await assert.rejects(run("od_mark_lab_cases_received", { lab_case_nums: [1], before: "10/01/2026" }), /yyyy-MM-dd/);
});

test("cleanup stops on Open Dental errors instead of skipping everything", async (t) => {
  const { run, od, writes } = await setup(t);
  od.state.failNext.push({ status: 401 });
  const r = await run("od_mark_lab_cases_received", { lab_case_nums: [1, 2, 7], preview: false });
  assert.match(r.stopped, /401/);
  assert.deepEqual(r.results.map((x) => x.result), ["skipped", "not attempted", "not attempted"]);
  assert.equal(writes().length, 0);
});
