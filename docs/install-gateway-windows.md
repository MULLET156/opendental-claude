# Install the gateway on the office server (Windows)

This installs the gateway on the **Open Dental server** (or another office computer that's always on) and runs it in the background at startup, with the [lab tracker sync](lab-tracker-sync.md) if you use it.

You need:

- Administrator access to the office server.
- Your Open Dental **Developer Key** and **Customer Key**, with the API Service working (see the [README](../README.md#set-up-the-api-service-in-the-office-one-time)).
- For the lab sync: the tracker's address (ending in `/od-sync.php`) and access to its files on your web host (for example Hostinger's File Manager).

## Easy way: Setup (about 10 minutes)

1. Download **opendental-gateway-windows-&lt;version&gt;.zip** (for example `opendental-gateway-windows-0.8.0.zip`) from the [latest release](https://github.com/MULLET156/opendental-claude/releases/latest) onto the office server. Setup shows the version it installs.
2. Right-click it → **Extract All**.
3. In the extracted folder, double-click **Setup.cmd**.
   - If Windows shows **"Windows protected your PC"**, click **More info → Run anyway** (the script isn't code-signed).
   - Click **Yes** when Windows asks for administrator permission.
4. Answer the questions:
   - **API address**: press Enter for the default on the Open Dental server.
   - **Developer Key** and **Customer Key**: a small window opens for each. Paste the key (Ctrl+V or right-click → Paste), tick **Show** if you want to check it, and click **OK**. Setup tests them right away.
   - **Lab tracker sync**: answer **y**, then the tracker address, your in-house lab number(s) (Setup lists your labs), the start date and how patients appear (J. Smith or J.S.).
   - Setup shows a line like `define('OD_SYNC_SECRET', '…');` and copies it to the clipboard. Paste it into the tracker's `config.php` on your web host, save, then press Enter.
   - It shows a **preview** of what would be sent (nothing is sent yet), then offers to send once to check the tracker answers.
5. Setup starts the gateway and sets it to start with Windows. You're done.

What Setup does:

- Installs into `C:\OpenDentalGateway`: the gateway in `app`, its own copy of Node.js in `node` (downloaded from nodejs.org and checked against the published checksums; nothing else on the computer changes), and your settings and logs in `data`.
- Saves the keys in `data\.env`, readable only by administrators.
- Creates the **Open Dental Gateway** task in Task Scheduler (runs at startup as SYSTEM, restarts if it stops).

Later:

- **Change settings:** double-click `C:\OpenDentalGateway\Setup.cmd`.
- **Update:** download the newer zip, extract it and run its `Setup.cmd`; answer **Y** to "Keep all current settings".
- **Logs:** `C:\OpenDentalGateway\data\logs\gateway.log`, plus `audit-<date>.jsonl` (counts only, no patient data).
- **Remove:** in an admin PowerShell, `powershell -ExecutionPolicy Bypass -File C:\OpenDentalGateway\app\gateway\windows\setup.ps1 -Uninstall`.

If something goes wrong, Setup says what and stops without changing anything in Open Dental; fix it and run Setup again. The [troubleshooting table](#troubleshooting) explains the common messages.

## Manual install

Use this if you'd rather install with Git, for example to follow the repository directly. Allow about 30 minutes, and run every command in **PowerShell as administrator** (right-click Start → **Terminal (Admin)**).

### 1. Install Node.js and Git

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Close the window and open a new **Terminal (Admin)** so the new programs are found, then check:

```powershell
node -v
git --version
```

`node -v` must show **v20** or newer. (Without winget: install the LTS version from [nodejs.org](https://nodejs.org) and Git from [git-scm.com](https://git-scm.com).)

### 2. Download the gateway

```powershell
git clone https://github.com/MULLET156/opendental-claude.git C:\OpenDentalGateway
cd C:\OpenDentalGateway
mkdir logs
Copy-Item gateway\gateway.config.example.json gateway.config.json
Copy-Item gateway\.env.example .env
```

The gateway has no other dependencies; there is no `npm install` step.

### 3. Add the Open Dental keys

```powershell
notepad .env
```

Fill in your keys and the API address, then save:

```
OD_DEVELOPER_KEY=your developer key
OD_CUSTOMER_KEY=your customer key
OD_BASE_URL=http://127.0.0.1:30223/api/v1
```

Use `127.0.0.1` when the gateway runs on the Open Dental server itself; otherwise use the server's address, e.g. `http://192.168.1.20:30223/api/v1`.

Then let only administrators read the file:

```powershell
icacls .env /inheritance:r /grant:r "Administrators:F" "SYSTEM:F"
```

Never email `.env`, paste it into a chat, or commit it to GitHub.

### 4. Connect the lab tracker

1. **Make the shared secret:**

   ```powershell
   node gateway\cli.js new-secret
   ```

2. **Put it in the gateway.** `notepad .env` and fill in the last line:

   ```
   LAB_SYNC_SECRET=the 64-character secret
   ```

3. **Put the same secret in the tracker.** On your web host, open the tracker's `config.php` (Hostinger: **Websites → Manage → File Manager**, in the tracker's folder) and add:

   ```php
   define('OD_SYNC_SECRET', 'the same 64-character secret');
   ```

   The tracker must include `od-sync.php` (from the TDC Lab Tracker repository).

4. **Find your in-house lab's number.** Ask Claude "list our labs", or in Open Dental look under **Lists → Laboratories**. Note the number of your own lab (for example `1`).

5. **Edit the settings:**

   ```powershell
   notepad gateway.config.json
   ```

   - Change `"apps": [ … ]` to `"apps": []` (the examples have placeholder keys; add real apps later in step 7).
   - In `"labSync"`, set:

     ```json
     "labSync": {
       "enabled": true,
       "trackerUrl": "https://your-tracker-address/od-sync.php",
       "syncFrom": "2026-11-16",
       "inHouseLabs": [1],
       "intervalMinutes": 5,
       "keepDays": 30,
       "patientFormat": "initial-last",
       "readyNote": "Lab case ready to deliver"
     }
     ```

     `syncFrom` is the first day whose new lab cases should go to the tracker; use the day you turn it on. All settings are explained in [lab-tracker-sync.md](lab-tracker-sync.md#set-up).

### 5. Test it

```powershell
node gateway\cli.js check
node gateway\cli.js lab-sync --dry-run
node gateway\cli.js lab-sync
```

- `check` should say `Config OK`.
- `--dry-run` reads Open Dental and sends **nothing**. It shows how many cases would be sent and a sample, so you can confirm the patient shows as "J. Smith" and nothing else is included. `cases: 0` is normal if no lab cases were created since `syncFrom`.
- The last command does one real round. Open the tracker: cases created since `syncFrom` should appear, tagged **OD**.

If something fails, see [Troubleshooting](#troubleshooting).

### 6. Run it at startup

This creates a scheduled task that starts the gateway when the server boots, runs it without anyone logged in, and restarts it if it stops:

```powershell
$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c node gateway\server.js gateway.config.json >> logs\gateway.log 2>&1' -WorkingDirectory "C:\OpenDentalGateway"
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName "Open Dental Gateway" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest
Start-ScheduledTask -TaskName "Open Dental Gateway"
```

Check it started:

```powershell
Get-ScheduledTask -TaskName "Open Dental Gateway" | Select-Object State
Get-Content logs\gateway.log -Tail 10
```

`State` should be **Running**, and the log should show `Lab tracker sync: every 5 min to …`. Each sync round is also recorded in `logs\audit-<date>.jsonl` (app `lab-sync`; counts only, no patient data).

To stop, start or remove it:

```powershell
Stop-ScheduledTask  -TaskName "Open Dental Gateway"
Start-ScheduledTask -TaskName "Open Dental Gateway"
Unregister-ScheduledTask -TaskName "Open Dental Gateway"
```

After changing `.env` or `gateway.config.json`, stop and start the task.

### 7. (Optional) Add your own apps

The gateway listens on `127.0.0.1:8787`, so only programs on the server can call it. For each app:

```powershell
node gateway\cli.js new-key "app-name"
```

It prints the app key once (store it in that app's server-side settings) and an entry to paste into `"apps"` in `gateway.config.json`. To let other office computers reach the gateway, set `"listen": { "host": "0.0.0.0", "port": 8787 }` and allow the office network through the firewall:

```powershell
New-NetFirewallRule -DisplayName "Open Dental Gateway" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Domain,Private
```

Don't port-forward 8787 on your router. See [gateway.md](gateway.md) for permissions, reports and the API.

The lab sync needs **no** open ports: the gateway only makes outgoing HTTPS requests to the tracker.

### Updating a manual install

```powershell
cd C:\OpenDentalGateway
Stop-ScheduledTask -TaskName "Open Dental Gateway"
git pull
node gateway\cli.js check
Start-ScheduledTask -TaskName "Open Dental Gateway"
```

Your `.env`, `gateway.config.json` and `logs` are not touched by updates.

## Troubleshooting

| Message | Fix |
|---|---|
| `'node' is not recognized` | Open a new Terminal window after installing Node.js. |
| `Set OD_DEVELOPER_KEY and OD_CUSTOMER_KEY` | `.env` must be in `C:\OpenDentalGateway`, next to `gateway.config.json`. |
| `Open Dental … 401` | A key is wrong, or the Customer Key isn't enabled in **Setup → Advanced Setup → API**. |
| `Open Dental … 403` | The Customer Key lacks a permission: the sync needs Queries and write access to lab cases and appointments. |
| Can't connect to Open Dental | The API Service isn't running: **Tools → Misc Tools → Service Manager**. |
| `LAB_SYNC_SECRET` must be at least 32 characters | The secret line in `.env` is empty or cut off. |
| `401 bad_signature` | The secret in `.env` and `config.php` don't match exactly. |
| `401 stale` | The server's clock is more than 5 minutes off: **Settings → Time & language → Sync now**. |
| `503 not_configured` | `OD_SYNC_SECRET` isn't in the tracker's `config.php`. |
| `404` from the tracker | `trackerUrl` is wrong, or `od-sync.php` isn't on the web host. |
| Task shows **Ready**, not Running | Look at `logs\gateway.log` for the error, fix it, then `Start-ScheduledTask`. |
