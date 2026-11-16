"use strict";
/**
 * Clinical tools: chart notes and treatment planning.
 *
 * Reading is always available. Every change requires the separate
 * "Allow chart changes" setting, and is marked so Claude asks first.
 *
 * Safety rules built in:
 *  - Claude never signs anything. Notes are written unsigned; the dentist signs in Open Dental.
 *  - Notes are only ever added to (appended), never overwritten. Open Dental keeps
 *    every earlier version in the Chart's Audit tab.
 *  - Group notes only cover completed procedures that belong to the named patient.
 *  - Only treatment-planned (TP) procedures can be changed or removed.
 *  - Treatment-plan changes are checked against the named patient.
 */

const { ODError, redact, checkDate, recordId } = require("./odclient");

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const WRITE_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const bool = (description) => ({ type: "boolean", description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const intList = (description) => ({ type: "array", items: { type: "integer" }, minItems: 1, maxItems: 50, description });

function out(data, extra = {}) {
  const payload = { results: redact(data) };
  if (Array.isArray(data)) payload.count = data.length;
  return { ...payload, ...extra };
}
const outPage = ({ rows, truncated }) =>
  out(rows, truncated ? { truncated: "Row limit reached; narrow the filters to see the rest." } : {});

const PROC_STATUS = ["TP", "C", "EC", "EO", "R", "D", "Cn", "TPi"];
const COMPLETED = new Set(["C", "EC"]);
const PLANNED = new Set(["TP", "TPi"]);

// Open Dental reports ProcStatus as text ("TP") or, in some versions, a number.
const STATUS_BY_NUMBER = { 1: "TP", 2: "C", 3: "EC", 4: "EO", 5: "R", 6: "D", 7: "Cn", 8: "TPi" };
function statusOf(proc) {
  const s = proc && proc.ProcStatus;
  return typeof s === "number" ? STATUS_BY_NUMBER[s] : String(s || "");
}

function today() {
  // Local calendar date (the office's), yyyy-MM-dd.
  return new Date().toLocaleDateString("en-CA");
}

function checkText(name, v, max = 20000) {
  if (typeof v !== "string" || !v.trim()) throw new ODError(`${name} is required.`, { code: "bad_input" });
  if (v.length > max) throw new ODError(`${name} is too long (over ${max} characters).`, { code: "bad_input" });
  return v;
}

function checkCode(v) {
  if (typeof v !== "string" || !/^[A-Za-z0-9.\-]{1,15}$/.test(v.trim())) {
    throw new ODError("proc_code must be a procedure code such as D2393.", { code: "bad_input" });
  }
  return v.trim();
}

function checkTooth(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const t = String(v).trim().toUpperCase();
  // Universal numbering 1-32, primary A-T, supernumerary 51-82 / AS-TS.
  if (!/^([1-9]|[12][0-9]|3[0-2]|5[1-9]|[67][0-9]|8[0-2]|[A-T]|[A-T]S)$/.test(t)) {
    throw new ODError(`"${v}" is not a tooth number (use 1-32 or A-T).`, { code: "bad_input" });
  }
  return t;
}

function checkSurf(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim().toUpperCase();
  if (!/^[MODBLIFV5]{1,6}$/.test(s)) throw new ODError(`"${v}" is not a surface list (letters M, O, D, B, L, I, F, V, 5).`, { code: "bad_input" });
  return s;
}

function checkToothRange(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const list = (Array.isArray(v) ? v : String(v).split(",")).map((t) => checkTooth(String(t).trim()));
  if (!list.length || list.length > 32) throw new ODError("tooth_range must list 1-32 teeth.", { code: "bad_input" });
  return list.join(",");
}

function checkName(name, v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 100) throw new ODError(`${name} must be a short name.`, { code: "bad_input" });
  return v.trim();
}

// Primary teeth sit in the positions of permanent teeth 4-13 (A-J) and 20-29 (K-T).
// Open Dental marks a position as primary with a "Primary" tooth initial on the permanent number.
const PRIMARY_LETTERS = "ABCDEFGHIJKLMNOPQRST".split("");
const PRIMARY_POSITIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
function permanentPosition(tooth) {
  const t = String(tooth).trim().toUpperCase();
  const i = PRIMARY_LETTERS.indexOf(t);
  if (i >= 0) return String(PRIMARY_POSITIONS[i]);
  if (/^\d+$/.test(t) && PRIMARY_POSITIONS.includes(Number(t))) return t;
  throw new ODError(`Tooth ${tooth} has no primary tooth. Primary teeth are A-T, in the positions of permanent teeth 4-13 and 20-29.`, { code: "bad_input" });
}
function primaryLetter(perm) {
  const i = PRIMARY_POSITIONS.indexOf(Number(perm));
  return i >= 0 ? PRIMARY_LETTERS[i] : null;
}

// Statuses a procedure can be charted with or changed to here (Open Dental API codes).
const CHART_STATUS = {
  complete: "C",
  existing_current_provider: "EC",
  existing_other_provider: "EO",
  referred: "R",
  condition: "Cn",
  treatment_planned: "TP",
};
const STATUS_NAMES = { TP: "treatment planned", TPi: "treatment planned (inactive)", C: "complete", EC: "existing (current provider)", EO: "existing (other provider)", R: "referred out", Cn: "condition", D: "deleted" };

/**
 * @param {ReturnType<import('./odclient').createClient>} od
 * @param {{allowChartChanges: boolean}} opts
 */
function buildClinicalTools(od, { allowChartChanges = false } = {}) {
  const needChart = () => {
    if (!allowChartChanges) {
      throw new ODError(
        'Chart changes are turned off for this connection. Turn on "Allow chart changes" in the Open Dental extension settings to add notes or treatment-planned procedures.',
        { code: "forbidden" }
      );
    }
  };

  // Small per-session caches for slow-changing lists.
  let codeCache = null;
  const defCache = new Map();

  async function allCodes() {
    if (!codeCache) {
      const { rows } = await od.getAll("/procedurecodes", {}, { allRows: true });
      codeCache = rows;
    }
    return codeCache;
  }

  async function definitions(category) {
    if (!defCache.has(category)) {
      const rows = await od.request("GET", "/definitions", { params: { Category: category } });
      defCache.set(category, Array.isArray(rows) ? rows : []);
    }
    return defCache.get(category);
  }

  async function priorityDefNum(name) {
    if (!name) return undefined;
    const defs = await definitions(20);
    const hit = defs.find((d) => String(d.ItemName).toLowerCase() === name.toLowerCase());
    if (!hit) {
      throw new ODError(
        `No treatment priority named "${name}". Office priorities: ${defs.map((d) => d.ItemName).join(", ") || "none set up"}.`,
        { code: "bad_input" }
      );
    }
    return hit.DefNum;
  }

  /** Priority name -> DefNum; "none" -> 0 (clears the priority). */
  async function resolvePriority(name) {
    if (!name) return undefined;
    if (name.toLowerCase() === "none") return 0;
    return priorityDefNum(name);
  }

  async function dxDefNum(name) {
    if (!name) return undefined;
    const defs = await definitions(16);
    const hit = defs.find((d) => String(d.ItemName).toLowerCase() === name.toLowerCase());
    if (!hit) {
      throw new ODError(`No diagnosis named "${name}". Office diagnoses: ${defs.map((d) => d.ItemName).join(", ") || "none set up"}.`, { code: "bad_input" });
    }
    return hit.DefNum;
  }

  const norm = (v) => String(v ?? "").trim().toUpperCase().replace(/\s+/g, "");
  function procField(p, key) {
    if (key === "ProcStatus") return statusOf(p);
    if (key === "procCode") return p.procCode ?? p.ProcCode;
    if (key === "ProcDate") return String(p.ProcDate || "").slice(0, 10);
    return p[key];
  }

  /**
   * Read a procedure back and confirm every requested field took effect.
   * Open Dental can answer 200 without applying a field; that must never look like success.
   */
  async function verifyProc(procNum, expected) {
    const p = await od.request("GET", `/procedurelogs/${procNum}`);
    const bad = [];
    for (const [k, want] of Object.entries(expected)) {
      const got = procField(p, k);
      const ok = typeof want === "number" ? Number(got) === want : norm(got) === norm(want);
      if (!ok) bad.push(`${k} should be ${want} but Open Dental still has ${got === undefined || got === "" ? "nothing" : got}`);
    }
    if (bad.length) {
      throw new ODError(`Open Dental accepted the request for procedure ${procNum} but did not apply it: ${bad.join("; ")}. Treat this change as NOT made.`, { code: "not_applied" });
    }
    return p;
  }

  /** Fields sent in a procedure body that can be read back. */
  function expectedFrom(body) {
    const keys = ["ProcStatus", "procCode", "ToothNum", "Surf", "ToothRange", "Priority", "Dx", "ProvNum", "ProcDate", "AptNum"];
    return Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  }

  async function planAttaches(planNum) {
    const rows = await od.request("GET", "/treatplanattaches", { params: { TreatPlanNum: planNum } });
    return Array.isArray(rows) ? rows : [];
  }

  /** Set a plan item's priority and confirm it. */
  async function setAttachPriority(planNum, attach, defNum) {
    await od.request("PUT", `/treatplanattaches/${recordId("TreatPlanAttachNum", attach.TreatPlanAttachNum)}`, { body: { Priority: defNum } });
    const after = (await planAttaches(planNum)).find((x) => Number(x.TreatPlanAttachNum) === Number(attach.TreatPlanAttachNum));
    if (!after || Number(after.Priority) !== defNum) {
      throw new ODError(`Open Dental did not apply priority ${defNum} to procedure ${attach.ProcNum} on plan ${planNum}. Treat this change as NOT made.`, { code: "not_applied" });
    }
  }

  /** Keep a procedure's plan-item priorities in step with its own priority (Active and Inactive plans). */
  async function syncPlanItems(patNum, procNum, defNum) {
    const plans = await od.request("GET", "/treatplans", { params: { PatNum: patNum } });
    const updated = [];
    for (const plan of Array.isArray(plans) ? plans : []) {
      if (plan.TPStatus === "Saved") continue;
      const planNum = Number(plan.TreatPlanNum);
      for (const at of (await planAttaches(planNum)).filter((x) => Number(x.ProcNum) === procNum)) {
        if (Number(at.Priority) === defNum) continue;
        await setAttachPriority(planNum, at, defNum);
        updated.push(planNum);
      }
    }
    return updated;
  }

  async function getProc(procNum, patNum) {
    const p = await od.request("GET", `/procedurelogs/${procNum}`);
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new ODError(`Procedure ${procNum} was not found.`, { code: "not_found" });
    if (patNum !== undefined && Number(p.PatNum) !== patNum) {
      throw new ODError(`Procedure ${procNum} belongs to a different patient (PatNum ${p.PatNum}), not ${patNum}. Nothing was changed.`, { code: "forbidden" });
    }
    return p;
  }

  async function getPlan(treatPlanNum, patNum) {
    const plans = await od.request("GET", "/treatplans", { params: { PatNum: patNum } });
    const plan = Array.isArray(plans) ? plans.find((t) => Number(t.TreatPlanNum) === treatPlanNum) : null;
    if (!plan) throw new ODError(`Treatment plan ${treatPlanNum} was not found for patient ${patNum}. Nothing was changed.`, { code: "not_found" });
    return plan;
  }

  return [
    // -------------------------------------------------------------- reads
    {
      name: "od_get_progress_notes",
      annotations: READ,
      description:
        "Read a patient's chart progress notes as the Chart module shows them: procedures, notes, group notes, commlogs, with date, tooth, surface, status, provider and whether each note is signed. Newest first.",
      inputSchema: obj({ pat_num: int("PatNum"), max_rows: int("Maximum rows. Default 100.") }, ["pat_num"]),
      run: async (a) => outPage(await od.getAll(`/chartmodules/${recordId("pat_num", a.pat_num)}/ProgNotes`, {}, { limit: a.max_rows || 100 })),
    },
    {
      name: "od_get_procedures",
      annotations: READ,
      description:
        "List a patient's procedures (ProcNum, code, tooth, surface, status, date, provider, fee). Filter by status (TP planned, C complete, EC/EO existing, R referred, Cn condition) and/or date. Use status C and date today to find today's completed procedures for a group note.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          status: { type: "string", enum: PROC_STATUS, description: "Procedure status filter." },
          date: str("Procedure date yyyy-MM-dd."),
          max_rows: int("Maximum rows. Default 200."),
        },
        ["pat_num"]
      ),
      run: async (a) => {
        checkDate("date", a.date);
        return outPage(
          await od.getAll(
            "/procedurelogs",
            { PatNum: recordId("pat_num", a.pat_num), ProcStatus: a.status, ProcDate: a.date },
            { limit: a.max_rows || 200 }
          )
        );
      },
    },
    {
      name: "od_get_procedure_notes",
      annotations: READ,
      description: "Read procedure notes for a patient, or one procedure, newest first, including whether each is signed.",
      inputSchema: obj({ pat_num: int("PatNum"), proc_num: int("Optional ProcNum.") }, ["pat_num"]),
      run: async (a) =>
        out(
          await od.request("GET", "/procnotes", {
            params: { PatNum: recordId("pat_num", a.pat_num), ProcNum: recordId("proc_num", a.proc_num, { required: false }) },
          })
        ),
    },
    {
      name: "od_get_medical_summary",
      annotations: READ,
      description:
        "Read the patient info panel from the Chart: age, premedication, problems, medical urgent note, medical summary, medications, allergies, insurance, restrictions. Check this before treatment planning.",
      inputSchema: obj({ pat_num: int("PatNum") }, ["pat_num"]),
      run: async (a) => out(await od.request("GET", `/chartmodules/${recordId("pat_num", a.pat_num)}/PatientInfo`)),
    },
    {
      name: "od_get_treatment_plans",
      annotations: READ,
      description:
        "List a patient's treatment plans (Active, Inactive, Saved) and, by default, the procedures on each with their priority.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          status: { type: "string", enum: ["Active", "Inactive", "Saved"], description: "Optional status filter." },
          include_items: bool("Include the procedures on each plan. Default true."),
        },
        ["pat_num"]
      ),
      run: async (a) => {
        const plans = await od.request("GET", "/treatplans", { params: { PatNum: recordId("pat_num", a.pat_num), TPStatus: a.status } });
        if (!Array.isArray(plans) || a.include_items === false) return out(plans);
        const result = [];
        for (const p of plans.slice(0, 20)) {
          const path = p.TPStatus === "Saved" ? "/proctps" : "/treatplanattaches";
          const items = await od.request("GET", path, { params: { TreatPlanNum: p.TreatPlanNum } }).catch((e) => ({ error: e.message }));
          result.push({ ...p, items });
        }
        return out(result, plans.length > 20 ? { truncated: "Only the first 20 plans include items." } : {});
      },
    },
    {
      name: "od_lookup_procedure_code",
      annotations: READ,
      description:
        "Look up the office's procedure codes by code (e.g. D2740) or words in the description (e.g. 'crown ceramic'). Returns code, description, treatment area (Tooth, Surf, Quad, Mouth, ToothRange...) and time. Use before planning to confirm the exact code and what tooth/surface it needs.",
      inputSchema: obj({ query: str("Code or description words."), max_rows: int("Maximum matches. Default 25.") }, ["query"]),
      run: async (a) => {
        const q = checkText("query", a.query, 100).trim().toLowerCase();
        const words = q.split(/\s+/);
        const codes = await allCodes();
        const keep = ["CodeNum", "ProcCode", "Descript", "AbbrDesc", "LaymanTerm", "TreatArea", "AreaAlsoToothRange", "ProcTime", "procCat", "IsHygiene", "IsProsth"];
        const scored = [];
        for (const c of codes) {
          const code = String(c.ProcCode || "").toLowerCase();
          const text = `${c.Descript || ""} ${c.AbbrDesc || ""} ${c.LaymanTerm || ""}`.toLowerCase();
          let score = 0;
          if (code === q) score = 100;
          else if (code.startsWith(q)) score = 50;
          else if (words.every((w) => text.includes(w) || code.includes(w))) score = 10;
          if (score) scored.push([score, c]);
        }
        scored.sort((x, y) => y[0] - x[0] || String(x[1].ProcCode).localeCompare(String(y[1].ProcCode)));
        const rows = scored.slice(0, Math.min(a.max_rows || 25, 200)).map(([, c]) => Object.fromEntries(keep.filter((k) => k in c).map((k) => [k, c[k]])));
        return out(rows, rows.length ? {} : { note: "No matching codes. Try fewer or different words." });
      },
    },
    {
      name: "od_list_treatment_priorities",
      annotations: READ,
      description: "List the office's treatment priority names (e.g. 1, 2, 3, Urgent) and diagnosis names used when planning procedures.",
      inputSchema: obj({}),
      run: async () => {
        const pri = await definitions(20);
        const dx = await definitions(16);
        return out({
          priorities: pri.map((d) => ({ name: d.ItemName, DefNum: d.DefNum })),
          diagnoses: dx.map((d) => ({ name: d.ItemName, DefNum: d.DefNum })),
        });
      },
    },

    // -------------------------------------------------------------- chart notes
    {
      name: "od_add_group_note",
      annotations: WRITE,
      description:
        "CHART CHANGE. Write the visit's clinical note as a group note across the patient's completed procedures for the day (the office's standard way). Find them first with od_get_procedures (status C, date). The note is saved UNSIGNED; the dentist signs it in Open Dental. Show the user the procedures and the exact note text and get a clear yes before calling.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          proc_nums: intList("ProcNums of the completed procedures the note covers (usually all of today's)."),
          note: str("The full note text."),
          prov_num: int("Provider ProvNum for the note. Default: the patient's primary provider."),
        },
        ["pat_num", "proc_nums", "note"]
      ),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        const note = checkText("note", a.note);
        if (!Array.isArray(a.proc_nums) || !a.proc_nums.length || a.proc_nums.length > 50) {
          throw new ODError("proc_nums must list 1-50 procedures.", { code: "bad_input" });
        }
        const nums = [...new Set(a.proc_nums.map((n) => recordId("proc_nums", n)))];
        for (const n of nums) {
          const p = await getProc(n, patNum);
          if (!COMPLETED.has(statusOf(p))) {
            throw new ODError(`Procedure ${n} (${p.procCode || p.ProcCode || "?"}) is not completed (status ${statusOf(p)}); group notes cover completed procedures. Nothing was changed.`, { code: "bad_input" });
          }
        }
        const body = { PatNum: patNum, Note: note, ProcNums: nums, isSigned: "false" };
        if (a.prov_num != null) body.ProvNum = recordId("prov_num", a.prov_num);
        return out(await od.request("POST", "/procedurelogs/GroupNote", { body }), { signed: false });
      },
    },
    {
      name: "od_append_procedure_note",
      annotations: WRITE,
      description:
        "CHART CHANGE. Add text to the end of the note on one procedure or an existing group note (use the group note's ProcNum). Earlier text is kept and Open Dental archives every version. Use for addenda and corrections (e.g. 'Addendum: ...'). Saved UNSIGNED, which removes any signature on that note until the dentist signs again. Show the exact text and get a clear yes first.",
      inputSchema: obj({ pat_num: int("PatNum"), proc_num: int("ProcNum (or the group note's ProcNum)."), note: str("Text to add.") }, ["pat_num", "proc_num", "note"]),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        const procNum = recordId("proc_num", a.proc_num);
        const note = checkText("note", a.note);
        await getProc(procNum, patNum);
        return out(
          await od.request("POST", "/procnotes", { body: { PatNum: patNum, ProcNum: procNum, Note: note, doAppendNote: "true", isSigned: "false" } }),
          { signed: false }
        );
      },
    },

    // -------------------------------------------------------------- treatment planning
    {
      name: "od_plan_procedure",
      annotations: WRITE,
      description:
        "CHART CHANGE. Add a treatment-planned (TP) procedure to the patient's chart, e.g. D2740 on tooth 30. Open Dental sets the fee from the patient's fee schedule and insurance. Confirm the code with od_lookup_procedure_code (its TreatArea says whether tooth, surface or range is needed). Record only what the dentist decided. Optionally add it to a treatment plan. Confirm patient, code, tooth/surface and priority with the user first.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          proc_code: str("Procedure code, e.g. D2740."),
          tooth: str("Tooth number 1-32 or A-T, when the code needs one."),
          surfaces: str("Surfaces, e.g. MOD, when the code needs them."),
          tooth_range: str("Comma-separated teeth for range codes (bridges, partials), e.g. '3,4,5'."),
          priority: str("Treatment priority name from od_list_treatment_priorities."),
          diagnosis: str("Diagnosis name from od_list_treatment_priorities."),
          prov_num: int("Provider ProvNum. Default: the patient's provider."),
          note: str("Optional procedure note (saved unsigned)."),
          treat_plan_num: int("Optional: also add it to this treatment plan."),
        },
        ["pat_num", "proc_code"]
      ),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        const body = { PatNum: patNum, ProcDate: today(), ProcStatus: "TP", procCode: checkCode(a.proc_code) };
        const tooth = checkTooth(a.tooth);
        const surf = checkSurf(a.surfaces);
        const range = checkToothRange(a.tooth_range);
        if (tooth) body.ToothNum = tooth;
        if (surf) body.Surf = surf;
        if (range) body.ToothRange = range;
        const pri = checkName("priority", a.priority);
        const priNum = await resolvePriority(pri);
        const dxNum = await dxDefNum(checkName("diagnosis", a.diagnosis));
        if (priNum) body.Priority = priNum;
        if (dxNum) body.Dx = dxNum;
        if (a.prov_num != null) body.ProvNum = recordId("prov_num", a.prov_num);
        const planNum = recordId("treat_plan_num", a.treat_plan_num, { required: false });
        let plan;
        if (planNum) {
          plan = await getPlan(planNum, patNum);
          if (plan.TPStatus === "Saved") throw new ODError("Saved treatment plans can't take new procedures; use an Active or Inactive plan.", { code: "bad_input" });
        }
        const note = a.note ? checkText("note", a.note) : null;

        const created = await od.request("POST", "/procedurelogs", { body });
        const procNum = Number(created && created.ProcNum);
        if (!procNum) throw new ODError("Open Dental did not return the new procedure's number; check the chart before retrying.", { code: "not_applied" });
        const { PatNum, ProcDate, ...check } = body;
        const result = { procedure: await verifyProc(procNum, expectedFrom(check)) };
        if (note) {
          result.note = await od.request("POST", "/procnotes", { body: { PatNum: patNum, ProcNum: procNum, Note: note, isSigned: "false" } });
        }
        if (plan) {
          const attach = { TreatPlanNum: planNum, ProcNum: procNum };
          if (priNum) attach.Priority = priNum;
          result.treatment_plan = await od.request("POST", "/treatplanattaches", { body: attach });
        }
        return out(result, { verified: "Read back from Open Dental after saving." });
      },
    },
    {
      name: "od_update_planned_procedure",
      annotations: WRITE,
      description:
        "CHART CHANGE. Change a treatment-planned (TP) procedure: code, tooth, surfaces, range, priority, diagnosis or provider. Completed procedures can't be changed here. Confirm the before and after with the user first.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          proc_num: int("ProcNum"),
          proc_code: str("New code (same treatment area as the old one)."),
          tooth: str("New tooth."),
          surfaces: str("New surfaces."),
          tooth_range: str("New tooth range."),
          priority: str("New priority name (from od_list_treatment_priorities), or 'none' to clear it."),
          diagnosis: str("New diagnosis name."),
          prov_num: int("New provider ProvNum."),
          sync_plan_items: bool("Also set the same priority on this procedure's treatment-plan items. Default true."),
        },
        ["pat_num", "proc_num"]
      ),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        const procNum = recordId("proc_num", a.proc_num);
        const p = await getProc(procNum, patNum);
        if (!PLANNED.has(statusOf(p))) {
          throw new ODError(`Procedure ${procNum} is not treatment-planned (status ${statusOf(p)}). Only planned procedures can be changed here.`, { code: "forbidden" });
        }
        const body = {};
        if (a.proc_code) body.procCode = checkCode(a.proc_code);
        const tooth = checkTooth(a.tooth);
        const surf = checkSurf(a.surfaces);
        const range = checkToothRange(a.tooth_range);
        if (tooth) body.ToothNum = tooth;
        if (surf) body.Surf = surf;
        if (range) body.ToothRange = range;
        const priNum = await resolvePriority(checkName("priority", a.priority));
        const dxNum = await dxDefNum(checkName("diagnosis", a.diagnosis));
        if (priNum !== undefined) body.Priority = priNum;
        if (dxNum) body.Dx = dxNum;
        if (a.prov_num != null) body.ProvNum = recordId("prov_num", a.prov_num);
        if (!Object.keys(body).length) throw new ODError("Nothing to change.", { code: "bad_input" });
        await od.request("PUT", `/procedurelogs/${procNum}`, { body });
        const after = await verifyProc(procNum, expectedFrom(body));
        const extra = { verified: "Read back from Open Dental after saving." };
        if (priNum !== undefined && a.sync_plan_items !== false) {
          const plans = await syncPlanItems(patNum, procNum, priNum);
          if (plans.length) extra.plan_items_updated = plans;
        }
        return out(after, extra);
      },
    },
    {
      name: "od_remove_planned_procedure",
      annotations: WRITE_DESTRUCTIVE,
      description:
        "CHART CHANGE. Delete a treatment-planned (TP) procedure the dentist no longer wants. Only planned procedures not attached to claims, payments or adjustments can be removed (Open Dental enforces this too). State exactly which procedure and get a clear yes first.",
      inputSchema: obj({ pat_num: int("PatNum"), proc_num: int("ProcNum") }, ["pat_num", "proc_num"]),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        const procNum = recordId("proc_num", a.proc_num);
        const p = await getProc(procNum, patNum);
        if (!PLANNED.has(statusOf(p))) {
          throw new ODError(`Procedure ${procNum} is not treatment-planned (status ${statusOf(p)}); only planned procedures can be removed. Nothing was changed.`, { code: "forbidden" });
        }
        return out(await od.request("DELETE", `/procedurelogs/${procNum}`));
      },
    },
    {
      name: "od_create_treatment_plan",
      annotations: WRITE,
      description:
        "CHART CHANGE. Create a new treatment plan (a named group such as 'Phase 1 - Urgent' or 'Option B - Implant') for a patient. It starts Inactive; add procedures with od_add_to_treatment_plan or od_plan_procedure. Confirm the name with the user first.",
      inputSchema: obj({ pat_num: int("PatNum"), heading: str("Plan name."), note: str("Optional plan note.") }, ["pat_num", "heading"]),
      run: async (a) => {
        needChart();
        const body = { PatNum: recordId("pat_num", a.pat_num), Heading: checkText("heading", a.heading, 200) };
        if (a.note) body.Note = checkText("note", a.note, 5000);
        return out(await od.request("POST", "/treatplans", { body }));
      },
    },
    {
      name: "od_add_to_treatment_plan",
      annotations: WRITE,
      description:
        "CHART CHANGE. Group existing treatment-planned procedures into a treatment plan, optionally with a priority. Procedures already on the plan get the new priority instead. With a priority, the procedures' own priority is set to match (sync_procedures, default true). To give different priorities to different items, use od_set_treatment_plan_priorities. Confirm the plan and procedures with the user first.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          treat_plan_num: int("TreatPlanNum"),
          proc_nums: intList("ProcNums of planned procedures to add."),
          priority: str("Optional priority name for these procedures on the plan, or 'none'."),
          sync_procedures: bool("Also set the procedures' own priority to match. Default true."),
        },
        ["pat_num", "treat_plan_num", "proc_nums"]
      ),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        const planNum = recordId("treat_plan_num", a.treat_plan_num);
        const plan = await getPlan(planNum, patNum);
        if (plan.TPStatus === "Saved") throw new ODError("Saved treatment plans can't take new procedures; use an Active or Inactive plan.", { code: "bad_input" });
        if (!Array.isArray(a.proc_nums) || !a.proc_nums.length || a.proc_nums.length > 50) {
          throw new ODError("proc_nums must list 1-50 procedures.", { code: "bad_input" });
        }
        const nums = [...new Set(a.proc_nums.map((n) => recordId("proc_nums", n)))];
        for (const n of nums) {
          const p = await getProc(n, patNum);
          if (!PLANNED.has(statusOf(p))) {
            throw new ODError(`Procedure ${n} is not treatment-planned (status ${statusOf(p)}). Nothing was changed.`, { code: "bad_input" });
          }
        }
        const defNum = await resolvePriority(checkName("priority", a.priority));
        const existing = await planAttaches(planNum);
        const results = [];
        for (const n of nums) {
          const at = existing.find((x) => Number(x.ProcNum) === n);
          if (at) {
            if (defNum === undefined || Number(at.Priority) === defNum) {
              results.push({ ProcNum: n, result: "already on this plan" });
            } else {
              await setAttachPriority(planNum, at, defNum);
              results.push({ ProcNum: n, result: "already on this plan; priority updated" });
            }
          } else {
            const body = { TreatPlanNum: planNum, ProcNum: n };
            if (defNum) body.Priority = defNum;
            await od.request("POST", "/treatplanattaches", { body });
            results.push({ ProcNum: n, result: "added" });
          }
          if (defNum !== undefined && a.sync_procedures !== false) {
            await od.request("PUT", `/procedurelogs/${n}`, { body: { Priority: defNum } });
            await verifyProc(n, { Priority: defNum });
          }
        }
        // Read back: every procedure must now be on the plan with the requested priority.
        const after = await planAttaches(planNum);
        for (const n of nums) {
          const at = after.find((x) => Number(x.ProcNum) === n);
          if (!at || (defNum !== undefined && Number(at.Priority) !== defNum)) {
            throw new ODError(`Procedure ${n} is not on plan ${planNum}${defNum !== undefined ? ` with priority ${defNum}` : ""} after saving. Check the plan in Open Dental.`, { code: "not_applied" });
          }
        }
        return out(results, { verified: "Read back from Open Dental after saving." });
      },
    },
    {
      name: "od_set_treatment_plan_priorities",
      annotations: WRITE,
      description:
        "CHART CHANGE. Set the order of a treatment plan by giving groups of its procedures a priority, e.g. [{proc_nums:[crown #2, buildup #2], priority:'1'}, {proc_nums:[RCT #4], priority:'2'}]. Sets the plan items' priority (what orders the plan) and, by default, each procedure's own priority to match. Every procedure must already be on the plan. Checks everything before changing anything and reads every value back. Confirm the full ordering with the user first.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          treat_plan_num: int("TreatPlanNum"),
          items: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            items: obj({ proc_nums: intList("ProcNums in this group."), priority: str("Priority name, or 'none'.") }, ["proc_nums", "priority"]),
            description: "Groups of procedures and the priority for each group.",
          },
          sync_procedures: bool("Also set each procedure's own priority. Default true."),
        },
        ["pat_num", "treat_plan_num", "items"]
      ),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        const planNum = recordId("treat_plan_num", a.treat_plan_num);
        const plan = await getPlan(planNum, patNum);
        if (plan.TPStatus === "Saved") throw new ODError("Saved (presented) plans are kept as they were; change the Active or Inactive plan instead.", { code: "forbidden" });
        if (!Array.isArray(a.items) || !a.items.length || a.items.length > 30) throw new ODError("items must list 1-30 groups.", { code: "bad_input" });
        // Validate everything first.
        const attaches = await planAttaches(planNum);
        const plan_ = [];
        const seen = new Set();
        for (const g of a.items) {
          const defNum = await resolvePriority(checkName("priority", g && g.priority));
          if (defNum === undefined) throw new ODError("Each group needs a priority.", { code: "bad_input" });
          if (!Array.isArray(g.proc_nums) || !g.proc_nums.length) throw new ODError("Each group needs proc_nums.", { code: "bad_input" });
          for (const raw of g.proc_nums) {
            const n = recordId("proc_nums", raw);
            if (seen.has(n)) throw new ODError(`Procedure ${n} is listed in more than one group.`, { code: "bad_input" });
            seen.add(n);
            await getProc(n, patNum);
            const at = attaches.find((x) => Number(x.ProcNum) === n);
            if (!at) throw new ODError(`Procedure ${n} is not on treatment plan ${planNum}; add it with od_add_to_treatment_plan first. Nothing was changed.`, { code: "bad_input" });
            plan_.push({ n, at, defNum, name: g.priority });
          }
        }
        const results = [];
        for (const { n, at, defNum, name } of plan_) {
          if (Number(at.Priority) !== defNum) await setAttachPriority(planNum, at, defNum);
          if (a.sync_procedures !== false) {
            await od.request("PUT", `/procedurelogs/${n}`, { body: { Priority: defNum } });
            await verifyProc(n, { Priority: defNum });
          }
          results.push({ ProcNum: n, priority: name, DefNum: defNum });
        }
        return out(results, { verified: "Plan items and procedures read back from Open Dental after saving." });
      },
    },
    {
      name: "od_update_treatment_plan",
      annotations: WRITE,
      description: "CHART CHANGE. Rename a treatment plan or change its note. Signatures are never touched. Confirm with the user first.",
      inputSchema: obj({ pat_num: int("PatNum"), treat_plan_num: int("TreatPlanNum"), heading: str("New name."), note: str("New plan note.") }, ["pat_num", "treat_plan_num"]),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        const planNum = recordId("treat_plan_num", a.treat_plan_num);
        const plan = await getPlan(planNum, patNum);
        if (plan.TPStatus === "Saved") throw new ODError("Saved (presented) plans are kept as they were; change the Active or Inactive plan instead.", { code: "forbidden" });
        const body = {};
        if (a.heading) body.Heading = checkText("heading", a.heading, 200);
        if (a.note) body.Note = checkText("note", a.note, 5000);
        if (!Object.keys(body).length) throw new ODError("Nothing to change.", { code: "bad_input" });
        return out(await od.request("PUT", `/treatplans/${planNum}`, { body }));
      },
    },

    // -------------------------------------------------------------- procedure status
    {
      name: "od_chart_procedure",
      annotations: WRITE,
      description:
        "CHART CHANGE. Chart a procedure with a status other than treatment planned: complete (work done today; POSTS THE FEE TO THE PATIENT'S ACCOUNT and counts as production), existing_current_provider / existing_other_provider (work already in the mouth, e.g. an old crown), referred (referred out), or condition (a finding such as a fracture or caries, using a condition code). For planned work use od_plan_procedure. Confirm patient, code, tooth/surfaces, status and date with the user first; for complete, also say a charge will post.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          proc_code: str("Procedure or condition code, e.g. D2740."),
          status: { type: "string", enum: ["complete", "existing_current_provider", "existing_other_provider", "referred", "condition"], description: "Status to chart." },
          tooth: str("Tooth 1-32 or A-T, when the code needs one."),
          surfaces: str("Surfaces, e.g. MOD."),
          tooth_range: str("Comma-separated teeth for range codes."),
          date: str("Procedure date yyyy-MM-dd. Default today."),
          diagnosis: str("Diagnosis name."),
          prov_num: int("Provider ProvNum."),
          apt_num: int("For complete: the patient's appointment the work was done in."),
          note: str("Optional procedure note (saved unsigned)."),
        },
        ["pat_num", "proc_code", "status"]
      ),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        const code = CHART_STATUS[a.status];
        if (!code || code === "TP") throw new ODError("status must be complete, existing_current_provider, existing_other_provider, referred or condition. Use od_plan_procedure for planned work.", { code: "bad_input" });
        checkDate("date", a.date);
        const body = { PatNum: patNum, ProcDate: a.date || today(), ProcStatus: code, procCode: checkCode(a.proc_code) };
        const tooth = checkTooth(a.tooth);
        const surf = checkSurf(a.surfaces);
        const range = checkToothRange(a.tooth_range);
        if (tooth) body.ToothNum = tooth;
        if (surf) body.Surf = surf;
        if (range) body.ToothRange = range;
        const dx = checkName("diagnosis", a.diagnosis);
        if (dx) body.dxName = dx;
        if (a.prov_num != null) body.ProvNum = recordId("prov_num", a.prov_num);
        if (a.apt_num != null) {
          if (code !== "C") throw new ODError("apt_num only applies to completed procedures.", { code: "bad_input" });
          const aptNum = recordId("apt_num", a.apt_num);
          const appt = await od.request("GET", `/appointments/${aptNum}`);
          if (!appt || Number(appt.PatNum) !== patNum) throw new ODError(`Appointment ${aptNum} belongs to a different patient. Nothing was changed.`, { code: "forbidden" });
          body.AptNum = aptNum;
        }
        const note = a.note ? checkText("note", a.note) : null;
        const dxNum = await dxDefNum(dx);
        if (dxNum) {
          delete body.dxName;
          body.Dx = dxNum;
        }
        const created = await od.request("POST", "/procedurelogs", { body });
        const procNum = Number(created && created.ProcNum);
        if (!procNum) throw new ODError("Open Dental did not return the new procedure's number; check the chart before retrying.", { code: "not_applied" });
        const { PatNum: _p, ...check } = body;
        const result = { procedure: await verifyProc(procNum, expectedFrom(check)), status: STATUS_NAMES[code] };
        if (procNum && note) result.note = await od.request("POST", "/procnotes", { body: { PatNum: patNum, ProcNum: procNum, Note: note, isSigned: "false" } });
        return out(result, code === "C" ? { charge: "Completed: the procedure fee posted to the patient's account." } : {});
      },
    },
    {
      name: "od_set_procedure_status",
      annotations: WRITE,
      description:
        "CHART CHANGE. Change an existing procedure's status: complete a treatment-planned procedure (POSTS THE FEE to the account; date defaults to today), or set it to existing (current or other provider), referred, condition, or back to treatment planned. Completed procedures are never changed here (they carry billing history; correct them in Open Dental). Confirm the procedure, the old and new status and the date first; for complete, also say a charge will post.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          proc_num: int("ProcNum"),
          status: { type: "string", enum: Object.keys(CHART_STATUS), description: "New status." },
          date: str("Procedure date yyyy-MM-dd. For complete, defaults to today."),
        },
        ["pat_num", "proc_num", "status"]
      ),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        const procNum = recordId("proc_num", a.proc_num);
        const code = CHART_STATUS[a.status];
        if (!code) throw new ODError(`status must be one of ${Object.keys(CHART_STATUS).join(", ")}.`, { code: "bad_input" });
        checkDate("date", a.date);
        const p = await getProc(procNum, patNum);
        const from = statusOf(p);
        if (from === "C") throw new ODError(`Procedure ${procNum} is already complete. Completed procedures carry billing history; change them in Open Dental. Nothing was changed.`, { code: "forbidden" });
        if (from === "D") throw new ODError(`Procedure ${procNum} is deleted. Nothing was changed.`, { code: "forbidden" });
        if (from === code) throw new ODError(`Procedure ${procNum} is already ${STATUS_NAMES[code]}. Nothing was changed.`, { code: "bad_input" });
        const body = { ProcStatus: code };
        if (a.date) body.ProcDate = a.date;
        else if (code === "C") body.ProcDate = today();
        await od.request("PUT", `/procedurelogs/${procNum}`, { body });
        const result = await verifyProc(procNum, expectedFrom(body));
        return out(result, {
          changed: `${STATUS_NAMES[from] || from} → ${STATUS_NAMES[code]}`,
          ...(code === "C" ? { charge: "Completed: the procedure fee posted to the patient's account." } : {}),
        });
      },
    },

    // -------------------------------------------------------------- tooth chart
    {
      name: "od_get_tooth_chart",
      annotations: READ,
      description: "Read the patient's tooth chart markings: missing teeth, hidden (unerupted) teeth, positions showing primary teeth (with their letters), and tooth movements.",
      inputSchema: obj({ pat_num: int("PatNum") }, ["pat_num"]),
      run: async (a) => {
        const rows = await od.request("GET", "/toothinitials", { params: { PatNum: recordId("pat_num", a.pat_num) } });
        const list = Array.isArray(rows) ? rows : [];
        const of = (t) => list.filter((r) => r.InitialType === t).map((r) => String(r.ToothNum));
        return out({
          missing: of("Missing"),
          hidden: of("Hidden"),
          primary: of("Primary").map((perm) => ({ position: perm, primary_tooth: primaryLetter(perm) })),
          movements: list.filter((r) => !["Missing", "Hidden", "Primary"].includes(r.InitialType)),
          raw: list,
        });
      },
    },
    {
      name: "od_set_tooth_status",
      annotations: WRITE,
      description:
        "CHART CHANGE. Mark teeth on the tooth chart: missing / not_missing, hidden (unerupted) / not_hidden, primary (show the primary tooth in that position) / permanent (show the permanent tooth again, e.g. after exfoliation). Teeth: 1-32 or A-T; for primary/permanent a letter or the permanent position (4-13, 20-29) both work. Already-correct teeth are skipped. Confirm the teeth and the change with the user first.",
      inputSchema: obj(
        {
          pat_num: int("PatNum"),
          teeth: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32, description: "Teeth, e.g. [\"1\", \"16\"] or [\"A\", \"T\"]." },
          status: { type: "string", enum: ["missing", "not_missing", "hidden", "not_hidden", "primary", "permanent"], description: "What to mark." },
        },
        ["pat_num", "teeth", "status"]
      ),
      run: async (a) => {
        needChart();
        const patNum = recordId("pat_num", a.pat_num);
        if (!Array.isArray(a.teeth) || !a.teeth.length || a.teeth.length > 32) throw new ODError("teeth must list 1-32 teeth.", { code: "bad_input" });
        const kind = { missing: "Missing", not_missing: "Missing", hidden: "Hidden", not_hidden: "Hidden", primary: "Primary", permanent: "Primary" }[a.status];
        if (!kind) throw new ODError("status must be missing, not_missing, hidden, not_hidden, primary or permanent.", { code: "bad_input" });
        const adding = ["missing", "hidden", "primary"].includes(a.status);
        // Validate every tooth before changing anything.
        const teeth = a.teeth.map((t) => {
          const valid = checkTooth(t);
          if (!valid) throw new ODError("Each tooth must be 1-32 or A-T.", { code: "bad_input" });
          if (/S$/.test(valid)) throw new ODError(`Supernumerary teeth (${valid}) can't be marked here.`, { code: "bad_input" });
          return kind === "Primary" ? permanentPosition(valid) : valid;
        });
        const existing = await od.request("GET", "/toothinitials", { params: { PatNum: patNum } });
        const marks = (Array.isArray(existing) ? existing : []).filter((r) => r.InitialType === kind && Number(r.PatNum ?? patNum) === patNum);
        const results = [];
        for (const t of [...new Set(teeth)]) {
          const label = kind === "Primary" ? `${t} (${primaryLetter(t)})` : t;
          const mine = marks.filter((r) => String(r.ToothNum).toUpperCase() === t);
          if (adding) {
            if (mine.length) {
              results.push({ tooth: label, result: `already ${a.status}` });
              continue;
            }
            await od.request("POST", "/toothinitials", { body: { PatNum: patNum, ToothNum: t, InitialType: kind } });
            results.push({ tooth: label, result: `marked ${a.status}` });
          } else {
            if (!mine.length) {
              results.push({ tooth: label, result: `already ${a.status.replace("_", " ")}` });
              continue;
            }
            for (const r of mine) await od.request("DELETE", `/toothinitials/${recordId("ToothInitialNum", r.ToothInitialNum)}`);
            results.push({ tooth: label, result: `marked ${a.status.replace("_", " ")}` });
          }
        }
        // Read back the chart and confirm every tooth is now in the requested state.
        const after = await od.request("GET", "/toothinitials", { params: { PatNum: patNum } });
        const now = new Set((Array.isArray(after) ? after : []).filter((r) => r.InitialType === kind).map((r) => String(r.ToothNum).toUpperCase()));
        const wrong = [...new Set(teeth)].filter((t) => now.has(t) !== adding);
        if (wrong.length) throw new ODError(`After saving, Open Dental's chart still doesn't show teeth ${wrong.join(", ")} as ${a.status.replace("_", " ")}. Check the chart in Open Dental.`, { code: "not_applied" });
        return out(results, { verified: "Read back from Open Dental after saving." });
      },
    },
  ];
}

module.exports = { buildClinicalTools };
