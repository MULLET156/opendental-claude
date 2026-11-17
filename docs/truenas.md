# Gateway on TrueNAS SCALE, reached through Tailscale Funnel

This runs the gateway on the office's TrueNAS box for the **TDC Office design stage**. The Hostinger prototype apps reach it through a **Tailscale Funnel**, and it serves Open Dental's **demo database** (no real patients). It updates itself from GitHub releases.

```
Hostinger app ──HTTPS──► Tailscale Funnel ─┐
                                           │  TrueNAS box
                         Tailscale app ◄───┘
                               │ 127.0.0.1:8787 (only inside the NAS)
                         gateway (this app)
                               │ office network, port 30223
                   Open Dental PC: API Service for the DEMO database
```

- **Nothing on your router or office firewall opens.** Tailscale connects outward.
- The traffic is encrypted all the way to the NAS. The gateway listens only on the NAS itself (`127.0.0.1`), so the Tailscale app is the only thing that can reach it.
- Every request needs that app's key, and each key can only do what its module needs. The gateway's `/health` says `"stage": "design"`; the Hostinger apps refuse to show patient pages if it ever says anything else.
- The **lab tracker sync stays on the Open Dental PC's gateway**, with the real database. This TrueNAS gateway is a separate one for the design stage.

You need:
- TrueNAS SCALE **24.10 (Electric Eel) or newer**, which has Docker apps with "Install via YAML".
- A free Tailscale account.
- The address and API keys for the Open Dental **demo database's** API Service.

## 1. A folder for the gateway

In TrueNAS: **Datasets** → pick your apps pool → **Add Dataset**.
- Name: `opendental-gateway`
- Dataset Preset: **Apps**

Note its path, for example `/mnt/tank/apps/opendental-gateway`. Below, `/mnt/POOL/...` means that path.

## 2. Make the settings

Open **System → Shell** and run (one line, with your path):

```sh
sudo docker run --rm --user 568:568 -v /mnt/POOL/apps/opendental-gateway:/config ghcr.io/mullet156/opendental-gateway:latest node gateway/cli.js init /config --stage design
```

This writes three files in the folder:
- `gateway.config.json`: design stage, listening only on the NAS, a key for each module (daysheet, finder, voice, numbers) with only the permissions that module needs.
- `.env`: the Open Dental settings for you to fill in.
- `module-keys.txt`: the module keys, for step 6. Only the owner can read it.

Then fill in the Open Dental settings:

```sh
sudo nano /mnt/POOL/apps/opendental-gateway/.env
```

```
OD_BASE_URL=http://<Open Dental PC address>:30223/api/v1
OD_DEVELOPER_KEY=<developer key>
OD_CUSTOMER_KEY=<customer key for the DEMO database>
```

Save with **Ctrl+O, Enter**, then exit with **Ctrl+X**. Use the demo database's API Service and keys, never the real one's.

On the **Open Dental PC**, allow only the NAS to reach the API Service. In **Terminal (Admin)**, with your NAS's address:

```powershell
New-NetFirewallRule -DisplayName "Open Dental API from TrueNAS" -Direction Inbound -Protocol TCP -LocalPort 30223 -RemoteAddress <NAS address> -Action Allow
```

## 3. Install the gateway app

In TrueNAS: **Apps → Discover Apps → ⋮ (top right) → Install via YAML**. Name it `opendental-gateway`, and paste [`gateway/truenas/compose.yaml`](../gateway/truenas/compose.yaml), with the `volumes` line changed to your folder:

```yaml
services:
  opendental-gateway:
    image: ghcr.io/mullet156/opendental-gateway:latest
    restart: unless-stopped
    network_mode: host
    user: "568:568"
    environment:
      TZ: America/Los_Angeles
      AUTO_UPDATE: "on"
      UPDATE_HOUR: "3"
    volumes:
      - /mnt/POOL/apps/opendental-gateway:/config
```

Click **Save**. When the app shows **Running**, open its logs. You should see `starting gateway v…` and `listening on http://127.0.0.1:8787`.

## 4. Install Tailscale and turn on Funnel

1. In the [Tailscale admin console](https://login.tailscale.com/admin):
   - **DNS**: turn on **MagicDNS** and **HTTPS Certificates**.
   - **Settings → Keys → Generate auth key**. Copy it.
2. In TrueNAS: **Apps → Discover Apps → Tailscale → Install**.
   - Auth key: paste it.
   - Hostname: `od-gateway`. This name becomes public in the web address, so keep it plain.
   - If there's a **Host Network** box, tick it. The gateway is only on the NAS's `127.0.0.1`, which the Tailscale app can reach only on the host network.
3. Back in **System → Shell**, find the Tailscale container's name and turn on Funnel:

   ```sh
   sudo docker ps --format '{{.Names}}' | grep -i tailscale
   sudo docker exec <that name> tailscale funnel --bg http://127.0.0.1:8787
   ```

   The first time, it may print a link to allow Funnel for your tailnet. Open it, approve, and run the command again. It prints the address, like `https://od-gateway.<your-tailnet>.ts.net`.

## 5. Check it

Open `https://od-gateway.<your-tailnet>.ts.net/health` in a browser. You should see:

```json
{"ok":true,"service":"opendental-gateway","version":"…","stage":"design","fake":false}
```

Anything else under that address needs a key; without one, you'll see "Missing or invalid app key".

## 6. Give each Hostinger app its settings

```sh
sudo cat /mnt/POOL/apps/opendental-gateway/module-keys.txt
```

In each module's Hostinger app, set these environment variables:

| Name | Value |
|---|---|
| `TDC_STAGE` | `design` |
| `GATEWAY_URL` | `https://od-gateway.<your-tailnet>.ts.net` |
| `GATEWAY_KEY` | that module's key from `module-keys.txt` |

Then delete the file:

```sh
sudo rm /mnt/POOL/apps/opendental-gateway/module-keys.txt
```

To replace a key later (for example if one leaks), run the command in step 2 again with `--force` at the end. That makes new keys for every module, so update all the apps.

## Updates

You don't do anything. Once a day at 3 am (`UPDATE_HOUR`), the gateway checks GitHub for a newer **regular release**. Test builds and unreleased changes are never installed, and a release only exists after the tests pass. When it finds one:

1. It downloads it into `code/<version>` in your folder and checks it against the release's published checksums.
2. It makes sure the new version accepts your settings.
3. It switches over, and then confirms `/health` answers with the new version within a minute.
4. If anything fails, it goes back to the version that was working and never tries that version again. The app log says what happened.

To stay on one version, set `AUTO_UPDATE` to `"off"` in the app's YAML. To roll back by hand, set the image to a version, like `ghcr.io/mullet156/opendental-gateway:0.11.0`, with `AUTO_UPDATE: "off"`, and delete the `code` folder.

## Turning it off later

- **Stop sharing it:** `sudo docker exec <tailscale name> tailscale funnel --https=443 off`. Or stop the Tailscale app.
- **Stop the gateway:** stop or delete the `opendental-gateway` app. The settings stay in the folder.
- Remove the Open Dental PC's firewall rule: `Remove-NetFirewallRule -DisplayName "Open Dental API from TrueNAS"`.

## Troubleshooting

| What you see | What to do |
|---|---|
| App log: `Set OD_DEVELOPER_KEY and OD_CUSTOMER_KEY` | Fill in `.env` (step 2), then restart the app. |
| App log: `Could not reach Open Dental at …` | Check `OD_BASE_URL`, that the demo database's API Service is running, and the firewall rule on the Open Dental PC. |
| `/health` doesn't open | Check the Tailscale app is running and run the `tailscale funnel --bg …` command again. |
| A Hostinger app says the stage doesn't match | `/health` must say `"stage":"design"`. Check `gateway.config.json` has `"stage": "design"`. |
| `Too many wrong app keys from this address` | An app is using an old or mistyped key. That address waits 15 minutes; fix the key in that app. |
| App log: `update check failed` | Usually a temporary GitHub problem; it tries again the next day. The running version keeps working. |
