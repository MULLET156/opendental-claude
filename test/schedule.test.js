"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { startFakeOD } = require("./fake-od");
const { createClient } = require("../core/odclient");
const { buildTools } = require("../core/tools");

async function setup(t, opts = { allowWrites: true }) {
  const od = await startFakeOD();
  t.after(() => od.close());
  const client = createClient({ baseUrl: od.url, developerKey: "dev1", customerKey: "cust1" });
  const tools = Object.fromEntries(buildTools(client, opts).map((x) => [x.name, x]));
  return { od, run: (n, a) => tools[n].run(a) };
}

test("open slots: lunch blockouts are removed or trimmed, and reported", async (t) => {
  const { run } = await setup(t);
  const r = await run("od_find_open_slots", { date_start: "2026-11-16" });
  const slots = r.results.map((s) => `${s.DateTimeStart.slice(11, 16)}-${s.DateTimeEnd.slice(11, 16)} op${s.OpNum}`);
  assert.deepEqual(slots, ["08:00-09:00 op3", "11:00-12:00 op3", "13:00-14:00 op3", "12:30-13:00 op5"]);
  assert.deepEqual(r.removed_for_blockouts.map((x) => x.result), ["trimmed", "removed"]);
  assert.match(r.removed_for_blockouts[1].blockouts[0], /12:00:00-13:00:00 \(Lunch\)/);
  const raw = await run("od_find_open_slots", { date_start: "2026-11-16", include_blockouts: true });
  assert.equal(raw.count, 4);
});

test("open slots: trimmed pieces shorter than the requested length are dropped", async (t) => {
  const { run, od } = await setup(t);
  od.state.slots = [{ DateTimeStart: "2026-11-16 11:30:00", DateTimeEnd: "2026-11-16 13:30:00", ProvNum: 1, OpNum: 3 }];
  const r = await run("od_find_open_slots", { date_start: "2026-11-16", length_minutes: 60 });
  assert.equal(r.count, 0);
  assert.equal(r.removed_for_blockouts[0].result, "removed");
});

test("schedule writes are read back; silent no-ops are reported as NOT made", async (t) => {
  const { run, od } = await setup(t);
  const moved = await run("od_reschedule_appointment", { apt_num: 52, apt_date_time: "2026-11-21 08:00:00", op: 4 });
  assert.equal(moved.verified, "Read back from Open Dental after saving.");
  assert.equal(od.state.appts[52].AptDateTime, "2026-11-21 08:00:00");
  const note = await run("od_add_appointment_note", { apt_num: 52, note: "Bring night guard" });
  assert.match(note.results.Note, /Bring night guard/);
  await run("od_confirm_appointment", { apt_num: 52, confirm_val: "Confirmed" });
  assert.equal(od.state.appts[52].confirmed, "Confirmed");
  await assert.rejects(run("od_break_appointment", { apt_num: 50 }), /Complete; only Scheduled/);
  await assert.rejects(run("od_break_appointment", { apt_num: 52, break_type: "Late" }), /Missed or Cancelled/);
  od.state.ignoreApptPut = true;
  await assert.rejects(run("od_reschedule_appointment", { apt_num: 52, apt_date_time: "2026-11-22 08:00:00" }), /did not apply.*NOT made/);
  await assert.rejects(run("od_add_appointment_note", { apt_num: 52, note: "x" }), /NOT made/);
  await assert.rejects(run("od_confirm_appointment", { apt_num: 52, confirm_val: "Left Msg" }), /NOT made/);
  await assert.rejects(run("od_break_appointment", { apt_num: 52 }), /still shows Scheduled.*NOT made/);
});
