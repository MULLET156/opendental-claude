# Open Dental schema notes and example queries

The connector has built-in reports for all of these (`od_list_reports`, `od_run_report`). Use the SQL below only as a reference when writing a custom `od_run_query` the reports do not cover.

Replace `'2026-01-01'` / `'2026-01-31'` with the real inclusive start and end dates. Keep one statement per call. Never add SSN or other identifiers the question doesn't need.

Status codes used below (Open Dental schema):

- `procedurelog.ProcStatus`: 1 TP (treatment planned), 2 C (complete), 3 EC, 4 EO, 5 R, 6 D (deleted), 7 Cn (condition), 8 TPi
- `claimproc.Status`: 0 NotReceived, 1 Received, 2 Preauth, 3 Adjustment, 4 Supplemental, 6 Estimate, 7 CapComplete
- `appointment.AptStatus`: 1 Scheduled, 2 Complete, 3 UnschedList, 5 Broken, 6 Planned
- `claim.ClaimStatus`: U unsent, H hold, W waiting to send, P probably sent, S sent, R received
- `patient.PatStatus`: 0 Patient, 1 NonPatient, 2 Inactive, 3 Archived, 4 Deleted, 5 Deceased, 6 Prospective

---

## Gross production by provider

```sql
SELECT pl.ProvNum,
       ROUND(SUM(pl.ProcFee * (pl.UnitQty + pl.BaseUnits)), 2) AS GrossProduction,
       COUNT(*) AS ProcCount
FROM procedurelog pl
WHERE pl.ProcStatus = 2
  AND pl.ProcDate BETWEEN '2026-01-01' AND '2026-01-31'
GROUP BY pl.ProvNum
```

Add `pl.ClinicNum` to SELECT and GROUP BY for multi-clinic offices.

## Gross production by day (for trends / daily report)

```sql
SELECT pl.ProcDate,
       ROUND(SUM(pl.ProcFee * (pl.UnitQty + pl.BaseUnits)), 2) AS GrossProduction
FROM procedurelog pl
WHERE pl.ProcStatus = 2
  AND pl.ProcDate BETWEEN '2026-01-01' AND '2026-01-31'
GROUP BY pl.ProcDate
ORDER BY pl.ProcDate
```

## Adjustments by provider

```sql
SELECT a.ProvNum, ROUND(SUM(a.AdjAmt), 2) AS Adjustments
FROM adjustment a
WHERE a.AdjDate BETWEEN '2026-01-01' AND '2026-01-31'
GROUP BY a.ProvNum
```

## Write-offs by provider (procedure-date basis)

```sql
SELECT cp.ProvNum, ROUND(SUM(cp.WriteOff), 2) AS WriteOffs
FROM claimproc cp
WHERE cp.Status IN (1, 4, 7)
  AND cp.ProcDate BETWEEN '2026-01-01' AND '2026-01-31'
GROUP BY cp.ProvNum
```

For payment-date basis, filter on `cp.DateCP` instead of `cp.ProcDate`.

## Patient collections by provider

```sql
SELECT ps.ProvNum, ROUND(SUM(ps.SplitAmt), 2) AS PatientPayments
FROM paysplit ps
WHERE ps.DatePay BETWEEN '2026-01-01' AND '2026-01-31'
GROUP BY ps.ProvNum
```

## Insurance collections by provider

```sql
SELECT cp.ProvNum, ROUND(SUM(cp.InsPayAmt), 2) AS InsurancePayments
FROM claimproc cp
WHERE cp.Status IN (1, 4, 7)
  AND cp.DateCP BETWEEN '2026-01-01' AND '2026-01-31'
GROUP BY cp.ProvNum
```

## Production by procedure code (what drove the number)

```sql
SELECT pc.ProcCode, pc.Descript,
       COUNT(*) AS Qty,
       ROUND(SUM(pl.ProcFee * (pl.UnitQty + pl.BaseUnits)), 2) AS Production
FROM procedurelog pl
JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
WHERE pl.ProcStatus = 2
  AND pl.ProcDate BETWEEN '2026-01-01' AND '2026-01-31'
GROUP BY pc.ProcCode, pc.Descript
ORDER BY Production DESC
LIMIT 25
```

## Scheduled production (future days)

```sql
SELECT DATE(ap.AptDateTime) AS AptDate, ap.ProvNum,
       COUNT(DISTINCT ap.AptNum) AS Appointments,
       ROUND(SUM(pl.ProcFee * (pl.UnitQty + pl.BaseUnits)), 2) AS ScheduledProduction
FROM appointment ap
JOIN procedurelog pl ON pl.AptNum = ap.AptNum AND pl.ProcStatus IN (1, 2)
WHERE ap.AptStatus = 1
  AND DATE(ap.AptDateTime) BETWEEN '2026-01-01' AND '2026-01-31'
GROUP BY DATE(ap.AptDateTime), ap.ProvNum
ORDER BY AptDate, ap.ProvNum
```

## New patients in a period

```sql
SELECT COUNT(*) AS NewPatients
FROM patient p
WHERE p.DateFirstVisit BETWEEN '2026-01-01' AND '2026-01-31'
  AND p.PatStatus IN (0, 2)
```

---

## A/R aging by guarantor

```sql
SELECT p.PatNum, p.LName, p.FName,
       p.Bal_0_30, p.Bal_31_60, p.Bal_61_90, p.BalOver90,
       p.InsEst, p.BalTotal,
       ROUND(p.BalTotal - p.InsEst, 2) AS PatPortion
FROM patient p
WHERE p.Guarantor = p.PatNum
  AND p.BalTotal <> 0
  AND p.PatStatus <> 4
ORDER BY p.BalTotal DESC
LIMIT 200
```

Totals only: replace the column list with `SUM(...)` of each bucket and drop ORDER BY/LIMIT. One family: add `AND p.PatNum = <guarantor PatNum>`.

## Outstanding insurance claims (sent, not received)

```sql
SELECT c.ClaimNum, c.PatNum, p.LName, p.FName, ca.CarrierName,
       c.DateService, c.DateSent, DATEDIFF(CURDATE(), c.DateSent) AS DaysOut,
       c.ClaimFee, c.InsPayEst, c.ClaimType
FROM claim c
JOIN patient p ON p.PatNum = c.PatNum
JOIN insplan ip ON ip.PlanNum = c.PlanNum
JOIN carrier ca ON ca.CarrierNum = ip.CarrierNum
WHERE c.ClaimStatus = 'S'
  AND c.ClaimType IN ('P', 'S')
ORDER BY DaysOut DESC
LIMIT 300
```

Unsent / waiting / on hold: change the filter to `c.ClaimStatus IN ('U', 'W', 'H')` and drop DaysOut.

---

## Patient: recall due

```sql
SELECT r.PatNum, rt.Description, r.DateDue, r.DateScheduled, r.IsDisabled
FROM recall r
JOIN recalltype rt ON rt.RecallTypeNum = r.RecallTypeNum
WHERE r.PatNum = 0
```

Replace `0` with the PatNum. For an office-wide "overdue recall" list, use `r.DateDue < CURDATE() AND r.DateScheduled = '0001-01-01' AND r.IsDisabled = 0`, join `patient` for names, and add `LIMIT 200`.

## Patient: treatment-planned procedures

```sql
SELECT pl.ProcNum, pc.ProcCode, pc.Descript, pl.ToothNum, pl.Surf,
       ROUND(pl.ProcFee * (pl.UnitQty + pl.BaseUnits), 2) AS Fee, pl.ProvNum, pl.AptNum
FROM procedurelog pl
JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
WHERE pl.PatNum = 0
  AND pl.ProcStatus = 1
ORDER BY pl.ProcDate
```

Replace `0` with the PatNum. `AptNum = 0` means not yet scheduled.
