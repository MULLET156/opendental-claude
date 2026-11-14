# Open Dental × Claude

Connect [Open Dental](https://www.opendental.com/) to Claude, and to the apps you build, through Open Dental's official API.

| Part | What it is | Who it's for |
|---|---|---|
| **Claude connector** (`opendental.mcpb`) | A Claude desktop extension. Ask Claude about the schedule, patients, chart, A/R, claims and production; optionally let it book or move appointments, write clinical notes, and enter treatment plans after you approve each change. | Dentists, office managers |
| **Claude skills** (`opendental` plugin) | Teaches Claude how a dental office works with Open Dental: day sheets, open slots, group notes, treatment planning, aging buckets, net production, recall. | Anyone using the connector |
| **App gateway** (`gateway/`) | A small web service your own apps call to read from and write to Open Dental, with a separate key and permissions for each app, built-in reports, and an audit log. | Practices and developers building their own tools |

All three share one core (`core/`), so the safety rules are the same everywhere. There are **no dependencies** to install; everything runs on plain Node.js, and Claude desktop supplies its own copy for the connector.

> Independent, community project. Not affiliated with or endorsed by Open Dental Software, Inc. "Open Dental" is their trademark.

---

## What you can ask Claude

- "What's on Dr. Lee's schedule tomorrow? Who's unconfirmed?"
- "Find a 60-minute opening next week in Op 3." / "Who's on the ASAP list?"
- "Pull up Jane Smith, born 1976-05-24. When is she due for recall? What's treatment-planned?"
- "A/R aging totals." / "Who owes over $500 past 90 days?" / "Outstanding claims over 30 days by carrier."
- "Month-to-date production by provider, net of adjustments and write-offs." / "Collections last week."
- "What did we do at Mr. Lee's last visit? Is the note signed?" / "Check her meds and allergies before we plan the extraction."
- With schedule changes allowed: "Move Mrs. Patel's Thursday cleaning to 2:00 in Op 2 and log that she called."
- With chart changes allowed: "Write today's group note for Jane Smith: MO composite #3, 1 carp 2% lido 1:100k, tolerated well." / "Treatment plan a crown on 30 and an MOD composite on 3, phase 1, urgent." / "Put the implant on 19 in a separate plan called Option A."

## Which Open Dental API plan do I need?

Open Dental sells API access in permission tiers, per location ([pricing and permissions](https://www.opendental.com/site/apipermissions.html); prices may change). Pick the tier that covers what you want to do:

| You want to… | Open Dental permission | Lowest tier |
|---|---|---|
| Read the schedule, open slots, patients, commlogs, providers, operatories | Read All | Free (cloud: 1 request / 5 s) |
| Run reports: production, collections, A/R aging, claims, recall, treatment plans | Queries | $15/mo |
| Confirm or break appointments, add appointment notes, log calls (commlogs), recall status | Comm | $15/mo |
| Upload documents/images; simple insurance updates; setup tables | Documents, InsuranceSimple, Setup | $15/mo |
| Book or move appointments | Appointments | $30/mo |
| Write chart notes (group notes, addenda); enter treatment-planned procedures and treatment plans | ProcedureLogs and the general write permission (AllOthers) | $30/mo |
| Add or edit patients; post procedures; claims and insurance plans | Patients, ProcedureLogs, Insurance | $30/mo |
| Take payments; payment plans | Payments, PayPlans | $35/mo |
| Faster cloud access (1 request / 0.5 s, bigger pages) | Enterprise (special) | Contact Open Dental |

The **Claude connector** uses Read All, Queries, Comm, Appointments, ProcedureLogs and the general write permission. Reading notes and adding to notes needs Open Dental 24.2.29 or newer. The **app gateway** can reach every Open Dental endpoint your key's tier allows, limited by each app's allow list.

Tell the connector and gateway which plan you're on (`read-all`, `standard` or `enterprise`) so they pace cloud requests to match. Local API and API Service requests aren't throttled, so this only matters for the cloud URL.

> **Important:** Open Dental's own user permissions and date locks **do not** restrict changes made through the API. Whatever your key's tier allows is limited only by the connector's "Allow schedule changes" and "Allow chart changes" switches and each gateway app's allow list. Keep write access narrow, especially Payments, Insurance and ProcedureLogs.

## Quick start

### 1. Get Open Dental API keys

1. Email **vendor.relations@opendental.com** for Developer Portal access (a practice can register as its own developer). You receive a **Developer Key**.
2. In the Developer Portal, create a **Customer Key** for the office with only the permissions you'll use (see the table above).
3. In Open Dental: **Setup > Advanced Setup > API**, add the Customer Key and check **Enabled**.

The API is a paid Open Dental add-on, billed per location. Open Dental's own guides:

- [API Setup](https://www.opendental.com/site/apisetup.html): getting Developer Portal access, creating and enabling keys, the public test database
- [API Permissions](https://www.opendental.com/site/apipermissions.html): what each permission allows, and pricing tiers
- [API Modes: Local, Service and Remote](https://www.opendental.com/site/apilocal.html): installing and running the API Service
- [API Specification](https://www.opendental.com/site/apispecification.html): every endpoint, for building your own apps through the gateway

### 2. Pick how to reach Open Dental

| Mode | API URL | Use when |
|---|---|---|
| **API Service** (recommended in the office) | `http://<Open Dental server IP>:30223/api/v1` | The computer running Claude or the gateway is on the office network. Fast, not throttled. |
| Cloud | `https://api.opendental.com/api/v1` | Working from outside the office. Needs the eConnector running. Open Dental throttles by plan (see above); the connector paces itself. |
| Local API | `http://localhost:30222/api/v1` | Open Dental itself is open and logged in on the same computer. |

#### Set up the API Service (in the office, one time)

Do these on the **Open Dental server** (the computer that hosts the database), logged into Open Dental as an administrator. The API Service needs eConnector version 22.2.16 or later and internet access (it checks your keys with Open Dental every few hours). Open Dental's full instructions, including the manual install for versions 22.2.41 and earlier, are on their [API Modes page](https://www.opendental.com/site/apilocal.html).

1. **Turn on the API:** **Setup > Advanced Setup > API**. Make sure your Customer Key is listed and **API Enabled** is checked.
2. **Check the API Service is running:** **Tools > Misc Tools > Service Manager** should list **OpenDentalAPIService** as Started. Open Dental normally installs it automatically once the API is enabled. If it's missing, click **Add**, name it `OpenDentalAPIService`, choose `OpenDentalAPIService.exe`, click **Install**, enter your database connection details, click **OK**, then **Start**.
3. **Allow the office network through the server's firewall.** Right-click Start, open **Terminal (Admin)** or **PowerShell (Admin)**, and run:

   ```powershell
   New-NetFirewallRule -DisplayName "Open Dental API Service" -Direction Inbound -Protocol TCP -LocalPort 30223 -Action Allow -Profile Domain,Private
   ```

   This opens port 30223 to your **office network only** (Domain and Private network profiles). Don't set up port forwarding for 30223 on your router: the API Service is plain http and must not be reachable from the internet.
4. **Find the server's address:** in the same window run `ipconfig` and note the **IPv4 Address** (for example `192.168.1.20`). Your API URL is then `http://192.168.1.20:30223/api/v1`. A fixed (reserved) address for the server keeps this from changing.

#### Test the connection from the computer running Claude

Replace `192.168.1.20` with your server's address.

**Windows** (PowerShell):

```powershell
Test-NetConnection 192.168.1.20 -Port 30223
```

You want `TcpTestSucceeded : True`.

**Mac** (Terminal):

```bash
nc -vz 192.168.1.20 30223
```

You want `succeeded`.

If the test fails: check the API Service shows Started in Service Manager, that the firewall rule exists on the server (`Get-NetFirewallRule -DisplayName "Open Dental API Service"`), that both computers are on the same office network, and that the address is right. On the server itself, `Test-NetConnection 127.0.0.1 -Port 30223` tells you whether the service is listening at all.

Once the port answers, you can also check your keys from that computer. In PowerShell (replace both keys and the address; don't save this command anywhere):

```powershell
Invoke-RestMethod -Uri "http://192.168.1.20:30223/api/v1/providers" -Headers @{ Authorization = "ODFHIR YOUR_DEVELOPER_KEY/YOUR_CUSTOMER_KEY" } | Select-Object ProvNum, Abbr
```

A list of providers means everything works. `401` means a key is wrong or the API isn't enabled; `403` means the Customer Key lacks that permission.

### 3. Install the Claude connector and skills

Download **opendental.mcpb** and **opendental.plugin** from the [latest release](https://github.com/MULLET156/opendental-claude/releases/latest).

1. Install **opendental.mcpb** in Claude desktop on the computer you'll use, any of these ways:
   - double-click the file, or
   - drag it onto **Settings > Extensions**, or
   - **Settings > Extensions > Advanced settings > Install Extension…** and pick the file.

   (If double-clicking opens a zip tool or asks which program to use, use one of the Settings options. If you don't see Extensions, update Claude desktop.)

   Click **Install** and fill in the form: Developer Key, Customer Key, API URL, and (for the cloud URL) your API plan. Keys are stored in your system's secure storage. Leave **Allow schedule changes** and **Allow chart changes** off until you've tried it. Make sure **Open Dental** shows as enabled. To change settings later: **Settings > Extensions > Open Dental > Configure**.
2. Install **opendental.plugin** in Claude. If you use plugin marketplaces, you can instead add this repo as one: `MULLET156/opendental-claude`.
3. Start a new chat and ask Claude: **"Check my Open Dental connection."**

To try everything without real patient data, use the cloud URL with the public test keys on Open Dental's API setup page.

### 4. (Optional) Run the app gateway

See **[docs/gateway.md](docs/gateway.md)**. In short:

```bash
git clone https://github.com/MULLET156/opendental-claude.git
cd opendental-claude
cp gateway/gateway.config.example.json gateway.config.json
cp gateway/.env.example .env           # fill in your Open Dental keys
node gateway/cli.js new-key "my-app"   # prints an app key + config entry
node gateway/server.js                 # starts on http://127.0.0.1:8787
```

Then from your app's server:

```bash
curl -H "Authorization: Bearer odg_..." \
  "http://127.0.0.1:8787/v1/od/appointments?date=2026-11-13"
curl -H "Authorization: Bearer odg_..." \
  "http://127.0.0.1:8787/v1/reports/production_by_provider?from=2026-11-01&to=2026-11-30"
```

---

## Safety design

- **Read-only unless you say otherwise.** Claude's change tools refuse to run until "Allow schedule changes" or "Allow chart changes" is on, and they're marked so Claude asks before each one. Gateway apps can only call the Open Dental paths and methods listed for them.
- **Clinical records stay the dentist's.** Claude never signs notes or plans; it writes unsigned group notes and addenda (never overwriting earlier text, and Open Dental keeps every version), records only the treatment the dentist decides, and can only change or remove treatment-planned procedures, never completed ones. Group notes and plan changes are checked against the named patient before anything is written.
- **No free-form SQL by default.** Reports are a fixed catalog with type-checked parameters. Custom SQL (Claude's `od_run_query`, or gateway apps with `rawSql`) must pass a read-only check, and Open Dental's own query endpoint also screens and audit-logs it.
- **SSNs never leave the connector or gateway**; they're removed at every depth. Gateway apps can remove more fields (emails, phones, addresses).
- **Keys stay put.** Open Dental keys live in your keychain (connector) or server environment (gateway), are only ever sent to the configured Open Dental URL, and redirects are never followed. Gateway app keys are stored only as hashes.
- **Audit log.** The gateway writes one line per request: app, method, path (record numbers masked), status, row count, timing. No patient data, query values or bodies.
- **Polite to Open Dental.** Cloud requests are paced and `Retry-After` is honored with a bounded retry budget.

## HIPAA

These tools move protected health information. Read **[docs/hipaa-and-security.md](docs/hipaa-and-security.md)** before using real patient data. The short version: have a BAA with every service PHI passes through (including your Claude plan), run the gateway on your office network or a host that signs a BAA, and grant each key and app only what it needs. This is not legal advice.

## Repository layout

```
core/          shared Open Dental client, safety checks, report catalog, Claude tools, MCP protocol
extension/     Claude desktop extension (manifest + entry point)
plugin/        Claude plugin: skills for schedule, patients, billing, production
gateway/       app gateway server, config, CLI
scripts/       build.js: packs dist/opendental.mcpb and dist/opendental.plugin (no dependencies)
test/          node:test suite with a fake Open Dental server
docs/          gateway guide, HIPAA and security notes
```

## Develop

```bash
npm test         # no install needed (Node 20+)
npm run build    # writes dist/opendental.mcpb and dist/opendental.plugin
```

Contributions welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## Status

Version 0.4.0. Built from Open Dental's published API documentation and tested against a simulated Open Dental server; first runs against real offices are underway. Please open an issue if an endpoint behaves differently on your version of Open Dental. Known items to confirm:

- Request field names for appointment **Break** (`sendToUnscheduledList`) and **Confirm** (`confirmVal`).
- Report totals vs. Open Dental's built-in Daily P&I and Aging reports (write-off dating follows your Report Setup).

## Credits

Thanks to [sanjibani/open-dental-mcp](https://github.com/sanjibani/open-dental-mcp) and [MaxilloCA/open-dental-mcp](https://github.com/MaxilloCA/open-dental-mcp), whose Python MCP servers for Open Dental informed several safety checks here (no redirects, strict record IDs, bounded retries, sanitized errors).

## License

[MIT](LICENSE) © 2026 Ryan Millet
