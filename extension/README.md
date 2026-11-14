# Open Dental connector for Claude

Lets Claude read your Open Dental schedule, patients, chart, A/R, claims and production through Open Dental's official API. Only if you turn them on, it can also change the schedule (book, move, confirm or break appointments, add commlogs) and the chart (unsigned group notes and addenda, treatment-planned procedures and treatment plans), after you approve each change.

Settings (Claude > Settings > Extensions > Open Dental):

- **Developer Key / Customer Key**: from Open Dental's Developer Portal; stored in your system keychain.
- **API URL**: `http://<Open Dental server IP>:30223/api/v1` in the office (API Service), or `https://api.opendental.com/api/v1` (cloud, needs the eConnector).
- **Open Dental API plan**: `read-all`, `standard` or `enterprise`; paces cloud requests to your plan.
- **Allow schedule changes**: off by default. Booking or moving appointments needs Open Dental's Appointments permission; confirming, breaking and commlogs need Comm; reports need Queries.
- **Allow chart changes**: off by default. Clinical notes and treatment planning need Open Dental's ProcedureLogs permission and the general write permission ($30 tier), and Open Dental 24.2.29 or newer. Claude never signs.

Full documentation: https://github.com/MULLET156/opendental-claude

Independent project; not affiliated with or endorsed by Open Dental Software, Inc.
