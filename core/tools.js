"use strict";
/**
 * MCP tool definitions for Claude, built on the shared Open Dental client.
 * Each tool: { name, description, inputSchema, annotations, run(args) }.
 */

const { ODError, redact, checkDate, checkDateTime, checkPattern, recordId } = require("./odclient");
const { buildReport, describeReports } = require("./reports");

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

/**
 * @param {ReturnType<import('./odclient').createClient>} od
 * @param {{allowWrites: boolean}} opts
 */
function buildTools(od, { allowWrites = false } = {}) {
  const needWrites = () => {
    if (!allowWrites) {
      throw new ODError(
        'Changes are turned off for this connection. Turn on "Allow changes" in the Open Dental extension settings to book, move or confirm appointments and add notes.',
        { code: "forbidden" }
      );
    }
  };

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
          mode: od.isCloud ? "cloud (paced at about 1 request/second)" : "local network",
          writes_enabled: allowWrites,
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
        "Find open schedule slots (honoring provider schedules across operatories). Dates yyyy-MM-dd inclusive. length_minutes drops shorter slots.",
      inputSchema: obj(
        {
          date_start: str("yyyy-MM-dd"),
          date_end: str("yyyy-MM-dd, inclusive. Omit for one day."),
          prov_num: int("Provider ProvNum."),
          op_num: int("OperatoryNum."),
          length_minutes: int("Minimum slot length in minutes."),
          clinic_num: int("Optional ClinicNum filter."),
        },
        ["date_start"]
      ),
      run: async (a) => {
        checkDate("date_start", a.date_start, { required: true });
        checkDate("date_end", a.date_end);
        return outPage(
          await od.getAll("/appointments/Slots", {
            ...dateParams(a.date_start, a.date_end),
            ProvNum: recordId("prov_num", a.prov_num, { required: false }),
            OpNum: recordId("op_num", a.op_num, { required: false }),
            lengthMinutes: a.length_minutes,
            ClinicNum: recordId("clinic_num", a.clinic_num, { required: false }),
          })
        );
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
      run: async (a) => outPage(await od.shortQuery(buildReport(a.name, a.params || {}))),
    },
    {
      name: "od_run_query",
      annotations: READ,
      description:
        "Run a custom read-only SQL query against the Open Dental database (Open Dental also screens it as read-only and records it in the audit trail). Use only when no built-in report fits. Select only needed columns; never select SSN.",
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
        return out(await od.request("POST", "/commlogs", { body }));
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
        return out(await od.request("POST", "/appointments", { body }));
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
        return out(await od.request("PUT", `/appointments/${recordId("apt_num", a.apt_num)}`, { body }));
      },
    },
    {
      name: "od_add_appointment_note",
      annotations: WRITE,
      description: "CHANGE. Append text to an appointment's note. Confirm the text with the user first.",
      inputSchema: obj({ apt_num: int("AptNum"), note: str("Text to append.") }, ["apt_num", "note"]),
      run: async (a) => {
        needWrites();
        return out(await od.request("PUT", `/appointments/${recordId("apt_num", a.apt_num)}/Note`, { body: { Note: String(a.note || "") } }));
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
        return out(
          await od.request("PUT", `/appointments/${recordId("apt_num", a.apt_num)}/Confirm`, { body: { confirmVal: String(a.confirm_val || "") } })
        );
      },
    },
    {
      name: "od_break_appointment",
      annotations: WRITE_DESTRUCTIVE,
      description:
        "CHANGE. Mark an appointment broken (no-show / late cancel), removing it from the schedule and optionally adding it to the Unscheduled List. State exactly which appointment and get a clear yes first.",
      inputSchema: obj({ apt_num: int("AptNum"), send_to_unscheduled_list: bool("Default true.") }, ["apt_num"]),
      run: async (a) => {
        needWrites();
        const send = a.send_to_unscheduled_list ?? true;
        return out(
          await od.request("PUT", `/appointments/${recordId("apt_num", a.apt_num)}/Break`, {
            body: { sendToUnscheduledList: send ? "true" : "false" },
          })
        );
      },
    },
  ];
}

module.exports = { buildTools };
