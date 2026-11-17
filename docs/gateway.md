# App gateway

The gateway is a small web service that sits between **your apps** and **Open Dental**. Your apps never hold the Open Dental keys. Each app gets its own key and a list of what it may do, and every request is written to an audit log.

```
 your app (server side) ──Bearer app key──▶  gateway  ──ODFHIR office keys──▶  Open Dental API
                                              │ checks permissions
                                              │ removes SSNs
                                              └ writes audit log
```

It's a single Node.js process with no dependencies (Node 20 or newer). It can reach every Open Dental API endpoint your Customer Key's permissions allow; see the plan table in the [README](../README.md#which-open-dental-api-plan-do-i-need).

## Where to run it

The gateway handles patient data, so run it somewhere you'd be comfortable keeping PHI:

- **Recommended: on the Open Dental server or another office computer.** Point it at the API Service (`http://127.0.0.1:30223/api/v1` if it's on the same machine). Requests aren't throttled, and data never leaves your network. Apps on the office network call it directly. For apps elsewhere, use a VPN rather than opening a port to the internet.
- **A cloud server whose provider signs a BAA** (for example AWS, Microsoft Azure or Google Cloud under their BAA programs), pointed at the cloud API `https://api.opendental.com/api/v1`. Put HTTPS in front of it.
- **Avoid** shared web hosts that don't offer a BAA for anything that returns patient-level data. See [hipaa-and-security.md](hipaa-and-security.md).

## Set up

**Installing on a Windows office server?** Download **opendental-gateway-windows-&lt;version&gt;.zip** from the latest release and run **Setup.cmd**; see **[install-gateway-windows.md](install-gateway-windows.md)**.

```bash
git clone https://github.com/MULLET156/opendental-claude.git
cd opendental-claude
cp gateway/gateway.config.example.json gateway.config.json
cp gateway/.env.example .env
```

Fill in `.env`:

```
OD_DEVELOPER_KEY=...
OD_CUSTOMER_KEY=...
OD_BASE_URL=http://127.0.0.1:30223/api/v1
```

Create a key for each app:

```bash
node gateway/cli.js new-key "lab-case-tracker"
```

It prints the app key **once** (store it in that app's server-side settings) and a JSON entry to paste into the `apps` list in `gateway.config.json`. Delete the example apps, adjust permissions, then check and start:

```bash
node gateway/cli.js check
node gateway/server.js
```

`.env` and `gateway.config.json` are git-ignored. The config holds only key **hashes**, so it's safe to back up.

### Run it as a service

- **Windows (typical Open Dental server):** use Task Scheduler ("At startup", run `node.exe` with arguments `gateway\server.js C:\path\to\gateway.config.json`, start in the repo folder, run whether user is logged on or not), or a service wrapper such as NSSM.
- **Linux:** a systemd unit with `ExecStart=/usr/bin/node /opt/opendental-claude/gateway/server.js /etc/odgw/gateway.config.json` and `Restart=always`.
- **TrueNAS SCALE / Docker:** see [truenas.md](truenas.md). The image `ghcr.io/mullet156/opendental-gateway` updates itself from GitHub releases.

## Lab tracker sync

The gateway can also keep a web-hosted lab case tracker in step with Open Dental: new lab cases are pushed to the tracker, and "ready" (and "sent" for outside labs) are written back. See **[lab-tracker-sync.md](lab-tracker-sync.md)**.

## Configuration

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "tls": { "certFile": "cert.pem", "keyFile": "key.pem" },
  "trustProxy": false,
  "auditLogDir": "logs",
  "maxRows": 1000,
  "maxBodyBytes": 1048576,
  "corsOrigins": [],
  "openDental": { "plan": "standard", "minIntervalMs": null },
  "apps": [
    {
      "name": "lab-case-tracker",
      "keyHash": "sha256:…",
      "allow": [
        { "methods": ["GET"], "paths": ["/patients", "/patients/*", "/appointments"] },
        { "methods": ["POST"], "paths": ["/commlogs"] }
      ],
      "reports": ["patient_treatment_plan"],
      "rawSql": false,
      "redact": ["SSN"],
      "rateLimitPerMinute": 120,
      "maxRows": 500,
      "maxBodyBytes": 1048576,
      "disabled": false
    }
  ]
}
```

| Setting | Meaning |
|---|---|
| `listen.host` | `127.0.0.1` (default) accepts only this computer. Use `0.0.0.0` to accept the office network, and on Windows allow the port for the office network only: `New-NetFirewallRule -DisplayName "Open Dental Gateway" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Domain,Private`. |
| `tls` | Optional. Serve HTTPS directly with these PEM files (paths relative to the config). Otherwise put a reverse proxy in front. |
| `trustProxy` | Use `X-Forwarded-For` for the audit log's IP (only behind your own proxy). |
| `auditLogDir` | Folder for daily `audit-YYYY-MM-DD.jsonl` files. `null` turns logging off (not recommended). |
| `maxRows` | Ceiling on rows per response for every app. |
| `openDental.plan` | Your Open Dental API plan: `read-all` (1 request / 5 s), `standard` (1 / s) or `enterprise` (1 / 0.5 s). Paces cloud requests so Open Dental doesn't refuse them; ignored for the API Service and Local API. Env `OD_API_PLAN` overrides. |
| `openDental.minIntervalMs` | Exact spacing between Open Dental requests in milliseconds, overriding the plan (rarely needed). Env `OD_MIN_INTERVAL_MS` overrides. |
| `maxBodyBytes` | Largest request body any app may send. Default 1 MB. |
| `corsOrigins` | Browser origins allowed to call the gateway. Leave empty unless you must call it from a browser; a key in browser code can be copied by anyone who uses that page. |
| `apps[].allow` | Open Dental paths and methods the app may use through `/v1/od/…`. `*` = one path segment, `**` = anything below. Methods: GET, POST, PUT, DELETE. |
| `apps[].reports` | Built-in report names the app may run, or `["*"]`. |
| `apps[].rawSql` | Allow `POST /v1/query` (read-only SQL). Off by default. |
| `apps[].redact` | Extra fields to remove from everything this app receives (SSN-type fields are always removed). |
| `apps[].maxBodyBytes` | Larger body limit for this app, e.g. `15728640` (15 MB) for an app that uploads documents. Open Dental's document upload sends the file as base64, which is about a third larger than the file. Up to 100 MB. |
| `apps[].rateLimitPerMinute` | Per-app request limit. Default 120. |
| `apps[].disabled` | Turn an app off without deleting it. |

Each app's allow list is the real control over what it can change: **Open Dental's own user permissions and date locks don't apply to API changes.** Grant writes to Payments, Insurance, ProcedureLogs and Patients only to apps that need them.

Change the config, then restart the gateway. To revoke a key, delete or disable the app; to rotate, run `new-key` again and replace the hash.

## API

All endpoints except `/health` need `Authorization: Bearer <app key>`. Responses are JSON. Errors look like `{"error": {"code": "forbidden", "message": "…"}}`.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness check. No key needed; doesn't call Open Dental. |
| `GET /v1/me` | The calling app's name and permissions. |
| `GET /v1/reports` | Built-in reports this app may run, with parameters. |
| `GET /v1/reports/{name}?from=…&to=…` | Run a report with query-string parameters. |
| `POST /v1/reports/{name}` | Run a report: body `{"params": {"from": "2026-11-01", "to": "2026-11-30"}}`. |
| `POST /v1/query` | `{"sql": "SELECT …", "limit": 100}`. Read-only SQL, `rawSql` apps only. |
| `GET/POST/PUT/DELETE /v1/od/{path}` | Pass-through to Open Dental's API at `{path}`, if allowed. Query strings and JSON bodies are forwarded as-is, so Open Dental's [API documentation](https://www.opendental.com/site/apispecification.html) applies directly. |

Pass-through extras for GET: `all=true` follows Open Dental's paging and returns every row up to the limit; `limit=N` lowers that limit. The response headers `X-Row-Count` and `X-Truncated` tell you if rows were cut off.

Report and query responses look like:

```json
{ "report": "production_by_provider", "count": 3, "truncated": false, "rows": [ … ] }
```

Status codes: `400` bad input, `401` missing/invalid key, `403` not allowed, `404` unknown route/report, `413` body too large, `429` rate limited, `502` Open Dental unreachable or errored. Open Dental's own 4xx codes pass through.

### Built-in reports

| Name | Parameters |
|---|---|
| `production_by_provider` | from, to, clinic? |
| `production_by_day` | from, to, provider?, clinic? |
| `production_by_code` | from, to, limit? |
| `procedure_counts` | from, to, codes (e.g. `D2740,D6058`) |
| `adjustments_by_provider` | from, to |
| `writeoffs_by_provider` | from, to, basis? (`procedure` \| `payment`) |
| `patient_payments_by_provider` | from, to |
| `insurance_payments_by_provider` | from, to |
| `scheduled_production` | from, to |
| `new_patients` | from, to |
| `ar_aging` | guarantor?, min_balance?, limit? |
| `ar_aging_totals` | none |
| `outstanding_claims` | min_days?, limit? |
| `unsent_claims` | none |
| `recall_overdue` | limit? |
| `patient_recall` | patient |
| `patient_treatment_plan` | patient |
| `operatories` | none |
| `lab_cases_open` | lab?, days_ahead?, limit? |
| `lab_turnaround` | from, to |
| `lab_cases_unreceived_completed` | before?, count_only? (`true`/`false`), limit? |

Dates are `yyyy-MM-dd` and inclusive. The full catalog with SQL is in [`core/reports.js`](../core/reports.js); add your own there and send a pull request.

## Examples

**Node.js (server side):**

```js
const GATEWAY = process.env.ODGW_URL;   // e.g. http://192.168.1.20:8787
const KEY = process.env.ODGW_KEY;       // odg_...

async function od(path, init = {}) {
  const res = await fetch(GATEWAY + path, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || res.statusText);
  return body;
}

// Today's appointments
const appts = await od(`/v1/od/appointments?date=${new Date().toISOString().slice(0, 10)}`);

// Crowns milled this month, by day (for supply usage)
const crowns = await od("/v1/reports/procedure_counts?from=2026-11-01&to=2026-11-30&codes=D2740");

// Log a lab case update on the patient's chart
await od("/v1/od/commlogs", {
  method: "POST",
  body: JSON.stringify({ PatNum: 1234, Note: "Lab case #88 received", Mode_: "None" }),
});
```

**PHP:**

```php
function od_gateway(string $path, string $method = 'GET', ?array $body = null) {
    $ch = curl_init(getenv('ODGW_URL') . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . getenv('ODGW_KEY'), 'Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => $body ? json_encode($body) : null,
    ]);
    $out = json_decode(curl_exec($ch), true);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code >= 400) throw new RuntimeException($out['error']['message'] ?? "HTTP $code");
    return $out;
}

$aging = od_gateway('/v1/reports/ar_aging_totals');
```

**Python:**

```python
import os, requests
GW, KEY = os.environ["ODGW_URL"], os.environ["ODGW_KEY"]
r = requests.get(f"{GW}/v1/reports/production_by_provider",
                 params={"from": "2026-11-01", "to": "2026-11-30"},
                 headers={"Authorization": f"Bearer {KEY}"}, timeout=60)
r.raise_for_status()
print(r.json()["rows"])
```
