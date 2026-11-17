"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeOD } = require("./fake-od");
const { createClient } = require("../core/odclient");
const { buildClinicalTools } = require("../core/clinical-tools");

async function setup(t, { allowChartChanges = true } = {}) {
  const od = await startFakeOD();
  t.after(() => od.close());
  const client = createClient({ baseUrl: od.url, developerKey: "dev1", customerKey: "cust1" });
  const tools = Object.fromEntries(buildClinicalTools(client, { allowChartChanges }).map((x) => [x.name, x]));
  const run = (name, args) => tools[name].run(args);
  const writes = () => od.requests.filter((r) => r.method !== "GET");
  return { od, run, writes, tools };
}

test("clinical tools: names and change markings", async (t) => {
  const { tools } = await setup(t);
  const changes = Object.values(tools).filter((x) => !x.annotations.readOnlyHint).map((x) => x.name).sort();
  assert.deepEqual(changes, [
    "od_add_group_note",
    "od_add_to_treatment_note",
    "od_add_to_treatment_plan",
    "od_append_procedure_note",
    "od_chart_procedure",
    "od_create_treatment_plan",
    "od_plan_procedure",
    "od_remove_planned_procedure",
    "od_replace_treatment_note",
    "od_set_procedure_status",
    "od_set_tooth_status",
    "od_set_treatment_plan_priorities",
    "od_update_planned_procedure",
    "od_update_treatment_plan",
  ]);
  for (const x of Object.values(tools).filter((x) => !x.annotations.readOnlyHint)) assert.match(x.description, /^CHART CHANGE\./);
});

test("reads: progress notes, procedures, notes, medical summary, plans, codes, priorities", async (t) => {
  const { run, od } = await setup(t, { allowChartChanges: false });
  assert.equal((await run("od_get_progress_notes", { pat_num: 1 })).results[0].ProcCode, "D2391");
  const today = await run("od_get_procedures", { pat_num: 1, status: "C" });
  assert.deepEqual(today.results.map((p) => p.ProcNum), [101, 102]);
  assert.equal((await run("od_get_procedure_notes", { pat_num: 1 })).results[0].Note, "Prior note");
  assert.equal((await run("od_get_medical_summary", { pat_num: 1 })).results[0].Content, "Penicillin");
  const plans = await run("od_get_treatment_plans", { pat_num: 1 });
  assert.equal(plans.results[0].items[0].ProcNum, 103);
  assert.equal(plans.results[1].items[0].ProcCode, "D2740");
  assert.ok(od.requests.some((r) => r.path.endsWith("/proctps")) && od.requests.some((r) => r.path.endsWith("/treatplanattaches")));
  assert.equal((await run("od_lookup_procedure_code", { query: "D2740" })).results[0].TreatArea, "Tooth");
  assert.equal((await run("od_lookup_procedure_code", { query: "composite posterior" })).results[0].ProcCode, "D2393");
  assert.equal((await run("od_lookup_procedure_code", { query: "zzz" })).count, 0);
  const pri = await run("od_list_treatment_priorities", {});
  assert.deepEqual(pri.results.priorities.map((p) => p.name), ["1", "Urgent"]);
  await assert.rejects(run("od_get_procedures", { pat_num: 1, date: "11/13/2026" }), /yyyy-MM-dd/);
});

test("every chart change is refused while chart changes are off", async (t) => {
  const { run, writes } = await setup(t, { allowChartChanges: false });
  const calls = [
    ["od_add_group_note", { pat_num: 1, proc_nums: [101], note: "x" }],
    ["od_append_procedure_note", { pat_num: 1, proc_num: 101, note: "x" }],
    ["od_plan_procedure", { pat_num: 1, proc_code: "D2740", tooth: "30" }],
    ["od_update_planned_procedure", { pat_num: 1, proc_num: 103, tooth: "31" }],
    ["od_remove_planned_procedure", { pat_num: 1, proc_num: 103 }],
    ["od_create_treatment_plan", { pat_num: 1, heading: "x" }],
    ["od_add_to_treatment_plan", { pat_num: 1, treat_plan_num: 9, proc_nums: [103] }],
    ["od_update_treatment_plan", { pat_num: 1, treat_plan_num: 9, heading: "x" }],
    ["od_chart_procedure", { pat_num: 1, proc_code: "D2750", status: "existing_other_provider", tooth: "19" }],
    ["od_set_procedure_status", { pat_num: 1, proc_num: 103, status: "complete" }],
    ["od_set_tooth_status", { pat_num: 1, teeth: ["32"], status: "missing" }],
    ["od_add_to_treatment_note", { pat_num: 1, text: "x" }],
    ["od_replace_treatment_note", { pat_num: 1, current_text: "", new_text: "x" }],
    ["od_set_treatment_plan_priorities", { pat_num: 1, treat_plan_num: 9, items: [{ proc_nums: [103], priority: "1" }] }],
  ];
  for (const [name, args] of calls) await assert.rejects(run(name, args), /Chart changes are turned off/, name);
  assert.equal(writes().length, 0);
});

test("group note: completed procedures of this patient only, always unsigned", async (t) => {
  const { run, writes, od } = await setup(t);
  const r = await run("od_add_group_note", { pat_num: 1, proc_nums: [101, 102, 101], note: "Pt presented for MO composite #3. 2 carp 2% lido 1:100k. NV. Pt tolerated well." });
  assert.equal(r.signed, false);
  const post = writes().at(-1);
  assert.equal(post.path, "/api/v1/procedurelogs/GroupNote");
  assert.deepEqual(post.body, {
    PatNum: 1,
    Note: "Pt presented for MO composite #3. 2 carp 2% lido 1:100k. NV. Pt tolerated well.",
    ProcNums: [101, 102],
    isSigned: "false",
  });
  const before = writes().length;
  await assert.rejects(run("od_add_group_note", { pat_num: 1, proc_nums: [101, 104], note: "x" }), /different patient/);
  await assert.rejects(run("od_add_group_note", { pat_num: 1, proc_nums: [101, 103], note: "x" }), /not completed/);
  await assert.rejects(run("od_add_group_note", { pat_num: 1, proc_nums: [], note: "x" }), /1-50/);
  await assert.rejects(run("od_add_group_note", { pat_num: 1, proc_nums: [101], note: "  " }), /note is required/);
  await assert.rejects(run("od_add_group_note", { pat_num: 1, proc_nums: [999], note: "x" }), /404|not found/i);
  assert.equal(writes().length, before);
  assert.ok(od.requests.length > before);
});

test("procedure note addendum appends, unsigned, after checking the patient", async (t) => {
  const { run, writes } = await setup(t);
  await run("od_append_procedure_note", { pat_num: 1, proc_num: 101, note: "Addendum: pt called, no sensitivity." });
  assert.deepEqual(writes().at(-1).body, { PatNum: 1, ProcNum: 101, Note: "Addendum: pt called, no sensitivity.", doAppendNote: "true", isSigned: "false" });
  const n = writes().length;
  await assert.rejects(run("od_append_procedure_note", { pat_num: 2, proc_num: 101, note: "x" }), /different patient/);
  assert.equal(writes().length, n);
});

test("plan a procedure: TP status, priority/diagnosis sent as DefNums, read back", async (t) => {
  const { run, writes, od } = await setup(t);
  const r = await run("od_plan_procedure", {
    pat_num: 1,
    proc_code: "D2740",
    tooth: "30",
    priority: "Urgent",
    diagnosis: "Caries",
    note: "Fractured MB cusp",
    treat_plan_num: 9,
  });
  assert.equal(r.verified, "Read back from Open Dental after saving.");
  const procNum = r.results.procedure.ProcNum;
  const [proc, note, attach] = writes().slice(-3);
  assert.equal(proc.path, "/api/v1/procedurelogs");
  assert.deepEqual(
    { s: proc.body.ProcStatus, c: proc.body.procCode, t: proc.body.ToothNum, p: proc.body.Priority, d: proc.body.Dx },
    { s: "TP", c: "D2740", t: "30", p: 502, d: 601 }
  );
  assert.equal(proc.body.priority, undefined);
  assert.equal(od.state.procs[procNum].Priority, 502);
  assert.deepEqual(note.body, { PatNum: 1, ProcNum: procNum, Note: "Fractured MB cusp", isSigned: "false" });
  assert.deepEqual(attach.body, { TreatPlanNum: 9, ProcNum: procNum, Priority: 502 });

  await run("od_plan_procedure", { pat_num: 1, proc_code: "D2393", tooth: "3", surfaces: "mod" });
  assert.equal(writes().at(-1).body.Surf, "MOD");

  const n = writes().length;
  await assert.rejects(run("od_plan_procedure", { pat_num: 1, proc_code: "D2740", tooth: "33" }), /tooth number/);
  await assert.rejects(run("od_plan_procedure", { pat_num: 1, proc_code: "D2393", tooth: "3", surfaces: "MOX" }), /surface/);
  await assert.rejects(run("od_plan_procedure", { pat_num: 1, proc_code: "D27'40" }), /procedure code/);
  await assert.rejects(run("od_plan_procedure", { pat_num: 1, proc_code: "D2740", priority: "ASAP" }), /No treatment priority named "ASAP"/);
  await assert.rejects(run("od_plan_procedure", { pat_num: 1, proc_code: "D2740", diagnosis: "Gremlins" }), /No diagnosis named/);
  await assert.rejects(run("od_plan_procedure", { pat_num: 1, proc_code: "D2740", tooth: "30", treat_plan_num: 10 }), /Saved/);
  await assert.rejects(run("od_plan_procedure", { pat_num: 2, proc_code: "D2740", tooth: "30", treat_plan_num: 9 }), /not found for patient 2/);
  assert.equal(writes().length, n);
});

test("BUG FIX: changing priority sends the DefNum, reads it back, and keeps plan items in step", async (t) => {
  const { run, writes, od } = await setup(t);
  // 105 is on plan 9 with no priority; set it to "1" (DefNum 501).
  const r = await run("od_update_planned_procedure", { pat_num: 1, proc_num: 105, priority: "1" });
  const put = writes().find((w) => w.path.endsWith("/procedurelogs/105"));
  assert.deepEqual(put.body, { Priority: 501 });
  assert.equal(od.state.procs[105].Priority, 501);
  assert.equal(od.state.attaches.find((a) => a.ProcNum === 105).Priority, 501);
  assert.deepEqual(r.plan_items_updated, [9]);
  // "none" clears it.
  await run("od_update_planned_procedure", { pat_num: 1, proc_num: 105, priority: "none", sync_plan_items: false });
  assert.equal(od.state.procs[105].Priority, 0);
  assert.equal(od.state.attaches.find((a) => a.ProcNum === 105).Priority, 501);
});

test("a write Open Dental silently ignores is reported as NOT made", async (t) => {
  const { run, od } = await setup(t);
  od.state.ignoreProcPut = true;
  await assert.rejects(run("od_update_planned_procedure", { pat_num: 1, proc_num: 103, tooth: "31" }), /did not apply.*ToothNum should be 31.*NOT made/);
  await assert.rejects(run("od_update_planned_procedure", { pat_num: 1, proc_num: 103, priority: "Urgent" }), /Priority should be 502/);
  await assert.rejects(run("od_set_procedure_status", { pat_num: 1, proc_num: 103, status: "complete" }), /NOT made/);
  od.state.ignoreProcPut = false;
  od.state.ignoreAttachPut = true;
  await assert.rejects(run("od_set_treatment_plan_priorities", { pat_num: 1, treat_plan_num: 9, items: [{ proc_nums: [105], priority: "Urgent" }] }), /did not apply priority/);
  od.state.ignoreAttachPut = false;
  od.state.ignoreToothPost = true;
  await assert.rejects(run("od_set_tooth_status", { pat_num: 1, teeth: ["19"], status: "missing" }), /still doesn't show teeth 19 as missing/);
});

test("only planned procedures can be changed or removed", async (t) => {
  const { run, writes } = await setup(t);
  await run("od_update_planned_procedure", { pat_num: 1, proc_num: 103, tooth: "31" });
  assert.deepEqual(writes().at(-1).body, { ToothNum: "31" });
  await run("od_update_planned_procedure", { pat_num: 1, proc_num: 105, surfaces: "MO" }); // numeric status 1 = TP
  const n = writes().length;
  await assert.rejects(run("od_update_planned_procedure", { pat_num: 1, proc_num: 101, tooth: "4" }), /not treatment-planned/);
  await assert.rejects(run("od_remove_planned_procedure", { pat_num: 1, proc_num: 101 }), /not treatment-planned/);
  await assert.rejects(run("od_remove_planned_procedure", { pat_num: 2, proc_num: 103 }), /different patient/);
  await assert.rejects(run("od_update_planned_procedure", { pat_num: 1, proc_num: 103 }), /Nothing to change/);
  assert.equal(writes().length, n);
  await run("od_remove_planned_procedure", { pat_num: 1, proc_num: 103 });
  assert.equal(writes().at(-1).method, "DELETE");
});

test("treatment plans: create, group, update existing items' priority, rename", async (t) => {
  const { run, writes, od } = await setup(t);
  await run("od_create_treatment_plan", { pat_num: 1, heading: "Phase 1 - Urgent", note: "Discussed options" });
  assert.deepEqual(writes().at(-1).body, { PatNum: 1, Heading: "Phase 1 - Urgent", Note: "Discussed options" });
  // 103 and 105 are already on plan 9: no "already exists" failure, the priority is updated instead.
  const r = await run("od_add_to_treatment_plan", { pat_num: 1, treat_plan_num: 9, proc_nums: [103, 105], priority: "Urgent" });
  assert.deepEqual(r.results.map((x) => x.result), ["already on this plan; priority updated", "already on this plan; priority updated"]);
  assert.deepEqual(od.state.attaches.filter((a) => a.TreatPlanNum === 9).map((a) => a.Priority), [502, 502]);
  assert.equal(od.state.procs[103].Priority, 502);
  assert.equal(od.state.procs[105].Priority, 502);
  // A new procedure gets attached.
  const created = await run("od_plan_procedure", { pat_num: 1, proc_code: "D2740", tooth: "2" });
  const pn = created.results.procedure.ProcNum;
  const r2 = await run("od_add_to_treatment_plan", { pat_num: 1, treat_plan_num: 9, proc_nums: [pn] });
  assert.equal(r2.results[0].result, "added");
  await run("od_update_treatment_plan", { pat_num: 1, treat_plan_num: 9, heading: "Phase 1" });
  assert.deepEqual(writes().at(-1).body, { Heading: "Phase 1" });
  const n = writes().length;
  await assert.rejects(run("od_add_to_treatment_plan", { pat_num: 1, treat_plan_num: 9, proc_nums: [101] }), /not treatment-planned/);
  await assert.rejects(run("od_add_to_treatment_plan", { pat_num: 1, treat_plan_num: 10, proc_nums: [103] }), /Saved/);
  await assert.rejects(run("od_add_to_treatment_plan", { pat_num: 1, treat_plan_num: 9, proc_nums: [103], priority: "ASAP" }), /No treatment priority named "ASAP"/);
  await assert.rejects(run("od_update_treatment_plan", { pat_num: 1, treat_plan_num: 10, heading: "x" }), /Saved/);
  await assert.rejects(run("od_update_treatment_plan", { pat_num: 2, treat_plan_num: 9, heading: "x" }), /not found for patient 2/);
  assert.equal(writes().length, n);
  for (const w of writes()) assert.ok(!w.body || (w.body.isSigned !== "true" && w.body.isSignedPractice === undefined));
});

test("set a whole plan's order in one confirmed call", async (t) => {
  const { run, od, writes } = await setup(t);
  const a = (await run("od_plan_procedure", { pat_num: 1, proc_code: "D2740", tooth: "2", treat_plan_num: 9 })).results.procedure.ProcNum;
  const b = (await run("od_plan_procedure", { pat_num: 1, proc_code: "D2950", tooth: "2", treat_plan_num: 9 })).results.procedure.ProcNum;
  const r = await run("od_set_treatment_plan_priorities", {
    pat_num: 1,
    treat_plan_num: 9,
    items: [
      { proc_nums: [a, b], priority: "1" },
      { proc_nums: [103, 105], priority: "Urgent" },
    ],
  });
  assert.deepEqual(r.results.map((x) => [x.ProcNum, x.DefNum]), [[a, 501], [b, 501], [103, 502], [105, 502]]);
  for (const [pn, d] of [[a, 501], [b, 501], [103, 502], [105, 502]]) {
    assert.equal(od.state.procs[pn].Priority, d);
    assert.equal(od.state.attaches.find((x) => x.ProcNum === pn).Priority, d);
  }
  const n = writes().length;
  // Everything is checked before anything changes.
  await assert.rejects(run("od_set_treatment_plan_priorities", { pat_num: 1, treat_plan_num: 9, items: [{ proc_nums: [103], priority: "1" }, { proc_nums: [101], priority: "Urgent" }] }), /not on treatment plan 9/);
  await assert.rejects(run("od_set_treatment_plan_priorities", { pat_num: 1, treat_plan_num: 9, items: [{ proc_nums: [103], priority: "1" }, { proc_nums: [103], priority: "Urgent" }] }), /more than one group/);
  await assert.rejects(run("od_set_treatment_plan_priorities", { pat_num: 1, treat_plan_num: 9, items: [{ proc_nums: [103], priority: "7" }] }), /No treatment priority named "7"/);
  await assert.rejects(run("od_set_treatment_plan_priorities", { pat_num: 1, treat_plan_num: 10, items: [{ proc_nums: [103], priority: "1" }] }), /Saved/);
  assert.equal(writes().length, n);
});

test("chart a procedure as complete, existing, referred or condition (read back)", async (t) => {
  const { run, writes, od } = await setup(t);
  const r = await run("od_chart_procedure", { pat_num: 1, proc_code: "D6010", status: "existing_other_provider", tooth: "8", note: "Implant placed elsewhere" });
  assert.equal(r.results.status, "existing (other provider)");
  const pn = r.results.procedure.ProcNum;
  assert.equal(od.state.procs[pn].ProcStatus, "EO");
  assert.equal(od.state.procs[pn].ToothNum, "8");
  assert.equal(writes().at(-1).body.isSigned, "false");

  const c = await run("od_chart_procedure", { pat_num: 1, proc_code: "D2391", status: "complete", tooth: "3", surfaces: "O", date: "2026-11-13", apt_num: 50, diagnosis: "Caries" });
  assert.match(c.charge, /fee posted/);
  const cb = writes().at(-1).body;
  assert.deepEqual({ s: cb.ProcStatus, d: cb.ProcDate, a: cb.AptNum, dx: cb.Dx, n: cb.dxName }, { s: "C", d: "2026-11-13", a: 50, dx: 601, n: undefined });
  for (const [status, code] of [["existing_current_provider", "EC"], ["referred", "R"], ["condition", "Cn"]]) {
    await run("od_chart_procedure", { pat_num: 1, proc_code: "D9999", status, tooth: "30" });
    assert.equal(writes().at(-1).body.ProcStatus, code);
  }
  const n = writes().length;
  await assert.rejects(run("od_chart_procedure", { pat_num: 1, proc_code: "D2740", status: "treatment_planned" }), /complete, existing/);
  await assert.rejects(run("od_chart_procedure", { pat_num: 1, proc_code: "D2740", status: "complete", apt_num: 53 }), /different patient/);
  await assert.rejects(run("od_chart_procedure", { pat_num: 1, proc_code: "D2740", status: "referred", apt_num: 50 }), /only applies to completed/);
  await assert.rejects(run("od_chart_procedure", { pat_num: 1, proc_code: "D2740", status: "complete", date: "2026-13-01" }), /real date/);
  assert.equal(writes().length, n);
});

test("change procedure status: never touches completed or deleted procedures", async (t) => {
  const { run, writes } = await setup(t);
  const r = await run("od_set_procedure_status", { pat_num: 1, proc_num: 103, status: "complete" });
  assert.equal(r.changed, "treatment planned → complete");
  assert.match(r.charge, /fee posted/);
  assert.equal(writes().at(-1).body.ProcStatus, "C");
  assert.match(writes().at(-1).body.ProcDate, /^\d{4}-/);
  await run("od_set_procedure_status", { pat_num: 1, proc_num: 106, status: "existing_current_provider", date: "2015-06-01" });
  assert.deepEqual(writes().at(-1).body, { ProcStatus: "EC", ProcDate: "2015-06-01" });
  await run("od_set_procedure_status", { pat_num: 1, proc_num: 105, status: "referred" });
  assert.deepEqual(writes().at(-1).body, { ProcStatus: "R" });
  const n = writes().length;
  await assert.rejects(run("od_set_procedure_status", { pat_num: 1, proc_num: 101, status: "treatment_planned" }), /already complete/);
  await assert.rejects(run("od_set_procedure_status", { pat_num: 1, proc_num: 103, status: "treatment_planned" }), /already complete/);
  await assert.rejects(run("od_set_procedure_status", { pat_num: 1, proc_num: 107, status: "complete" }), /deleted/);
  await assert.rejects(run("od_set_procedure_status", { pat_num: 1, proc_num: 106, status: "existing_current_provider" }), /already existing/);
  await assert.rejects(run("od_set_procedure_status", { pat_num: 2, proc_num: 105, status: "complete" }), /different patient/);
  await assert.rejects(run("od_set_procedure_status", { pat_num: 1, proc_num: 105, status: "done" }), /status must be/);
  assert.equal(writes().length, n);
});

test("tooth chart: read and mark missing, hidden, primary, permanent (read back)", async (t) => {
  const { run, writes, od } = await setup(t);
  const chart = await run("od_get_tooth_chart", { pat_num: 1 });
  assert.deepEqual(chart.results.missing, ["1"]);
  assert.deepEqual(chart.results.hidden, ["16"]);
  assert.deepEqual(chart.results.primary, [{ position: "4", primary_tooth: "A" }]);

  let r = await run("od_set_tooth_status", { pat_num: 1, teeth: ["1", "32", "19"], status: "missing" });
  assert.deepEqual(r.results.map((x) => x.result), ["already missing", "marked missing", "marked missing"]);
  assert.equal(r.verified, "Read back from Open Dental after saving.");
  assert.deepEqual((await run("od_get_tooth_chart", { pat_num: 1 })).results.missing.sort(), ["1", "19", "32"]);
  await run("od_set_tooth_status", { pat_num: 1, teeth: ["1"], status: "not_missing" });
  assert.match(writes().at(-1).path, /toothinitials\/301$/);

  r = await run("od_set_tooth_status", { pat_num: 1, teeth: ["T", "20"], status: "primary" });
  assert.deepEqual(r.results.map((x) => x.tooth), ["29 (T)", "20 (K)"]);
  r = await run("od_set_tooth_status", { pat_num: 1, teeth: ["A"], status: "permanent" });
  assert.match(writes().at(-1).path, /toothinitials\/302$/);
  r = await run("od_set_tooth_status", { pat_num: 1, teeth: ["5"], status: "permanent" });
  assert.equal(r.results[0].result, "already permanent");
  await run("od_set_tooth_status", { pat_num: 1, teeth: ["16"], status: "not_hidden" });
  assert.match(writes().at(-1).path, /toothinitials\/303$/);

  const n = writes().length;
  await assert.rejects(run("od_set_tooth_status", { pat_num: 1, teeth: ["1", "33"], status: "missing" }), /tooth number/);
  await assert.rejects(run("od_set_tooth_status", { pat_num: 1, teeth: ["1"], status: "primary" }), /no primary tooth/);
  await assert.rejects(run("od_set_tooth_status", { pat_num: 1, teeth: ["AS"], status: "missing" }), /Supernumerary/);
  await assert.rejects(run("od_set_tooth_status", { pat_num: 1, teeth: [], status: "missing" }), /1-32 teeth/);
  // Patient 2's #17 marking is never touched when working on patient 1.
  r = await run("od_set_tooth_status", { pat_num: 1, teeth: ["17"], status: "not_missing" });
  assert.equal(r.results[0].result, "already not missing");
  assert.equal(writes().length, n);
  assert.ok(od.state.toothinitials.some((x) => x.PatNum === 2 && x.ToothNum === "17"));
});

test("Treatment Notes box: read, add a line (keeps the rest), replace only from the text read", async (t) => {
  const { run, od, writes } = await setup(t);
  let r = await run("od_get_treatment_note", { pat_num: 1 });
  assert.equal(r.results.treatment_note, "Prefers morning appointments.");

  // Add keeps what was there, on a new line, and reads it back.
  r = await run("od_add_to_treatment_note", { pat_num: 1, text: "  Wants #30 crown before March.  " });
  assert.equal(r.results.treatment_note, "Prefers morning appointments.\r\nWants #30 crown before March.");
  assert.equal(r.verified, "Read back from Open Dental after saving.");
  const put = writes().at(-1);
  assert.equal(put.method, "PUT");
  assert.match(put.path, /\/patientnotes\/1$/);
  assert.deepEqual(Object.keys(put.body), ["Treatment"]);

  r = await run("od_add_to_treatment_note", { pat_num: 1, text: "Call after insurance resets.", date_stamp: true });
  assert.match(r.results.added, /^\d{4}-\d{2}-\d{2}: Call after insurance resets\.$/);

  // An empty box gets just the line.
  r = await run("od_add_to_treatment_note", { pat_num: 2, text: "First note." });
  assert.equal(r.results.treatment_note, "First note.");

  // Replace needs the current text; a stale copy changes nothing.
  const n = writes().length;
  await assert.rejects(run("od_replace_treatment_note", { pat_num: 1, current_text: "Prefers morning appointments.", new_text: "New" }), /has changed since it was read/);
  assert.equal(writes().length, n);
  const current = (await run("od_get_treatment_note", { pat_num: 1 })).results.treatment_note;
  r = await run("od_replace_treatment_note", { pat_num: 1, current_text: current.replace(/\r\n/g, "\n"), new_text: "Prefers mornings.\nCrown #30 before March." });
  assert.equal(r.results.previous_text, current);
  assert.equal(r.results.treatment_note, "Prefers mornings.\r\nCrown #30 before March.");
  assert.match(r.undo, /previous_text/);
  // Clearing is allowed.
  r = await run("od_replace_treatment_note", { pat_num: 2, current_text: "First note.", new_text: "" });
  assert.equal(r.results.treatment_note, "");

  // Bad input, missing patients and old Open Dental versions change nothing.
  const m = writes().length;
  await assert.rejects(run("od_add_to_treatment_note", { pat_num: 1, text: "   " }), /text is required/);
  await assert.rejects(run("od_add_to_treatment_note", { pat_num: 1, text: "x".repeat(4001) }), /too long/);
  await assert.rejects(run("od_add_to_treatment_note", { pat_num: 999, text: "x" }), /no patient note record/);
  await assert.rejects(run("od_add_to_treatment_note", { pat_num: 5, text: "x" }), /25\.2\.14/);
  await assert.rejects(run("od_replace_treatment_note", { pat_num: 1, new_text: "x" }), /current_text is required/);
  await assert.rejects(run("od_add_to_treatment_note", { pat_num: "1; DROP", text: "x" }));
  assert.equal(writes().length, m);

  // A write Open Dental ignores is reported as not made.
  od.state.ignoreNotePut = true;
  await assert.rejects(run("od_add_to_treatment_note", { pat_num: 1, text: "Lost" }), /NOT made/);
});
