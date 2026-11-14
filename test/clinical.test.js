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
    "od_add_to_treatment_plan",
    "od_append_procedure_note",
    "od_create_treatment_plan",
    "od_plan_procedure",
    "od_remove_planned_procedure",
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

test("plan a procedure: TP status, validated tooth/surface, optional note and plan", async (t) => {
  const { run, writes } = await setup(t);
  const r = await run("od_plan_procedure", {
    pat_num: 1,
    proc_code: "D2740",
    tooth: "30",
    priority: "Urgent",
    diagnosis: "Caries",
    note: "Fractured MB cusp",
    treat_plan_num: 9,
  });
  assert.equal(r.results.procedure.ProcNum, 200);
  const [proc, note, attach] = writes().slice(-3);
  assert.equal(proc.path, "/api/v1/procedurelogs");
  assert.equal(proc.body.ProcStatus, "TP");
  assert.equal(proc.body.procCode, "D2740");
  assert.equal(proc.body.ToothNum, "30");
  assert.equal(proc.body.priority, "Urgent");
  assert.equal(proc.body.dxName, "Caries");
  assert.match(proc.body.ProcDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(note.body, { PatNum: 1, ProcNum: 200, Note: "Fractured MB cusp", isSigned: "false" });
  assert.deepEqual(attach.body, { TreatPlanNum: 9, ProcNum: 200, Priority: 502 });

  await run("od_plan_procedure", { pat_num: 1, proc_code: "D2393", tooth: "3", surfaces: "mod" });
  assert.equal(writes().at(-1).body.Surf, "MOD");

  const n = writes().length;
  await assert.rejects(run("od_plan_procedure", { pat_num: 1, proc_code: "D2740", tooth: "33" }), /tooth number/);
  await assert.rejects(run("od_plan_procedure", { pat_num: 1, proc_code: "D2393", tooth: "3", surfaces: "MOX" }), /surface/);
  await assert.rejects(run("od_plan_procedure", { pat_num: 1, proc_code: "D27'40" }), /procedure code/);
  await assert.rejects(run("od_plan_procedure", { pat_num: 1, proc_code: "D2740", tooth: "30", treat_plan_num: 10 }), /Saved/);
  await assert.rejects(run("od_plan_procedure", { pat_num: 2, proc_code: "D2740", tooth: "30", treat_plan_num: 9 }), /not found for patient 2/);
  assert.equal(writes().length, n);
});

test("only planned procedures can be changed or removed", async (t) => {
  const { run, writes } = await setup(t);
  await run("od_update_planned_procedure", { pat_num: 1, proc_num: 103, tooth: "31", priority: "1" });
  assert.deepEqual(writes().at(-1).body, { ToothNum: "31", priority: "1" });
  await run("od_update_planned_procedure", { pat_num: 1, proc_num: 105, surfaces: "MO" }); // numeric status 1 = TP
  await run("od_remove_planned_procedure", { pat_num: 1, proc_num: 103 });
  assert.equal(writes().at(-1).method, "DELETE");
  const n = writes().length;
  await assert.rejects(run("od_update_planned_procedure", { pat_num: 1, proc_num: 101, tooth: "4" }), /not treatment-planned/);
  await assert.rejects(run("od_remove_planned_procedure", { pat_num: 1, proc_num: 101 }), /not treatment-planned/);
  await assert.rejects(run("od_remove_planned_procedure", { pat_num: 2, proc_num: 103 }), /different patient/);
  await assert.rejects(run("od_update_planned_procedure", { pat_num: 1, proc_num: 103 }), /Nothing to change/);
  assert.equal(writes().length, n);
});

test("treatment plans: create, group, rename; saved plans and other patients refused", async (t) => {
  const { run, writes } = await setup(t);
  await run("od_create_treatment_plan", { pat_num: 1, heading: "Phase 1 - Urgent", note: "Discussed options" });
  assert.deepEqual(writes().at(-1).body, { PatNum: 1, Heading: "Phase 1 - Urgent", Note: "Discussed options" });
  await run("od_add_to_treatment_plan", { pat_num: 1, treat_plan_num: 9, proc_nums: [103, 105], priority: "1" });
  assert.deepEqual(writes().slice(-2).map((w) => w.body), [
    { TreatPlanNum: 9, ProcNum: 103, Priority: 501 },
    { TreatPlanNum: 9, ProcNum: 105, Priority: 501 },
  ]);
  await run("od_update_treatment_plan", { pat_num: 1, treat_plan_num: 9, heading: "Phase 1" });
  assert.deepEqual(writes().at(-1).body, { Heading: "Phase 1" });
  const n = writes().length;
  await assert.rejects(run("od_add_to_treatment_plan", { pat_num: 1, treat_plan_num: 9, proc_nums: [101] }), /not treatment-planned/);
  await assert.rejects(run("od_add_to_treatment_plan", { pat_num: 1, treat_plan_num: 10, proc_nums: [103] }), /Saved/);
  await assert.rejects(run("od_add_to_treatment_plan", { pat_num: 1, treat_plan_num: 9, proc_nums: [103], priority: "ASAP" }), /No treatment priority named "ASAP"/);
  await assert.rejects(run("od_update_treatment_plan", { pat_num: 1, treat_plan_num: 10, heading: "x" }), /Saved/);
  await assert.rejects(run("od_update_treatment_plan", { pat_num: 2, treat_plan_num: 9, heading: "x" }), /not found for patient 2/);
  assert.equal(writes().length, n);
  // No tool ever sends a signature.
  for (const w of writes()) assert.ok(!w.body || (w.body.isSigned !== "true" && w.body.isSignedPractice === undefined));
});
