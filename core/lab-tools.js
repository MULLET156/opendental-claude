"use strict";
/**
 * Lab case tools: labs, turnarounds, lab cases, the open-case board, and
 * creating and updating cases (sent / received / checked).
 *
 * Changes need "Allow schedule changes" (lab cases are tied to appointments)
 * and Open Dental's general write permission. Nothing here deletes a lab case.
 */

const { ODError, redact, recordId, validDate } = require("./odclient");
const { buildReport } = require("./reports");

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const bool = (description) => ({ type: "boolean", description });
const num = (description) => ({ type: "number", description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

function out(data, extra = {}) {
  const payload = { results: redact(data) };
  if (Array.isArray(data)) payload.count = data.length;
  return { ...payload, ...extra };
}
const outPage = ({ rows, truncated }) =>
  out(rows, truncated ? { truncated: "Row limit reached; narrow the filters to see the rest." } : {});

/** Open Dental stores "no date" as 0001-01-01. */
const isBlankDate = (v) => !v || String(v).startsWith("0001-01-01") || String(v) < "1880";

function pad(n) {
  return String(n).padStart(2, "0");
}
function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Accept "yyyy-MM-dd" or "yyyy-MM-dd HH:mm:ss"; return the full form. */
function dateTime(name, v) {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m || !validDate(m[1]) || (m[2] && (Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] || 0) > 59))) {
    throw new ODError(`${name} must be a date "yyyy-MM-dd" or "yyyy-MM-dd HH:mm".`, { code: "bad_input" });
  }
  return m[2] ? `${m[1]} ${m[2]}:${m[3]}:${m[4] || "00"}` : `${m[1]} 00:00:00`;
}

function addDays(dt, days) {
  const [d, t] = dt.split(" ");
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + days);
  return `${x.toISOString().slice(0, 10)} ${t}`;
}

const APT_STATUS = { 1: "Scheduled", 2: "Complete", 3: "UnschedList", 5: "Broken", 6: "Planned", 7: "PtNote", 8: "PtNoteCompleted" };
const aptStatus = (a) => (typeof a.AptStatus === "number" ? APT_STATUS[a.AptStatus] : String(a.AptStatus || ""));

/**
 * @param {ReturnType<import('./odclient').createClient>} od
 * @param {{allowWrites: boolean}} opts
 */
function buildLabTools(od, { allowWrites = false } = {}) {
  const needWrites = () => {
    if (!allowWrites) {
      throw new ODError(
        'Lab case changes are turned off for this connection. Turn on "Allow schedule changes" in the Open Dental extension settings.',
        { code: "forbidden" }
      );
    }
  };

  async function getCase(num, patNum) {
    const c = await od.request("GET", `/labcases/${num}`);
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new ODError(`Lab case ${num} was not found.`, { code: "not_found" });
    if (patNum !== undefined && Number(c.PatNum) !== patNum) {
      throw new ODError(`Lab case ${num} belongs to a different patient (PatNum ${c.PatNum}), not ${patNum}. Nothing was changed.`, { code: "forbidden" });
    }
    return c;
  }

  /** Read a lab case back and confirm the fields took effect. */
  async function verifyCase(num, expected) {
    const c = await od.request("GET", `/labcases/${num}`);
    const bad = [];
    for (const [k, want] of Object.entries(expected)) {
      const got = c && c[k];
      const ok = typeof want === "number" ? Number(got) === want : String(got ?? "").trim() === String(want).trim();
      if (!ok) bad.push(`${k} should be ${want} but Open Dental has ${got === undefined || got === "" ? "nothing" : got}`);
    }
    if (bad.length) throw new ODError(`Open Dental accepted the change to lab case ${num} but did not apply it: ${bad.join("; ")}. Treat this change as NOT made.`, { code: "not_applied" });
    return c;
  }

  async function getAppt(aptNum) {
    const a = await od.request("GET", `/appointments/${aptNum}`);
    if (!a || typeof a !== "object" || Array.isArray(a)) throw new ODError(`Appointment ${aptNum} was not found.`, { code: "not_found" });
    return a;
  }

  async function checkAppt(aptNum, patNum, wantStatus) {
    const a = await getAppt(aptNum);
    if (Number(a.PatNum) !== patNum) throw new ODError(`Appointment ${aptNum} belongs to a different patient. Nothing was changed.`, { code: "forbidden" });
    if (aptStatus(a) !== wantStatus) throw new ODError(`Appointment ${aptNum} is ${aptStatus(a) || "unknown"}, not ${wantStatus}. Nothing was changed.`, { code: "bad_input" });
    return a;
  }

  return [
    // -------------------------------------------------------------- reads
    {
      name: "od_list_labs",
      annotations: READ,
      description: "List the office's dental labs (LaboratoryNum, name, phone, email) with each lab's services and turnaround days (published and actual).",
      inputSchema: obj({ include_hidden: bool("Include hidden labs. Default false.") }),
      run: async (a) => {
        const labs = await od.request("GET", "/laboratories");
        const turns = await od.request("GET", "/labturnarounds").catch(() => []);
        const list = (Array.isArray(labs) ? labs : []).filter((l) => a.include_hidden || !(l.IsHidden === true || l.IsHidden === "true"));
        return out(
          list.map((l) => ({
            ...l,
            turnarounds: (Array.isArray(turns) ? turns : [])
              .filter((t) => Number(t.LaboratoryNum) === Number(l.LaboratoryNum))
              .map((t) => ({ LabTurnaroundNum: t.LabTurnaroundNum, service: t.Description, days_published: t.DaysPublished, days_actual: t.DaysActual })),
          }))
        );
      },
    },
    {
      name: "od_get_lab_cases",
      annotations: READ,
      description: "List lab cases for a patient, an appointment, or a lab, with created/sent/due/received/checked dates and instructions.",
      inputSchema: obj({ pat_num: int("PatNum"), apt_num: int("AptNum"), lab_num: int("LaboratoryNum") }),
      run: async (a) => {
        const params = {
          PatNum: recordId("pat_num", a.pat_num, { required: false }),
          AptNum: recordId("apt_num", a.apt_num, { required: false }),
          LaboratoryNum: recordId("lab_num", a.lab_num, { required: false }),
        };
        if (!params.PatNum && !params.AptNum && !params.LaboratoryNum) {
          throw new ODError("Give a pat_num, apt_num or lab_num. For all open cases use od_get_open_lab_cases.", { code: "bad_input" });
        }
        return outPage(await od.getAll("/labcases", params));
      },
    },
    {
      name: "od_get_open_lab_cases",
      annotations: READ,
      description:
        "Lab case board: every case not yet checked, with status (not_sent, at_lab, received_not_checked), due date, overdue flag, and seat_risk when the seat appointment is within days_ahead days but the case isn't back.",
      inputSchema: obj({ lab_num: int("Only this lab."), days_ahead: int("Seat-risk window in days. Default 7.") }),
      run: async (a) =>
        outPage(await od.shortQuery(buildReport("lab_cases_open", { lab: recordId("lab_num", a.lab_num, { required: false }), days_ahead: a.days_ahead }))),
    },

    // -------------------------------------------------------------- changes
    {
      name: "od_create_lab_case",
      annotations: WRITE,
      description:
        "CHANGE. Create a lab case for a patient: lab, provider, instructions, due date (or a lab turnaround to compute it), optional seat appointment (must be the patient's Scheduled appointment) or planned appointment, and optionally mark it sent now. Confirm the details with the user first.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          lab_num: int("LaboratoryNum (from od_list_labs)."),
          prov_num: int("Provider ProvNum."),
          instructions: str("Lab instructions (shade, material, design notes...)."),
          due: str("Due date yyyy-MM-dd or yyyy-MM-dd HH:mm."),
          turnaround_num: int("LabTurnaroundNum: set the due date from the lab's actual turnaround days instead of 'due'."),
          apt_num: int("Seat appointment AptNum (Scheduled)."),
          planned_apt_num: int("Planned appointment AptNum."),
          mark_sent: bool("Also mark it sent now. Default false."),
          lab_fee: num("Lab fee (informational)."),
          invoice_num: str("Lab invoice number."),
        },
        ["pat_num", "lab_num", "prov_num"]
      ),
      run: async (a) => {
        needWrites();
        const patNum = recordId("pat_num", a.pat_num);
        const labNum = recordId("lab_num", a.lab_num);
        const now = nowLocal();
        const body = { PatNum: patNum, LaboratoryNum: labNum, ProvNum: recordId("prov_num", a.prov_num), DateTimeCreated: now };
        await od.request("GET", `/laboratories/${labNum}`);
        if (a.instructions) {
          if (typeof a.instructions !== "string" || a.instructions.length > 5000) throw new ODError("instructions must be text under 5000 characters.", { code: "bad_input" });
          body.Instructions = a.instructions;
        }
        if (a.mark_sent) body.DateTimeSent = now;
        let due = dateTime("due", a.due);
        if (!due && a.turnaround_num != null) {
          const tnum = recordId("turnaround_num", a.turnaround_num);
          const t = await od.request("GET", `/labturnarounds/${tnum}`);
          if (!t || Number(t.LaboratoryNum) !== labNum) throw new ODError("That turnaround belongs to a different lab.", { code: "bad_input" });
          due = addDays(body.DateTimeSent || now, Number(t.DaysActual) || 0);
        }
        if (due) body.DateTimeDue = due;
        if (a.apt_num != null) body.AptNum = (await checkAppt(recordId("apt_num", a.apt_num), patNum, "Scheduled")).AptNum;
        if (a.planned_apt_num != null) body.PlannedAptNum = (await checkAppt(recordId("planned_apt_num", a.planned_apt_num), patNum, "Planned")).AptNum;
        if (a.lab_fee != null) {
          if (!Number.isFinite(a.lab_fee) || a.lab_fee < 0) throw new ODError("lab_fee must be a positive number.", { code: "bad_input" });
          body.LabFee = a.lab_fee;
        }
        if (a.invoice_num) body.InvoiceNum = String(a.invoice_num).slice(0, 100);
        return out(await od.request("POST", "/labcases", { body }));
      },
    },
    {
      name: "od_update_lab_case_status",
      annotations: WRITE,
      description:
        "CHANGE. Mark a lab case sent, received (back from the lab) or checked (quality-checked, ready to seat), now or at a given date/time. Steps go in order: sent, then received, then checked. A step already recorded is only replaced with overwrite=true (show the old and new date and get a yes). Confirm with the user first.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          lab_case_num: int("LabCaseNum"),
          step: { type: "string", enum: ["sent", "received", "checked"], description: "Which step happened." },
          when: str("yyyy-MM-dd or yyyy-MM-dd HH:mm. Default now."),
          overwrite: bool("Replace a date already recorded for this step. Default false."),
        },
        ["pat_num", "lab_case_num", "step"]
      ),
      run: async (a) => {
        needWrites();
        const patNum = recordId("pat_num", a.pat_num);
        const num = recordId("lab_case_num", a.lab_case_num);
        const c = await getCase(num, patNum);
        const field = { sent: "DateTimeSent", received: "DateTimeRecd", checked: "DateTimeChecked" }[a.step];
        if (!field) throw new ODError("step must be sent, received or checked.", { code: "bad_input" });
        if (!isBlankDate(c[field]) && a.overwrite !== true) {
          throw new ODError(`Lab case ${num} is already marked ${a.step} (${c[field]}). Pass overwrite=true to replace that date. Nothing was changed.`, { code: "bad_input" });
        }
        if (a.step === "received" && isBlankDate(c.DateTimeSent)) throw new ODError(`Lab case ${num} was never marked sent; mark it sent first.`, { code: "bad_input" });
        if (a.step === "checked" && isBlankDate(c.DateTimeRecd)) throw new ODError(`Lab case ${num} hasn't been received yet; mark it received first.`, { code: "bad_input" });
        const value = dateTime("when", a.when) || nowLocal();
        await od.request("PUT", `/labcases/${num}`, { body: { [field]: value } });
        const after = await verifyCase(num, { [field]: value });
        return out(after, { verified: "Read back from Open Dental after saving.", ...(isBlankDate(c[field]) ? {} : { replaced: `${c[field]} → ${value}` }) });
      },
    },
    {
      name: "od_update_lab_case",
      annotations: WRITE,
      description:
        "CHANGE. Change a lab case's due date, instructions, seat appointment (patient's Scheduled appointment), lab, provider, fee or invoice number, or unlink its appointment or planned appointment (e.g. when it points at another patient's appointment). Confirm the before and after with the user first.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          lab_case_num: int("LabCaseNum"),
          due: str("New due date."),
          instructions: str("New instructions (replaces the old text)."),
          apt_num: int("New seat appointment AptNum."),
          lab_num: int("New LaboratoryNum."),
          prov_num: int("New provider ProvNum."),
          lab_fee: num("Lab fee."),
          invoice_num: str("Invoice number."),
          unlink_appointment: bool("Remove the link to its appointment (AptNum becomes 0)."),
          unlink_planned_appointment: bool("Remove the link to its planned appointment."),
        },
        ["pat_num", "lab_case_num"]
      ),
      run: async (a) => {
        needWrites();
        const patNum = recordId("pat_num", a.pat_num);
        const num = recordId("lab_case_num", a.lab_case_num);
        const before = await getCase(num, patNum);
        const body = {};
        const due = dateTime("due", a.due);
        if (due) body.DateTimeDue = due;
        if (a.instructions) {
          if (typeof a.instructions !== "string" || a.instructions.length > 5000) throw new ODError("instructions must be text under 5000 characters.", { code: "bad_input" });
          body.Instructions = a.instructions;
        }
        if (a.apt_num != null && a.unlink_appointment) throw new ODError("Give either apt_num or unlink_appointment, not both.", { code: "bad_input" });
        if (a.apt_num != null) body.AptNum = Number((await checkAppt(recordId("apt_num", a.apt_num), patNum, "Scheduled")).AptNum);
        if (a.unlink_appointment) {
          if (!Number(before.AptNum)) throw new ODError(`Lab case ${num} isn't linked to an appointment. Nothing was changed.`, { code: "bad_input" });
          body.AptNum = 0;
        }
        if (a.unlink_planned_appointment) {
          if (!Number(before.PlannedAptNum)) throw new ODError(`Lab case ${num} isn't linked to a planned appointment. Nothing was changed.`, { code: "bad_input" });
          body.PlannedAptNum = 0;
        }
        if (a.lab_num != null) {
          body.LaboratoryNum = recordId("lab_num", a.lab_num);
          await od.request("GET", `/laboratories/${body.LaboratoryNum}`);
        }
        if (a.prov_num != null) body.ProvNum = recordId("prov_num", a.prov_num);
        if (a.lab_fee != null) {
          if (!Number.isFinite(a.lab_fee) || a.lab_fee < 0) throw new ODError("lab_fee must be a positive number.", { code: "bad_input" });
          body.LabFee = a.lab_fee;
        }
        if (a.invoice_num) body.InvoiceNum = String(a.invoice_num).slice(0, 100);
        if (!Object.keys(body).length) throw new ODError("Nothing to change.", { code: "bad_input" });
        await od.request("PUT", `/labcases/${num}`, { body });
        const after = await verifyCase(num, body);
        const notes = {};
        if ("AptNum" in body) notes.appointment = `${Number(before.AptNum) || "none"} → ${body.AptNum || "none"}`;
        return out(after, { verified: "Read back from Open Dental after saving.", ...notes });
      },
    },
    {
      name: "od_mark_lab_cases_received",
      annotations: WRITE,
      description:
        "CHANGE (cleanup). Mark old lab cases as received, for cases whose linked appointment is Complete. The received date is the appointment's date, or received_date if given. Already-received cases are skipped unless overwrite_received=true, which re-dates them (the preview shows old and new dates). Up to 50 per call. Each case is checked first and skipped (with the reason) if it has no linked appointment, the appointment isn't Complete, or the appointment is on/after 'before'. Every write is read back. Never deletes. With preview=true (the default) nothing is written: show the user the preview, then call again with preview=false after a clear yes. Find candidates with od_run_report 'lab_cases_unreceived_completed' (never received) or 'lab_cases_received_on_appointment_date' (received date equals the appointment date).",
      inputSchema: obj(
        {
          lab_case_nums: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 50, description: "LabCaseNums to mark received." },
          before: str("Skip cases whose appointment is on or after this date (yyyy-MM-dd)."),
          received_date: str("Use this received date (yyyy-MM-dd or yyyy-MM-dd HH:mm) instead of each appointment's date."),
          overwrite_received: bool("Re-date cases that already have a received date. Default false."),
          preview: bool("Default true: only check and report what would change."),
        },
        ["lab_case_nums"]
      ),
      run: async (a) => {
        const preview = a.preview !== false;
        if (!preview) needWrites();
        if (!Array.isArray(a.lab_case_nums) || !a.lab_case_nums.length || a.lab_case_nums.length > 50) {
          throw new ODError("lab_case_nums must list 1-50 lab cases.", { code: "bad_input" });
        }
        let before;
        if (a.before) {
          if (!validDate(a.before)) throw new ODError("before must be a date yyyy-MM-dd.", { code: "bad_input" });
          before = a.before;
        }
        const fixedDate = dateTime("received_date", a.received_date);
        const overwrite = a.overwrite_received === true;
        const nums = [...new Set(a.lab_case_nums.map((n) => recordId("lab_case_nums", n)))];
        const results = [];
        let stopped = null;
        for (const num of nums) {
          if (stopped) {
            results.push({ LabCaseNum: num, result: "not attempted" });
            continue;
          }
          const r = { LabCaseNum: num };
          try {
            const c = await getCase(num);
            r.PatNum = c.PatNum;
            const already = !isBlankDate(c.DateTimeRecd);
            if (already && !overwrite) throw new Error(`already received ${c.DateTimeRecd}`);
            const aptNum = Number(c.AptNum);
            if (!aptNum) throw new Error("no linked appointment");
            const appt = await getAppt(aptNum);
            if (Number(appt.PatNum) !== Number(c.PatNum)) throw new Error("linked appointment belongs to a different patient");
            if (aptStatus(appt) !== "Complete") throw new Error(`appointment ${aptNum} is ${aptStatus(appt) || "unknown"}, not Complete`);
            const when = String(appt.AptDateTime || "");
            if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(when) || isBlankDate(when)) throw new Error("appointment has no date");
            if (before && when.slice(0, 10) >= before) throw new Error(`appointment ${when.slice(0, 10)} is on/after ${before}`);
            const target = fixedDate || when;
            if (already && String(c.DateTimeRecd).trim() === target) throw new Error(`already received on ${target}`);
            r.AptNum = aptNum;
            r.AppointmentDate = when;
            if (already) r.OldReceivedDate = c.DateTimeRecd;
            r.ReceivedDate = target;
            r.NeverSent = isBlankDate(c.DateTimeSent);
            const verb = already ? "re-date received" : "mark received";
            if (preview) {
              r.result = `would ${verb}`;
            } else {
              await od.request("PUT", `/labcases/${num}`, { body: { DateTimeRecd: target } });
              await verifyCase(num, { DateTimeRecd: target });
              r.result = already ? "re-dated received" : "marked received";
            }
          } catch (e) {
            // Problems with Open Dental itself (keys, permissions, network, rate limits) stop the batch;
            // problems with one case (not found, wrong state) skip just that case.
            const caseProblem = !(e instanceof ODError) || e.code === "not_found" || e.status === 404;
            if (caseProblem) {
              r.result = "skipped";
              r.reason = e.message;
            } else {
              r.result = r.ReceivedDate && !preview ? "failed" : "skipped";
              r.reason = e.message;
              stopped = e.message;
            }
          }
          results.push(r);
        }
        const tally = results.reduce((t, r) => ((t[r.result] = (t[r.result] || 0) + 1), t), {});
        return out(results, { preview, summary: tally, ...(stopped ? { stopped: `Stopped early: ${stopped}` } : {}) });
      },
    },
  ];
}

module.exports = { buildLabTools };
