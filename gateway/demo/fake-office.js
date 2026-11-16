"use strict";
/**
 * A made-up dental office for the demo gateway and tests. Everything here is
 * fake: invented names, 555-01xx phone numbers, example.com emails. It never
 * contains real patient data.
 *
 * Tables are shaped like Open Dental's database (patient, appointment,
 * procedurelog, benefit, claimproc ...) so the fake report engine can mirror
 * the real report SQL. Dates are relative to "today", so the demo always has a
 * schedule for today, overdue x-rays, benefits used this year, and so on.
 *
 *   const office = buildOffice({ today: "2026-11-16", seed: 7 });
 */

// ------------------------------------------------------------------ helpers

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function addMonths(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

const weekday = (iso) => new Date(iso + "T12:00:00Z").getUTCDay(); // 0 Sunday
const MIN_DATE = "0001-01-01";
const MIN_DATETIME = "0001-01-01 00:00:00";

// ------------------------------------------------------------------ reference data

const FIRST = ["Avery", "Blake", "Casey", "Dana", "Emery", "Finley", "Gray", "Harper", "Indy", "Jules", "Kendall", "Logan", "Morgan", "Noel", "Oakley", "Parker", "Quinn", "Riley", "Sage", "Tatum", "Umber", "Vale", "Wren", "Yael"];
const LAST = ["Applewood", "Brightwater", "Cedarfield", "Dunmore", "Elmsworth", "Fernhill", "Glenrock", "Hollowell", "Ivywood", "Juniper", "Kestrel", "Larkspur", "Maplecrest", "Northbrook", "Oakhurst", "Pinecroft", "Quarry", "Ravensdale", "Stillwater", "Thornbury", "Underhill", "Violetta", "Willowby", "Yarrow"];

const CODES = [
  // [ProcCode, Descript, Fee, TreatArea]
  ["D0120", "periodic oral evaluation", 65, "Mouth"],
  ["D0140", "limited oral evaluation - problem focused", 90, "Mouth"],
  ["D0150", "comprehensive oral evaluation", 120, "Mouth"],
  ["D0180", "comprehensive periodontal evaluation", 110, "Mouth"],
  ["D0210", "intraoral - comprehensive series of radiographic images", 160, "Mouth"],
  ["D0220", "intraoral - periapical first radiographic image", 35, "Tooth"],
  ["D0230", "intraoral - periapical each additional radiographic image", 30, "Tooth"],
  ["D0272", "bitewings - two radiographic images", 55, "Mouth"],
  ["D0274", "bitewings - four radiographic images", 75, "Mouth"],
  ["D0330", "panoramic radiographic image", 140, "Mouth"],
  ["D1110", "prophylaxis - adult", 115, "Mouth"],
  ["D1120", "prophylaxis - child", 85, "Mouth"],
  ["D1206", "topical application of fluoride varnish", 45, "Mouth"],
  ["D1351", "sealant - per tooth", 60, "Tooth"],
  ["D2140", "amalgam - one surface, primary or permanent", 150, "Surf"],
  ["D2391", "resin-based composite - one surface, posterior", 190, "Surf"],
  ["D2392", "resin-based composite - two surfaces, posterior", 240, "Surf"],
  ["D2393", "resin-based composite - three surfaces, posterior", 290, "Surf"],
  ["D2740", "crown - porcelain/ceramic", 1350, "Tooth"],
  ["D2750", "crown - porcelain fused to high noble metal", 1250, "Tooth"],
  ["D2950", "core buildup, including any pins when required", 320, "Tooth"],
  ["D3310", "endodontic therapy, anterior tooth", 950, "Tooth"],
  ["D3330", "endodontic therapy, molar tooth", 1300, "Tooth"],
  ["D4341", "periodontal scaling and root planing - four or more teeth per quadrant", 280, "Quad"],
  ["D4910", "periodontal maintenance", 155, "Mouth"],
  ["D6010", "surgical placement of implant body: endosteal implant", 2400, "Tooth"],
  ["D6057", "custom fabricated abutment - includes placement", 600, "Tooth"],
  ["D6058", "abutment supported porcelain/ceramic crown", 1400, "Tooth"],
  ["D7140", "extraction, erupted tooth or exposed root", 210, "Tooth"],
  ["D7210", "extraction, erupted tooth requiring removal of bone", 380, "Tooth"],
  ["D9944", "occlusal guard - hard appliance, full arch", 450, "Mouth"],
  ["~GRP~", "Group Note", 0, "Mouth"],
];

// Treatment that gets planned: [code, needs tooth, surfaces]
const PLANNED = [
  ["D2740", true, ""],
  ["D2740", true, ""],
  ["D2950", true, ""],
  ["D2391", true, "O"],
  ["D2392", true, "MO"],
  ["D2393", true, "MOD"],
  ["D3330", true, ""],
  ["D6010", true, ""],
  ["D6058", true, ""],
  ["D7210", true, ""],
  ["D4341", false, ""],
  ["D9944", false, ""],
];
const POSTERIOR = ["2", "3", "4", "5", "12", "13", "14", "15", "18", "19", "20", "21", "28", "29", "30", "31"];

// ------------------------------------------------------------------ builder

function buildOffice({ today = localToday(), seed = 7 } = {}) {
  const rnd = mulberry32(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const chance = (p) => rnd() < p;
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

  const o = {
    today,
    fake: true,
    provider: [
      { ProvNum: 1, Abbr: "DDS1", FName: "Avery", LName: "Demo", Suffix: "DDS", IsSecondary: 0, IsHidden: 0 },
      { ProvNum: 2, Abbr: "HYG1", FName: "Blake", LName: "Sample", Suffix: "RDH", IsSecondary: 1, IsHidden: 0 },
      { ProvNum: 3, Abbr: "HYG2", FName: "Casey", LName: "Example", Suffix: "RDH", IsSecondary: 1, IsHidden: 0 },
    ],
    operatory: [
      { OperatoryNum: 1, OpName: "Op 1", Abbrev: "Op1", ItemOrder: 0, ProvDentist: 1, ProvHygienist: 0, IsHygiene: 0, ClinicNum: 0, IsHidden: 0 },
      { OperatoryNum: 2, OpName: "Op 2", Abbrev: "Op2", ItemOrder: 1, ProvDentist: 1, ProvHygienist: 0, IsHygiene: 0, ClinicNum: 0, IsHidden: 0 },
      { OperatoryNum: 3, OpName: "Hyg 1", Abbrev: "H1", ItemOrder: 2, ProvDentist: 1, ProvHygienist: 2, IsHygiene: 1, ClinicNum: 0, IsHidden: 0 },
      { OperatoryNum: 4, OpName: "Hyg 2", Abbrev: "H2", ItemOrder: 3, ProvDentist: 1, ProvHygienist: 3, IsHygiene: 1, ClinicNum: 0, IsHidden: 0 },
    ],
    definition: [
      // Category 2: appointment confirmation; 20: treatment plan priorities
      { DefNum: 21, Category: 2, ItemName: "Unconfirmed", ItemOrder: 0 },
      { DefNum: 22, Category: 2, ItemName: "Confirmed", ItemOrder: 1 },
      { DefNum: 23, Category: 2, ItemName: "Texted", ItemOrder: 2 },
      { DefNum: 501, Category: 20, ItemName: "1", ItemOrder: 0 },
      { DefNum: 502, Category: 20, ItemName: "2", ItemOrder: 1 },
      { DefNum: 503, Category: 20, ItemName: "3", ItemOrder: 2 },
      { DefNum: 504, Category: 20, ItemName: "Urgent", ItemOrder: 3 },
    ],
    procedurecode: CODES.map(([ProcCode, Descript, Fee, TreatArea], i) => ({ CodeNum: i + 1, ProcCode, Descript, AbbrDesc: ProcCode, Fee, TreatArea, IsHygiene: /^D(01|02|03|1|49)/.test(ProcCode) ? 1 : 0 })),
    patient: [],
    appointment: [],
    procedurelog: [],
    procnote: [],
    carrier: [
      { CarrierNum: 1, CarrierName: "Example Dental PPO" },
      { CarrierNum: 2, CarrierName: "Sample Mutual Dental" },
      { CarrierNum: 3, CarrierName: "Demo Benefit Co" },
      { CarrierNum: 4, CarrierName: "Test Union Dental" },
    ],
    insplan: [
      { PlanNum: 1, CarrierNum: 1, GroupName: "Coastal Schools", GroupNum: "FAKE-100", MonthRenew: 0, PlanType: "" },
      { PlanNum: 2, CarrierNum: 2, GroupName: "Riverside Mill", GroupNum: "FAKE-200", MonthRenew: 0, PlanType: "" },
      { PlanNum: 3, CarrierNum: 3, GroupName: "County Workers", GroupNum: "FAKE-300", MonthRenew: 7, PlanType: "" },
      { PlanNum: 4, CarrierNum: 4, GroupName: "Harbor Union", GroupNum: "FAKE-400", MonthRenew: 0, PlanType: "" },
      { PlanNum: 5, CarrierNum: 1, GroupName: "Individual", GroupNum: "FAKE-500", MonthRenew: 0, PlanType: "" },
    ],
    inssub: [],
    patplan: [],
    benefit: [],
    claimproc: [],
    codegroup: [],
    laboratory: [
      { LaboratoryNum: 1, Description: "In-house CEREC", IsHidden: 0 },
      { LaboratoryNum: 2, Description: "Demo Dental Lab", IsHidden: 0 },
    ],
    labcase: [],
    treatplan: [],
    treatplanattach: [],
    toothinitial: [],
    commlog: [],
  };

  const code = (c) => o.procedurecode.find((x) => x.ProcCode === c);
  const n = { pat: 1001, apt: 5001, proc: 20001, note: 30001, claimproc: 40001, benefit: 60001, sub: 70001, patplan: 80001, lab: 90001 };

  // ---------------------------------------------------------------- benefits
  // Annual maximums and frequency limits. Benefit enums: BenefitType 5 = limitation;
  // QuantityQualifier 1 services, 4 years, 5 months; TimePeriod 1 service yr, 2 calendar yr, 3 lifetime, 5 last 12 months.
  const benefit = (PlanNum, b) =>
    o.benefit.push({ BenefitNum: n.benefit++, PlanNum, PatPlanNum: 0, CovCatNum: 0, BenefitType: 5, Percent: -1, MonetaryAmt: -1, TimePeriod: 0, QuantityQualifier: 0, Quantity: 0, CodeNum: 0, CodeGroupNum: 0, CoverageLevel: 1, ...b });
  const freq = (PlanNum, proc, Quantity, QuantityQualifier, TimePeriod = 0) => benefit(PlanNum, { CodeNum: code(proc).CodeNum, Quantity, QuantityQualifier, TimePeriod });
  const max = (PlanNum, MonetaryAmt, TimePeriod) => benefit(PlanNum, { MonetaryAmt, TimePeriod });
  max(1, 1500, 2);
  freq(1, "D0274", 12, 5); // BWX 1 per 12 months
  freq(1, "D0210", 5, 4); // FMX 1 per 5 years
  freq(1, "D0330", 5, 4); // pano 1 per 5 years
  max(2, 1000, 2);
  freq(2, "D0274", 1, 1, 2); // BWX 1 per calendar year
  freq(2, "D0210", 3, 4);
  freq(2, "D0330", 3, 4);
  max(3, 2000, 1); // benefit year starts in July
  freq(3, "D0274", 2, 1, 1); // BWX 2 per benefit year
  freq(3, "D0210", 60, 5); // 1 per 60 months
  freq(3, "D0330", 60, 5);
  max(4, 1250, 2);
  freq(4, "D0274", 1, 1, 5); // BWX 1 in the last 12 months
  freq(4, "D0210", 1, 1, 3); // FMX 1 per lifetime
  max(5, 1000, 2); // no frequency limits on file

  // ---------------------------------------------------------------- helpers
  const proc = (p) => {
    const c = code(p.code);
    const row = {
      ProcNum: n.proc++,
      PatNum: p.PatNum,
      AptNum: p.AptNum || 0,
      PlannedAptNum: p.PlannedAptNum || 0,
      ProcDate: p.ProcDate,
      DateTP: p.DateTP || p.ProcDate,
      ProcStatus: p.ProcStatus,
      CodeNum: c.CodeNum,
      ProcFee: c.Fee,
      UnitQty: 1,
      BaseUnits: 0,
      ToothNum: p.ToothNum || "",
      Surf: p.Surf || "",
      ProvNum: p.ProvNum || 1,
      Priority: p.Priority || 0,
      ClinicNum: 0,
    };
    o.procedurelog.push(row);
    return row;
  };
  const appt = (a) => {
    const row = {
      AptNum: n.apt++,
      PatNum: a.PatNum,
      AptStatus: a.AptStatus,
      AptDateTime: a.AptDateTime,
      Pattern: "X".repeat(a.minutes / 5),
      ProvNum: a.ProvNum || 1,
      ProvHyg: a.ProvHyg || 0,
      Op: a.Op,
      Confirmed: a.Confirmed || 21,
      IsHygiene: a.IsHygiene ? 1 : 0,
      IsNewPatient: a.IsNewPatient ? 1 : 0,
      ProcDescript: "",
      Note: "",
      ClinicNum: 0,
    };
    o.appointment.push(row);
    return row;
  };
  const describe = (a) => {
    a.ProcDescript = o.procedurelog
      .filter((p) => p.AptNum === a.AptNum)
      .map((p) => o.procedurecode.find((c) => c.CodeNum === p.CodeNum).ProcCode)
      .join(", ");
  };
  const at = (date, mins) => `${date} ${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;

  // ---------------------------------------------------------------- patients
  const pats = [];
  for (let i = 0; i < 48; i++) {
    const PatNum = n.pat++;
    const LName = LAST[i % LAST.length];
    const FName = FIRST[(i * 7 + 3 + Math.floor(i / LAST.length) * 5) % FIRST.length];
    const age = int(8, 82);
    const status = i === 46 ? 2 : i === 47 ? 5 : 0; // one inactive, one prospective
    const firstVisit = addMonths(today, -int(14, 120));
    const p = {
      PatNum,
      LName,
      FName,
      MiddleI: "",
      Preferred: chance(0.15) ? FName.slice(0, 3) : "",
      PatStatus: status,
      Gender: i % 2,
      Birthdate: `${Number(today.slice(0, 4)) - age}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`,
      PriProv: 1,
      SecProv: chance(0.5) ? 2 : 3,
      DateFirstVisit: status === 5 ? MIN_DATE : firstVisit,
      Guarantor: PatNum,
      HmPhone: "",
      WirelessPhone: `(541) 555-01${String(i).padStart(2, "0")}`,
      Email: `${FName.toLowerCase()}.${LName.toLowerCase()}@example.com`,
      Address: `${100 + i} Example St`,
      City: "Toledo",
      State: "OR",
      Zip: "97391",
      ChartNumber: "",
      BalTotal: chance(0.2) ? int(20, 900) : 0,
      InsEst: 0,
      age,
    };
    o.patient.push(p);
    pats.push(p);
  }

  // ---------------------------------------------------------------- insurance
  for (const [i, p] of pats.entries()) {
    if (p.PatStatus === 5 || i % 4 === 3) continue; // about a quarter uninsured
    const PlanNum = (i % 5) + 1;
    const sub = { InsSubNum: n.sub++, PlanNum, Subscriber: p.PatNum, DateEffective: addMonths(p.DateFirstVisit, -1), SubscriberID: `FAKE${p.PatNum}` };
    o.inssub.push(sub);
    o.patplan.push({ PatPlanNum: n.patplan++, PatNum: p.PatNum, InsSubNum: sub.InsSubNum, Ordinal: 1, Relationship: 0 });
    p.plan = { PlanNum, InsSubNum: sub.InsSubNum };
    if (i % 9 === 0) {
      const sub2 = { InsSubNum: n.sub++, PlanNum: 4, Subscriber: p.PatNum, DateEffective: p.DateFirstVisit, SubscriberID: `FAKE${p.PatNum}B` };
      o.inssub.push(sub2);
      o.patplan.push({ PatPlanNum: n.patplan++, PatNum: p.PatNum, InsSubNum: sub2.InsSubNum, Ordinal: 2, Relationship: 1 });
    }
  }

  // ---------------------------------------------------------------- history
  // Hygiene visits every ~6 months up to each patient's last visit; x-rays on their own cycles.
  for (const [i, p] of pats.entries()) {
    if (p.PatStatus === 5) continue;
    const lapsed = i % 6 === 5 || p.PatStatus === 2; // last seen 14-30 months ago
    let last = addDays(today, -(lapsed ? int(420, 900) : int(20, 175)));
    p.lastVisit = last;
    const visits = [];
    for (let d = last; d >= p.DateFirstVisit; d = addDays(addMonths(d, -6), int(-14, 14))) visits.push(d);
    const bwEvery = pick([12, 12, 18, 24]);
    let nextBw = null;
    let fmxDone = false;
    let panoDone = false;
    for (const d of visits) {
      if (weekday(d) === 0 || weekday(d) === 6) continue;
      const hyg = p.SecProv;
      const a = appt({ PatNum: p.PatNum, AptStatus: 2, AptDateTime: at(d, 8 * 60 + int(0, 14) * 30), minutes: 60, ProvNum: 1, ProvHyg: hyg, Op: hyg === 2 ? 3 : 4, IsHygiene: true, Confirmed: 22 });
      const codes = [p.age < 14 ? "D1120" : "D1110", "D0120"];
      if (nextBw === null || d <= nextBw) {
        codes.push("D0274");
        nextBw = addMonths(d, -bwEvery);
      }
      if (!fmxDone && i % 3 === 0 && d <= addMonths(today, -int(20, 70))) {
        codes.push("D0210");
        fmxDone = true;
      }
      if (!panoDone && i % 4 === 1 && d <= addMonths(today, -int(30, 80))) {
        codes.push("D0330");
        panoDone = true;
      }
      for (const c of codes) proc({ PatNum: p.PatNum, AptNum: a.AptNum, ProcDate: d, ProcStatus: 2, code: c, ProvNum: c === "D0120" ? 1 : hyg });
      describe(a);
    }
    // Some completed restorative work in the last few months.
    if (!lapsed && chance(0.45)) {
      const d = addDays(today, -int(3, 70));
      if (weekday(d) !== 0 && weekday(d) !== 6) {
        const tooth = pick(POSTERIOR);
        const c = pick(["D2391", "D2392", "D2740", "D2950"]);
        const a = appt({ PatNum: p.PatNum, AptStatus: 2, AptDateTime: at(d, 9 * 60 + int(0, 12) * 30), minutes: c === "D2740" ? 90 : 60, ProvNum: 1, Op: pick([1, 2]), Confirmed: 22 });
        proc({ PatNum: p.PatNum, AptNum: a.AptNum, ProcDate: d, ProcStatus: 2, code: c, ToothNum: tooth, Surf: c.startsWith("D23") ? "MO" : "" });
        describe(a);
        p.lastVisit = d > p.lastVisit ? d : p.lastVisit;
      }
    }
  }

  // ---------------------------------------------------------------- planned treatment
  for (const [i, p] of pats.entries()) {
    if (p.PatStatus === 5 || i % 5 === 4) continue; // some have nothing planned
    const count = int(1, 3);
    for (let k = 0; k < count; k++) {
      const [c, tooth, surf] = pick(PLANNED);
      const dtp = addDays(today, -int(5, 500));
      proc({ PatNum: p.PatNum, ProcDate: dtp, DateTP: dtp, ProcStatus: 1, code: c, ToothNum: tooth ? pick(POSTERIOR) : "", Surf: surf, Priority: pick([0, 501, 502, 503, 504]) });
    }
    if (i % 7 === 0) proc({ PatNum: p.PatNum, ProcDate: today, DateTP: addDays(today, -30), ProcStatus: 1, code: "D1110", ProvNum: p.SecProv }); // planned hygiene: left out of unscheduled lists
  }

  // ---------------------------------------------------------------- the schedule (today and the next 3 weeks)
  const active = pats.filter((p) => p.PatStatus === 0);
  const scheduleDays = [];
  for (let d = 0; scheduleDays.length < 15; d++) {
    const day = addDays(today, d);
    if (d === 0 || (weekday(day) !== 0 && weekday(day) !== 6)) scheduleDays.push(day);
  }
  let cursor = 0;
  const nextPatient = () => active[cursor++ % active.length];
  for (const [dayIndex, day] of scheduleDays.entries()) {
    const perDay = dayIndex === 0 ? 12 : int(4, 8);
    for (let k = 0; k < perDay; k++) {
      const p = nextPatient();
      if (p.lastVisit && p.lastVisit < addDays(today, -400) && dayIndex > 0) continue; // lapsed patients stay unscheduled
      const hygiene = k % 2 === 0;
      const start = 8 * 60 + Math.floor(k / 2) * 60 + (hygiene ? 0 : 30);
      const isToday = dayIndex === 0;
      const status = isToday && k === 3 ? 5 : isToday && k < 2 ? 2 : 1; // two finished, one broken today
      const a = appt({
        PatNum: p.PatNum,
        AptStatus: status,
        AptDateTime: at(day, start),
        minutes: hygiene ? 60 : 90,
        ProvNum: 1,
        ProvHyg: hygiene ? p.SecProv : 0,
        Op: hygiene ? (p.SecProv === 2 ? 3 : 4) : (k % 4 === 1 ? 1 : 2),
        IsHygiene: hygiene,
        IsNewPatient: k === 5 && isToday,
        Confirmed: isToday ? pick([22, 22, 23]) : pick([21, 22, 23]),
      });
      if (hygiene) {
        for (const c of [p.age < 14 ? "D1120" : "D1110", "D0120"]) proc({ PatNum: p.PatNum, AptNum: a.AptNum, ProcDate: day, ProcStatus: status === 2 ? 2 : 1, code: c, ProvNum: c === "D0120" ? 1 : p.SecProv });
      } else {
        // Move one of the patient's planned procedures onto this appointment.
        const tp = o.procedurelog.find((x) => x.PatNum === p.PatNum && x.ProcStatus === 1 && !x.AptNum && x.CodeNum !== code("D1110").CodeNum);
        if (tp) {
          tp.AptNum = a.AptNum;
          tp.ProcDate = day;
          if (status === 2) tp.ProcStatus = 2;
        } else proc({ PatNum: p.PatNum, AptNum: a.AptNum, ProcDate: day, ProcStatus: status === 2 ? 2 : 1, code: "D2392", ToothNum: pick(POSTERIOR), Surf: "DO" });
      }
      describe(a);
    }
  }
  // A planned (not yet scheduled) appointment: its procedures still count as unscheduled.
  {
    const p = active[5];
    const a = appt({ PatNum: p.PatNum, AptStatus: 6, AptDateTime: MIN_DATETIME, minutes: 90, Op: 0 });
    const tp = o.procedurelog.find((x) => x.PatNum === p.PatNum && x.ProcStatus === 1 && !x.AptNum);
    if (tp) tp.PlannedAptNum = a.AptNum;
  }

  // ---------------------------------------------------------------- insurance used this year
  for (const p of pats) {
    if (!p.plan) continue;
    const plan = o.insplan.find((x) => x.PlanNum === p.plan.PlanNum);
    const [y, m] = today.split("-").map(Number);
    const mr = plan.MonthRenew || 1;
    const yearStart = `${m >= mr ? y : y - 1}-${String(mr).padStart(2, "0")}-01`;
    for (const pr of o.procedurelog) {
      if (pr.PatNum !== p.PatNum || pr.ProcStatus !== 2 || pr.ProcDate < yearStart || pr.ProcDate > today) continue;
      const c = o.procedurecode.find((x) => x.CodeNum === pr.CodeNum).ProcCode;
      if (c === "~GRP~") continue;
      const pct = /^D(0|1)/.test(c) ? 1 : /^D(2[1-3]|4|7)/.test(c) ? 0.8 : 0.5;
      const est = Math.round(pr.ProcFee * pct * 100) / 100;
      const pending = pr.ProcDate > addDays(today, -21);
      o.claimproc.push({
        ClaimProcNum: n.claimproc++,
        PatNum: p.PatNum,
        ProcNum: pr.ProcNum,
        InsSubNum: p.plan.InsSubNum,
        PlanNum: p.plan.PlanNum,
        ProvNum: pr.ProvNum,
        Status: pending ? 0 : 1,
        ProcDate: pr.ProcDate,
        DateCP: pending ? MIN_DATE : addDays(pr.ProcDate, 18),
        InsPayEst: est,
        InsPayAmt: pending ? 0 : est,
        WriteOff: Math.round(pr.ProcFee * 0.1 * 100) / 100,
      });
    }
  }
  // One patient has used their whole annual maximum.
  {
    const p = pats.find((x) => x.plan && x.plan.PlanNum === 2);
    if (p) o.claimproc.push({ ClaimProcNum: n.claimproc++, PatNum: p.PatNum, ProcNum: 0, InsSubNum: p.plan.InsSubNum, PlanNum: 2, ProvNum: 1, Status: 1, ProcDate: addDays(today, -60), DateCP: addDays(today, -40), InsPayEst: 1000, InsPayAmt: 1000, WriteOff: 0 });
  }

  // ---------------------------------------------------------------- procedure notes (some unsigned)
  let k = 0;
  for (const pr of o.procedurelog) {
    if (pr.ProcStatus !== 2 || pr.ProcDate < addDays(today, -60)) continue;
    const c = o.procedurecode.find((x) => x.CodeNum === pr.CodeNum).ProcCode;
    if (c === "D0120") continue;
    const signed = k++ % 3 !== 0;
    o.procnote.push({
      ProcNoteNum: n.note++,
      PatNum: pr.PatNum,
      ProcNum: pr.ProcNum,
      EntryDateTime: `${pr.ProcDate} 17:${String(10 + (k % 40)).padStart(2, "0")}:00`,
      UserNum: 1,
      Note: `Demo note: ${c} completed. (Fake data.)`,
      Signature: signed ? "demo-signature" : "",
      SigIsTopaz: 0,
    });
  }

  // ---------------------------------------------------------------- lab cases for upcoming crowns
  const crown = new Set(["D2740", "D6058", "D2750"].map((c) => code(c).CodeNum));
  let labCount = 0;
  for (const pr of o.procedurelog) {
    if (!crown.has(pr.CodeNum) || pr.ProcStatus !== 1 || !pr.AptNum || labCount >= 6) continue;
    const a = o.appointment.find((x) => x.AptNum === pr.AptNum);
    if (!a || a.AptStatus !== 1) continue;
    const seat = a.AptDateTime.slice(0, 10);
    const outside = labCount % 2 === 1;
    const sent = addDays(seat, outside ? -12 : -2);
    o.labcase.push({
      LabCaseNum: n.lab++,
      PatNum: pr.PatNum,
      LaboratoryNum: outside ? 2 : 1,
      AptNum: a.AptNum,
      PlannedAptNum: 0,
      ProvNum: 1,
      DateTimeCreated: `${addDays(sent, -1)} 10:00:00`,
      DateTimeSent: sent <= today ? `${sent} 15:00:00` : MIN_DATETIME,
      DateTimeDue: `${addDays(seat, -1)} 12:00:00`,
      DateTimeRecd: labCount === 0 && sent <= today ? `${addDays(today, -1)} 11:00:00` : MIN_DATETIME,
      DateTimeChecked: MIN_DATETIME,
      Instructions: `Tooth #${pr.ToothNum}, shade A2 (fake)`,
    });
    labCount++;
  }

  for (const p of o.patient) {
    delete p.age;
    delete p.plan;
    delete p.lastVisit;
  }
  return o;
}

module.exports = { buildOffice, addDays, addMonths, localToday, MIN_DATE, MIN_DATETIME };
