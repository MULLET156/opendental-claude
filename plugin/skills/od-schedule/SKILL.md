---
name: od-schedule
description: Use when the user asks about the Open Dental schedule — "what's on the schedule today", "who's coming in tomorrow", "find an opening for a 60-minute crown prep", "any holes in Dr. Lee's day", "who's on the ASAP list", "book/move/confirm/break this appointment". Covers day sheets, open slots, unconfirmed appointments, the ASAP list, and confirmed appointment changes.
---

# Open Dental schedule

## Reading the schedule

1. Resolve names to numbers first. Call `od_list_providers` for ProvNum/Abbr and `od_list_operatories` for OperatoryNum/OpName. Cache them for the conversation.
2. For a day or range, call `od_get_appointments` with `date_start` (and `date_end`). Dates are `yyyy-MM-dd`; resolve "today", "tomorrow", "next Tuesday" from the current date before calling.
3. Present a day sheet sorted by time, grouped by operatory or provider (whichever the user asked about). Show time, length, patient name, procedure description, provider, and confirmation status. Look up patient names with `od_get_patient` only for the rows shown, not the whole range.
4. Length comes from `Pattern`: each character is 5 minutes (`XXXXXX` = 30 min).
5. Only `AptStatus` Scheduled and Complete belong on a day sheet. Mention Broken and UnschedList separately when relevant.

Useful summaries: count of scheduled patients, new patients (`IsNewPatient`), unconfirmed appointments, and open time per provider.

## Finding openings

- Call `od_find_open_slots` with the date range and, when known, `prov_num`, `op_num`, and `length_minutes`.
- Slots already account for a provider working across several operatories.
- Open Dental's own slot search ignores blockouts (lunch, meetings); `od_find_open_slots` removes or trims slots that overlap a blockout and lists them under `removed_for_blockouts`. If it returns a `warning` that blockouts couldn't be read, say so and have the user confirm the time in Open Dental.
- For "who could fill this opening", pair the slot with `od_get_asap_list`.

## Changing appointments (writes)

Writes only work when the office turned them on (`od_connection_check` shows `writes_enabled`). If off, say so and give the user the details to do it in Open Dental.

Before every write:

1. Re-read the current appointment or slot so the details are fresh.
2. State the exact change in one line — patient, date, time, chair, provider, length — and ask for a clear yes. One yes covers one change.
3. After the call, report what Open Dental returned (AptNum, new time). If it errored, quote the error and do not retry a different way without asking.

Rules:
- Book only into slots `od_find_open_slots` shows as open, unless the user explicitly says to double-book.
- Break an appointment only when the user says the patient no-showed or cancelled; ask whether to send it to the Unscheduled List.
- Ask whether it was a no-show or a short-notice cancellation: `break_type: "Missed"` adds D9986 and `"Cancelled"` adds D9987, if the office has a broken appointment procedure set in Appts Preferences. The API never posts the broken-appointment adjustment; tell the user to add it in Open Dental if the office uses one.
- After moving an appointment, Open Dental keeps the old date on the arrived/seated/dismissed placeholder times. That's cosmetic.
- Every schedule change is read back. If a tool says Open Dental "did not apply" it, the change was NOT made; say so.
- Log what happened with `od_add_commlog` when the user mentions a call or text (e.g. "Pt called to reschedule"), after confirming the note text.
- Never change appointments in bulk from a single instruction; walk through them one at a time.
