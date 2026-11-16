"use strict";
/**
 * MCP tool definitions for Claude, built on the shared Open Dental client.
 * Each tool: { name, description, inputSchema, annotations, run(args) }.
 */

const { ODError, redact, checkDate, checkDateTime, checkPattern, recordId } = require("./odclient");
const { runReport, describeReports } = require("./reports");

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const WRITE_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const bool = (description) => ({ type: "boolean", description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

function out(data, extra = {}) {
  const payload = { results: redact(data) };
  if (Array.isArray(data)) payload.count = data.length;
  return { ...payload, ...extra };
}
const outPage = ({ rows, truncated }) =>
  out(rows, truncated ? { truncated: "Row limit reached; narrow the filters to see the rest." } : {});

function dateParams(start, end) {
  if (!end || end === start) return { date: start };
  return { dateStart: start, dateEnd: end };
}

// ------------------------------------------------------------------ blockouts

const toMin = (hms) => {
  const m = String(hms || "").match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fromMin = (date, mins) => `${date} ${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;

function blockoutOps(b) {
  const ops = b.operatories ?? b.Operatories ?? b.Ops;
  if (Array.isArray(ops)) return ops.map((o) => Number(typeof o === "object" ? o.OperatoryNum : o)).filter(Boolean);
  if (typeof ops === "string" && ops.trim()) return ops.split(",").map((x) => Number(x.trim())).filter(Boolean);
  return []; // none listed: treat as every operatory
}

/**
 * Remove blockout time (lunch, meetings) from open slots. A slot partly covered is trimmed;
 * one fully covered is dropped. Returns kept slots and what was removed.
 */
function subtractBlockouts(slots, blockouts, minLength) {
  const kept = [];
  const removed = [];
  for (const slot of slots) {
    const start = String(slot.DateTimeStart || "");
    const end = String(slot.DateTimeEnd || "");
    const date = start.slice(0, 10);
    const s0 = toMin(start.slice(11));
    const e0 = toMin(end.slice(11));
    if (!date || s0 === null || e0 === null || end.slice(0, 10) !== date) {
      kept.push(slot);
      continue;
    }
    const op = Number(slot.OpNum ?? slot.Op ?? 0);
    const covering = blockouts
      .filter((b) => String(b.SchedDate || "").slice(0, 10) === date)
      .filter((b) => {
        const ops = blockoutOps(b);
        return !ops.length || !op || ops.includes(op);
      })
      .map((b) => ({ s: toMin(b.StartTime), e: toMin(b.StopTime), b }))
      .filter((x) => x.s !== null && x.e !== null && x.s < e0 && x.e > s0)
      .sort((x, y) => x.s - y.s);
    if (!covering.length) {
      kept.push(slot);
      continue;
    }
    let pieces = [[s0, e0]];
    for (const c of covering) {
      pieces = pieces.flatMap(([ps, pe]) => [
        ...(c.s > ps ? [[ps, Math.min(pe, c.s)]] : []),
        ...(c.e < pe ? [[Math.max(ps, c.e), pe]] : []),
      ]).filter(([ps, pe]) => pe > ps);
    }
    const min = Number(minLength) || 1;
    const good = pieces.filter(([ps, pe]) => pe - ps >= min);
    for (const [ps, pe] of good) kept.push({ ...slot, DateTimeStart: fromMin(date, ps), DateTimeEnd: fromMin(date, pe) });
    removed.push({
      slot: `${start} - ${end.slice(11)}${op ? ` op ${op}` : ""}`,
      blockouts: covering.map((c) => `${c.b.StartTime}-${c.b.StopTime}${c.b.Note ? ` (${c.b.Note})` : ""}`),
      result: good.length ? "trimmed" : "removed",
    });
  }
  return { kept, removed };
}

/**
 * @param {ReturnType<import('./odclient').createClient>} od
 * @param {{allowWrites: boolean}} opts
 */
function buildTools(od, { allowWrites = false, allowChartChanges = false } = {}) {
  const needWrites = () => {
    if (!allowWrites) {
      throw new ODError(
        'Changes are turned off for this connection. Turn on "Allow schedule changes" in the Open Dental extension settings to book, move or confirm appointments and add notes.',
        { code: "forbidden" }
      );
    }
  };

  /** Read an appointment back and confirm the fields took effect. */
  async function verifyAppt(aptNum, expected) {
    const ap = await od.request("GET", `/appointments/${aptNum}`);
    const bad = [];
    for (const [k, want] of Object.entries(expected)) {
      if (want === undefined) continue;
      const got = ap && ap[k];
      const ok = typeof want === "number" ? Number(got) === want : String(got ?? "").trim() === String(want).trim();
      if (!ok) bad.push(`${k} should be ${want} but Open Dental has ${got ?? "nothing"}`);
    }
    if (bad.length) throw new ODError(`Open Dental accepted the change to appointment ${aptNum} but did not apply it: ${bad.join("; ")}. Treat this change as NOT made.`, { code: "not_applied" });
    return ap;
  }

  return [
    // -------------------------------------------------------------- reads
    {
      name: "od_connection_check",
      annotations: READ,
      description:
        "Check that the Open Dental connection works and show which URL is in use and whether changes are allowed. Run this first if anything fails.",
      inputSchema: obj({}),
      run: async () => {
        const provs = await od.request("GET", "/providers");
        return out({
          base_url: od.baseUrl,
          mode: od.isCloud ? `cloud (one request every ${od.minIntervalMs / 1000} s)` : "local network (not throttled)",
          writes_enabled: allowWrites,
          chart_changes_enabled: allowChartChanges,
          providers_visible: Array.isArray(provs) ? provs.length : null,
        });
      },
    },
    {
      name: "od_list_providers",
      annotations: READ,
      description: "List providers (ProvNum, Abbr, name, hidden flag). Use to map provider names or abbreviations to ProvNum.",
      inputSchema: obj({ clinic_num: int("Optional ClinicNum filter.") }),
      run: async (a) => {
        const { rows } = await od.getAll("/providers", { ClinicNum: recordId("clinic_num", a.clinic_num, { required: false }) });
        const keep = ["ProvNum", "Abbr", "FName", "LName", "Suffix", "IsSecondary", "IsHidden", "ProvStatus", "Specialty", "ClinicNum"];
        return out(rows.map((r) => Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, r[k]]))));
      },
    },
    {
      name: "od_list_operatories",
      annotations: READ,
      description: "List operatories (chairs): OperatoryNum, name, abbreviation, assigned dentist and hygienist, hidden flag.",
      inputSchema: obj({ clinic_num: int("Optional ClinicNum filter.") }),
      run: async (a) => outPage(await od.getAll("/operatories", { ClinicNum: recordId("clinic_num", a.clinic_num, { required: false }) })),
    },
    {
      name: "od_search_patients",
      annotations: READ,
      description:
        'Search patients like the Select Patient window. Name fields match leading characters ("smi" finds Smith). Returns PatNum, name, birthdate, status, phones, email. If several match, ask the user which one; never guess.',
      inputSchema: obj({
        last_name: str("Last name or its first letters."),
        first_name: str("First name or its first letters."),
        birthdate: str("yyyy-MM-dd"),
        phone: str("Any phone number, digits only is fine."),
        email: str("Email address."),
        chart_number: str("Chart number."),
        hide_inactive: bool("Hide inactive patients. Default true."),
        max_rows: int("Maximum rows. Default 50."),
      }),
      run: async (a) => {
        checkDate("birthdate", a.birthdate);
        if (![a.last_name, a.first_name, a.birthdate, a.phone, a.email, a.chart_number].some(Boolean)) {
          throw new ODError("Give at least one search field (name, birthdate, phone, email or chart number).", { code: "bad_input" });
        }
        return outPage(
          await od.getAll(
            "/patients",
            {
              LName: a.last_name,
              FName: a.first_name,
              Birthdate: a.birthdate,
              Phone: a.phone,
              Email: a.email,
              ChartNumber: a.chart_number,
              hideInactive: a.hide_inactive ?? true,
            },
            { limit: a.max_rows || 50 }
          )
        );
      },
    },
    {
      name: "od_get_patient",
      annotations: READ,
      description: "Get one patient's full record by PatNum: demographics, guarantor, provider, status, balances. SSN is always redacted.",
      inputSchema: obj({ pat_num: int("PatNum") }, ["pat_num"]),
      run: async (a) => out(await od.request("GET", `/patients/${recordId("pat_num", a.pat_num)}`)),
    },
    {
      name: "od_get_appointments",
      annotations: READ,
      description:
        "List appointments for a day or date range (yyyy-MM-dd, inclusive), or one patient's with pat_num. Returns AptNum, PatNum, AptDateTime, AptStatus, Op, ProvNum, ProvHyg, Pattern (5 min per character), Confirmed, ProcDescript, Note.",
      inputSchema: obj({
        date_start: str("yyyy-MM-dd"),
        date_end: str("yyyy-MM-dd, inclusive. Omit for one day."),
        pat_num: int("Only this patient's appointments."),
        prov_num: int("Only this provider."),
        clinic_num: int("Optional ClinicNum filter."),
        max_rows: int("Maximum rows. Default 500."),
      }),
      run: async (a) => {
        checkDate("date_start", a.date_start);
        checkDate("date_end", a.date_end);
        if (!a.date_start && !a.pat_num) throw new ODError("Give a date_start (and optionally date_end) or a pat_num.", { code: "bad_input" });
        const params = {
          PatNum: recordId("pat_num", a.pat_num, { required: false }),
          ProvNum: recordId("prov_num", a.prov_num, { required: false }),
          ClinicNum: recordId("clinic_num", a.clinic_num, { required: false }),
          ...(a.date_start ? dateParams(a.date_start, a.date_end) : {}),
        };
        return outPage(await od.getAll("/appointments", params, { limit: a.max_rows }));
      },
    },
    {
      name: "od_find_open_slots",
      annotations: READ,
      description:
        "Find open schedule slots (honoring provider schedules across operatories). Dates yyyy-MM-dd inclusive. length_minutes drops shorter slots. Open Dental's slot search ignores blockouts (lunch, meetings), so this tool removes or trims slots that overlap a blockout and lists what it removed; set include_blockouts=true to see raw slots.",
      inputSchema: obj(
        {
          date_start: str("yyyy-MM-dd"),
          date_end: str("yyyy-MM-dd, inclusive. Omit for one day."),
          prov_num: int("Provider ProvNum."),
          op_num: int("OperatoryNum."),
          length_minutes: int("Minimum slot length in minutes."),
          clinic_num: int("Optional ClinicNum filter."),
          include_blockouts: bool("Return Open Dental's raw slots without removing blockout time. Default false."),
        },
        ["date_start"]
      ),
      run: async (a) => {
        checkDate("date_start", a.date_start, { required: true });
        checkDate("date_end", a.date_end);
        const range = dateParams(a.date_start, a.date_end);
        const page = await od.getAll("/appointments/Slots", {
          ...range,
          ProvNum: recordId("prov_num", a.prov_num, { required: false }),
          OpNum: recordId("op_num", a.op_num, { required: false }),
          lengthMinutes: a.length_minutes,
          ClinicNum: recordId("clinic_num", a.clinic_num, { required: false }),
        });
        if (a.include_blockouts) return outPage(page);
        let blockouts;
        try {
          blockouts = (await od.getAll("/schedules", { ...range, SchedType: "Blockout" })).rows;
        } catch (e) {
          return { ...outPage(page), warning: `Couldn't read blockouts (${e.message}); some slots may fall inside lunch or other blockouts. Check before booking.` };
        }
        const { kept, removed } = subtractBlockouts(page.rows, blockouts, a.length_minutes);
        return out(kept, {
          ...(page.truncated ? { truncated: "Row limit reached; narrow the filters to see the rest." } : {}),
          ...(removed.length ? { removed_for_blockouts: removed } : {}),
        });
      },
    },
    {
      name: "od_get_asap_list",
      annotations: READ,
      description: "List appointments on the ASAP list (patients who want an earlier opening).",
      inputSchema: obj({ clinic_num: int("Optional ClinicNum filter.") }),
      run: async (a) => outPage(await od.getAll("/appointments/ASAP", { ClinicNum: recordId("clinic_num", a.clinic_num, { required: false }) })),
    },
    {
      name: "od_get_commlogs",
      annotations: READ,
      description: "Get a patient's communication log (calls, texts, emails, notes) by PatNum.",
      inputSchema: obj({ pat_num: int("PatNum"), max_rows: int("Maximum rows. Default 50.") }, ["pat_num"]),
      run: async (a) => outPage(await od.getAll("/commlogs", { PatNum: recordId("pat_num", a.pat_num) }, { limit: a.max_rows || 50 })),
    },
    {
      name: "od_list_reports",
      annotations: READ,
      description:
        "List the built-in reports (production, collections, A/R aging, claims, recall, treatment plan, procedure counts) and their parameters. Prefer these over writing SQL.",
      inputSchema: obj({}),
      run: async () => out(describeReports()),
    },
    {
      name: "od_run_report",
      annotations: READ,
      description:
        "Run a built-in report by name with its parameters, e.g. {name:'production_by_provider', params:{from:'2026-11-01', to:'2026-11-30'}}. Call od_list_reports to see names and parameters.",
      inputSchema: obj({ name: str("Report name."), params: { type: "object", description: "Report parameters." } }, ["name"]),
      run: async (a) => outPage(await runReport(od, a.name, a.params || {})),
    },
    {
      name: "od_run_query",
      annotations: READ,
      description:
        "Run a custom read-only SQL query against the Open Dental database (Open Dental also screens it as read-only and records it in the audit trail). Use only when no built-in report fits. Select only needed columns; never select SSN. Open Dental's query filter rejects some functions (e.g. REPEAT()); rewrite without them.",
      inputSchema: obj({ sql: str("One read-only SELECT statement."), max_rows: int("Maximum rows. Default 500.") }, ["sql"]),
      run: async (a) => outPage(await od.shortQuery(a.sql, { limit: a.max_rows })),
    },

    // -------------------------------------------------------------- changes
    {
      name: "od_add_commlog",
      annotations: WRITE,
      description: "CHANGE. Add a commlog entry to a patient's chart. Confirm the exact note text with the user before calling.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          note: str("Note text."),
          mode: {
            type: "string",
            enum: ["None", "Email", "Mail", "Phone", "In Person", "Text", "Email and Text", "Phone and Text"],
            description: "How the communication happened. Default None.",
          },
          sent_or_received: { type: "string", enum: ["Neither", "Sent", "Received"], description: "Default Neither." },
          comm_date_time: str("yyyy-MM-dd HH:mm:ss. Defaults to now."),
        },
        ["pat_num", "note"]
      ),
      run: async (a) => {
        needWrites();
        if (!a.note || typeof a.note !== "string") throw new ODError("note is required.", { code: "bad_input" });
        const body = {
          PatNum: recordId("pat_num", a.pat_num),
          Note: a.note,
          Mode_: a.mode || "None",
          SentOrReceived: a.sent_or_received || "Neither",
        };
        if (a.comm_date_time) {
          checkDateTime("comm_date_time", a.comm_date_time);
          body.CommDateTime = a.comm_date_time;
        }
        const created = await od.request("POST", "/commlogs", { body });
        const num = Number(created && created.CommlogNum);
        const list = await od.request("GET", "/commlogs", { params: { PatNum: body.PatNum } });
        if (!num || !(Array.isArray(list) && list.some((c) => Number(c.CommlogNum) === num))) {
          throw new ODError("Open Dental accepted the commlog but it isn't in the patient's communication log. Check before retrying.", { code: "not_applied" });
        }
        return out(created, { verified: "Read back from Open Dental after saving." });
      },
    },
    {
      name: "od_create_appointment",
      annotations: WRITE,
      description:
        "CHANGE. Book a new scheduled appointment. pattern is the length in 5-minute units, e.g. 'XXXXXX' = 30 min ('/' = assistant-only time). Check the slot with od_find_open_slots and confirm patient, date, time, chair and provider with the user first.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          apt_date_time: str("yyyy-MM-dd HH:mm:ss"),
          op: int("OperatoryNum"),
          prov_num: int("Dentist ProvNum."),
          prov_hyg: int("Hygienist ProvNum."),
          pattern: str("Time pattern of X and / characters."),
          note: str("Appointment note."),
          is_new_patient: bool("New patient appointment."),
        },
        ["pat_num", "apt_date_time", "op"]
      ),
      run: async (a) => {
        needWrites();
        checkDateTime("apt_date_time", a.apt_date_time);
        checkPattern(a.pattern);
        const body = { PatNum: recordId("pat_num", a.pat_num), AptDateTime: a.apt_date_time, Op: recordId("op", a.op) };
        if (a.prov_num != null) body.ProvNum = recordId("prov_num", a.prov_num);
        if (a.prov_hyg != null) body.ProvHyg = recordId("prov_hyg", a.prov_hyg);
        if (a.pattern) body.Pattern = a.pattern;
        if (a.note) body.Note = String(a.note);
        if (a.is_new_patient != null) body.IsNewPatient = a.is_new_patient ? "true" : "false";
        const created = await od.request("POST", "/appointments", { body });
        const aptNum = Number(created && created.AptNum);
        if (!aptNum) throw new ODError("Open Dental did not return the new appointment's number; check the schedule before retrying.", { code: "not_applied" });
        const after = await verifyAppt(aptNum, { AptDateTime: body.AptDateTime, Op: body.Op, PatNum: body.PatNum });
        return out(after, { verified: "Read back from Open Dental after saving." });
      },
    },
    {
      name: "od_reschedule_appointment",
      annotations: WRITE,
      description: "CHANGE. Move an appointment to a new date/time and/or chair, or change its provider or length. Confirm old and new details first.",
      inputSchema: obj(
        {
          apt_num: int("AptNum"),
          apt_date_time: str("New yyyy-MM-dd HH:mm:ss"),
          op: int("New OperatoryNum"),
          prov_num: int("New dentist ProvNum"),
          pattern: str("New time pattern"),
        },
        ["apt_num"]
      ),
      run: async (a) => {
        needWrites();
        const body = {};
        if (a.apt_date_time) {
          checkDateTime("apt_date_time", a.apt_date_time);
          body.AptDateTime = a.apt_date_time;
        }
        if (a.op != null) body.Op = recordId("op", a.op);
        if (a.prov_num != null) body.ProvNum = recordId("prov_num", a.prov_num);
        if (a.pattern) {
          checkPattern(a.pattern);
          body.Pattern = a.pattern;
        }
        if (!Object.keys(body).length) throw new ODError("Nothing to change.", { code: "bad_input" });
        const aptNum = recordId("apt_num", a.apt_num);
        await od.request("PUT", `/appointments/${aptNum}`, { body });
        const after = await verifyAppt(aptNum, body);
        return out(after, {
          verified: "Read back from Open Dental after saving.",
          note: "Open Dental keeps the old date on the arrived/seated/dismissed placeholder times after a move; that is cosmetic.",
        });
      },
    },
    {
      name: "od_add_appointment_note",
      annotations: WRITE,
      description: "CHANGE. Append text to an appointment's note. Confirm the text with the user first.",
      inputSchema: obj({ apt_num: int("AptNum"), note: str("Text to append.") }, ["apt_num", "note"]),
      run: async (a) => {
        needWrites();
        const aptNum = recordId("apt_num", a.apt_num);
        const text = String(a.note || "");
        if (!text.trim()) throw new ODError("note is required.", { code: "bad_input" });
        await od.request("PUT", `/appointments/${aptNum}/Note`, { body: { Note: text } });
        const after = await od.request("GET", `/appointments/${aptNum}`);
        if (!String((after && after.Note) || "").includes(text.trim())) {
          throw new ODError(`Open Dental accepted the note for appointment ${aptNum} but it isn't on the appointment. Treat this change as NOT made.`, { code: "not_applied" });
        }
        return out(after, { verified: "Read back from Open Dental after saving." });
      },
    },
    {
      name: "od_confirm_appointment",
      annotations: WRITE,
      description:
        "CHANGE. Set an appointment's confirmation status using a status name from the office's Appt Confirmed definitions (e.g. 'Confirmed', 'Left Msg'). Confirm with the user first.",
      inputSchema: obj({ apt_num: int("AptNum"), confirm_val: str("Confirmation status name.") }, ["apt_num", "confirm_val"]),
      run: async (a) => {
        needWrites();
        const aptNum = recordId("apt_num", a.apt_num);
        const val = String(a.confirm_val || "").trim();
        if (!val) throw new ODError("confirm_val is required.", { code: "bad_input" });
        const before = await od.request("GET", `/appointments/${aptNum}`);
        await od.request("PUT", `/appointments/${aptNum}/Confirm`, { body: { confirmVal: val } });
        const after = await od.request("GET", `/appointments/${aptNum}`);
        const label = String(after.confirmed ?? after.ConfirmedName ?? "").trim().toLowerCase();
        const changed = String(after.Confirmed) !== String(before.Confirmed);
        if (label ? label !== val.toLowerCase() : !changed) {
          throw new ODError(`Open Dental accepted the confirmation for appointment ${aptNum} but it still shows "${after.confirmed ?? after.Confirmed}". Treat this change as NOT made.`, { code: "not_applied" });
        }
        return out(after, { verified: "Read back from Open Dental after saving." });
      },
    },
    {
      name: "od_break_appointment",
      annotations: WRITE_DESTRUCTIVE,
      description:
        "CHANGE. Mark an appointment broken (no-show / late cancel), removing it from the schedule and optionally adding it to the Unscheduled List. break_type 'Missed' adds the office's missed-appointment procedure (D9986) and 'Cancelled' the short-notice cancellation procedure (D9987), if the office has a broken appointment procedure set in Appts Preferences. Open Dental's API never posts the broken-appointment adjustment; tell the user to add it in Open Dental if the office uses one. State exactly which appointment and get a clear yes first.",
      inputSchema: obj(
        {
          apt_num: int("AptNum"),
          send_to_unscheduled_list: bool("Default true."),
          break_type: { type: "string", enum: ["Missed", "Cancelled"], description: "Optional: also add the D9986 (Missed) or D9987 (Cancelled) procedure." },
        },
        ["apt_num"]
      ),
      run: async (a) => {
        needWrites();
        const aptNum = recordId("apt_num", a.apt_num);
        const send = a.send_to_unscheduled_list ?? true;
        const body = { sendToUnscheduledList: send ? "true" : "false" };
        if (a.break_type) {
          if (!["Missed", "Cancelled"].includes(a.break_type)) throw new ODError("break_type must be Missed or Cancelled.", { code: "bad_input" });
          body.breakType = a.break_type;
        }
        const before = await od.request("GET", `/appointments/${aptNum}`);
        if (String(before.AptStatus) !== "Scheduled" && Number(before.AptStatus) !== 1) {
          throw new ODError(`Appointment ${aptNum} is ${before.AptStatus}; only Scheduled appointments can be broken. Nothing was changed.`, { code: "bad_input" });
        }
        await od.request("PUT", `/appointments/${aptNum}/Break`, { body });
        const after = await od.request("GET", `/appointments/${aptNum}`);
        const status = String(after.AptStatus);
        const ok = ["Broken", "UnschedList", "5", "3"].includes(status) || (!send && a.break_type && status === "Scheduled");
        if (!ok) throw new ODError(`Open Dental accepted the break for appointment ${aptNum} but it still shows ${status}. Treat this change as NOT made.`, { code: "not_applied" });
        return out(after, {
          verified: "Read back from Open Dental after saving.",
          reminder: a.break_type
            ? "The broken-appointment procedure was requested; Open Dental adds it only if set up in Appts Preferences. The API never posts the broken-appointment adjustment."
            : "Open Dental added its automatic commlog (if turned on) but not the office's broken-appointment procedure or adjustment; add those in Open Dental if the office uses them.",
        });
      },
    },
  ];
}

module.exports = { buildTools };
