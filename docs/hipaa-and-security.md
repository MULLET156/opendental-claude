# HIPAA and security notes

This project moves protected health information (PHI) out of Open Dental. The software tries hard to be careful, but compliance depends on **where** you run it, **who** it talks to, and **what** you allow. These notes are practical guidance, not legal advice; check with your compliance advisor.

## Every hop needs a BAA

PHI leaves Open Dental and passes through each of these. Any outside company that handles PHI for you should have a Business Associate Agreement (BAA) with your practice:

| Hop | What to check |
|---|---|
| **Open Dental API** | Covered by your Open Dental agreement. The cloud mode routes through Open Dental's servers and your eConnector. |
| **Claude** (connector) | Patient details in a conversation are sent to Anthropic. Use a Claude plan that includes a BAA with Anthropic, and follow Anthropic's terms for PHI. Until then, use Open Dental's test database. |
| **Gateway host** | Office computer: you control it. Cloud server: the provider must sign a BAA (AWS, Azure and Google Cloud offer them; check the plan). Shared web hosting usually does not. For example, Hostinger has not offered HIPAA-compliant hosting ([Paubox review](https://paubox.com/blog/does-hostinger-offer-hipaa-compliant-web-hosting/)). |
| **Your apps** | Any app that receives patient-level data needs the same care about its own host, database, backups and logs. |
| **Network between them** | Keep the gateway on the office LAN, or use HTTPS plus a VPN. Don't expose the plain-http API Service or gateway to the internet. |

**Aggregate-only apps** (for example, production totals or procedure counts per day, with no names) carry much less risk. Give those apps only `reports` like `production_by_provider` or `procedure_counts` and no pass-through paths; the gateway then can't hand them patient-level data.

## Minimum necessary, enforced

- Create a separate Open Dental **Customer Key** for the gateway and one for Claude if you want different permissions, and grant each only what it needs. ApiReadAll-only keys are throttled harder in cloud mode.
- In the gateway, give each app its own key and the narrowest `allow` list, `reports` list and `redact` list that works. Leave `rawSql` off unless an app truly needs it.
- In Claude, leave **Allow changes** off unless you're using it.
- For extra protection on reports, Open Dental supports a lower-privilege MySQL user for API queries (`UserLow`/`PasswordLow` in `OpenDentalWebConfig.xml` on the eConnector machine).

## What the code does for you

- Sends Open Dental keys only to the configured API URL; never follows redirects; refuses plain http except to private network addresses.
- Validates record numbers, dates and patterns before calling Open Dental; builds paths only from validated parts.
- Removes `SSN`, `PatientSSN`, `DriverLicense` and similar fields at every depth of every response.
- Blocks non-read-only SQL (including writes hidden after a `;`, in a `WITH`, or behind comments) before it reaches Open Dental, which screens it again and records it in its audit trail.
- Gateway: app keys stored as SHA-256 hashes and compared in constant time; per-app rate limits; body size limits; no-store caching headers; CORS only for listed origins; an audit log that records who did what without recording patient data, query values or bodies (record numbers in paths are masked as `{id}`).
- Error messages never echo keys.

## What you still need to do

- Keep the gateway machine patched, encrypted at rest, and backed up like any other PHI system.
- Protect `.env` (Open Dental keys) with file permissions; store app keys only on the app's server, never in browser code or a public repo.
- Review the audit logs periodically and keep them for your retention period (HIPAA documentation is commonly kept six years).
- Rotate app keys when staff or vendors change, and disable apps you no longer use.
- Include these tools in your HIPAA risk assessment.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
