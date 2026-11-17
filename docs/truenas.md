# Gateway on TrueNAS SCALE, reached through a Cloudflare Tunnel

This runs the gateway on the office's TrueNAS box for the **TDC Office design stage**. The Hostinger prototype apps reach it through a **Cloudflare Tunnel** at an address like `https://od-gateway.toledodentalcare.com`, and it serves Open Dental's **demo database** (no real patients). It updates itself from GitHub releases.

```
Hostinger app ──HTTPS──► Cloudflare ──tunnel──┐
                                              │  TrueNAS box
                            cloudflared app ◄─┘
                               │ 127.0.0.1:8787 (only inside the NAS)
                         gateway (this app)
                               │ office network, port 30223
                   Open Dental PC: API Service for the DEMO database
```

- **Nothing on your router or office firewall opens.** The `cloudflared` app connects outward to Cloudflare.
- The gateway listens only on the NAS itself (`127.0.0.1`), so the tunnel is the only way in. Cloudflare decrypts and re-encrypts the traffic in the middle; that's fine for the demo database, and it's one reason the real database stays on the Open Dental PC.
- Every request needs that app's key, and each key can only do what its module needs. The gateway's `/health` says `"stage": "design"`; the Hostinger apps refuse to show patient pages if it ever says anything else.
- The **lab tracker sync stays on the Open Dental PC's gateway**, with the real database. This TrueNAS gateway is a separate one for the design stage.

You need:
- TrueNAS SCALE **24.10 (Electric Eel) or newer**, which has Docker apps with "Install via YAML".
- A free Cloudflare account, with **toledodentalcare.com's DNS moved to Cloudflare** (step 3). Your website and email keep working.
- The address and API keys for the Open Dental **demo database's** API Service.

## 1. A folder for the gateway

In TrueNAS: **Datasets** → pick your apps pool → **Add Dataset**.
- Name: `opendental-gateway`
- Dataset Preset: **Apps**

Note its path, for example `/mnt/tank/apps/opendental-gateway`. Below, `/mnt/POOL/...` means that path.

## 2. Make the settings

Open **System → Shell** and run (one line, with your path):

```sh
sudo docker run --rm --user 568:568 -v /mnt/POOL/apps/opendental-gateway:/config ghcr.io/mullet156/opendental-claude:latest node gateway/cli.js init /config --stage design
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

## 3. Move toledodentalcare.com's DNS to Cloudflare

Cloudflare can only make a tunnel address on a domain whose DNS it runs. Moving the DNS doesn't move your website or email: they stay where they are, and Cloudflare just answers "where is it?" instead of GoDaddy. Your domain stays registered at GoDaddy. Do this at a quiet time; it usually takes under an hour, sometimes up to a day.

1. **Write down what you have now.** In GoDaddy: **My Products → toledodentalcare.com → DNS**. Take screenshots of every record. The ones that matter most:
   - **A** and **CNAME** records for `@` and `www` (the website)
   - **MX** records (email)
   - **TXT** records (email checks like SPF `v=spf1 ...`, DKIM, DMARC, and any "verification" records)
2. **Add the site to Cloudflare.** Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a domain** → `toledodentalcare.com` → **Free** plan. Cloudflare copies your records.
3. **Check the copy against your screenshots.** Add anything missing. For the website and email records, set the cloud to **grey ("DNS only")**, so everything works exactly as before. You can turn Cloudflare's proxy on later if you want to.
4. **Turn off DNSSEC at GoDaddy**, if it's on (GoDaddy → the domain → **DNS → DNSSEC**). Leaving it on while you switch can take the domain offline.
5. **Switch the nameservers.** Cloudflare shows two nameservers (like `xxx.ns.cloudflare.com`). In GoDaddy: the domain → **DNS → Nameservers → Change → I'll use my own nameservers**, enter Cloudflare's two, and save.
6. Cloudflare emails you when the domain is **Active**. Check the website opens and send yourself a test email both ways.

## 4. Install the gateway and the tunnel

**Make the tunnel in Cloudflare:**

1. In the Cloudflare dashboard: **Networking → Tunnels → Create a tunnel** (older dashboards: **Zero Trust → Networks → Tunnels**). Choose **Cloudflared**, name it `od-gateway`.
2. It shows an install command with a long **token** after `--token`. Copy just the token. Treat it like a password: it lets anyone run your tunnel.
3. Open the tunnel's **Routes** tab (older dashboards: **Public Hostname**) → **Add route → Published application**:
   - Subdomain: `od-gateway`, Domain: `toledodentalcare.com`
   - Service URL: `http://127.0.0.1:8787`

**Install both apps in TrueNAS:** **Apps → Discover Apps → ⋮ (top right) → Install via YAML**. Name it `opendental-gateway`, and paste [`gateway/truenas/compose.yaml`](../gateway/truenas/compose.yaml) with two changes: your folder on the `volumes` line, and your token after `TUNNEL_TOKEN`:

```yaml
services:
  opendental-gateway:
    image: ghcr.io/mullet156/opendental-claude:latest
    restart: unless-stopped
    network_mode: host
    user: "568:568"
    environment:
      TZ: America/Los_Angeles
      AUTO_UPDATE: "on"
      UPDATE_HOUR: "3"
    volumes:
      - /mnt/POOL/apps/opendental-gateway:/config

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    network_mode: host
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: "paste-your-tunnel-token-here"
```

Click **Save**. When the app shows **Running**, open its logs:
- the gateway: `starting gateway v…` and `listening on http://127.0.0.1:8787`
- cloudflared: `Registered tunnel connection` (four times is normal)

In Cloudflare, the tunnel now shows **Healthy**.

(TrueNAS also has a **Cloudflared** app in Discover Apps. It works too, as long as it uses the host network; the YAML above keeps both in one place.)

## 5. Check it

Open `https://od-gateway.toledodentalcare.com/health` in a browser. You should see:

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
| `GATEWAY_URL` | `https://od-gateway.toledodentalcare.com` |
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

The `cloudflared` app updates when you pull its newer image in TrueNAS (**Apps → opendental-gateway → Update**, when offered).

To stay on one version, set `AUTO_UPDATE` to `"off"` in the app's YAML. To roll back by hand, set the image to a version, like `ghcr.io/mullet156/opendental-claude:0.11.0`, with `AUTO_UPDATE: "off"`, and delete the `code` folder.

## Turning it off later

- **Stop sharing it:** in Cloudflare, delete the route (or the whole tunnel). Or stop the app in TrueNAS.
- **Stop the gateway:** stop or delete the `opendental-gateway` app. The settings stay in the folder.
- Remove the Open Dental PC's firewall rule: `Remove-NetFirewallRule -DisplayName "Open Dental API from TrueNAS"`.
- The DNS can stay at Cloudflare; it costs nothing.

## Troubleshooting

| What you see | What to do |
|---|---|
| App log: `Set OD_DEVELOPER_KEY and OD_CUSTOMER_KEY` | Fill in `.env` (step 2), then restart the app. |
| App log: `Could not reach Open Dental at …` | Check `OD_BASE_URL`, that the demo database's API Service is running, and the firewall rule on the Open Dental PC. |
| `/health` doesn't open, or shows a Cloudflare error page (502, 1033) | Check the tunnel says **Healthy** in Cloudflare and the cloudflared log shows `Registered tunnel connection`. Check the route's Service URL is exactly `http://127.0.0.1:8787` and the gateway app is running. |
| The address doesn't exist at all | The domain isn't **Active** in Cloudflare yet, or the route is missing. |
| Website or email stopped after the DNS move | Compare Cloudflare's DNS records with your GoDaddy screenshots and add what's missing (as **DNS only**). |
| A Hostinger app says the stage doesn't match | `/health` must say `"stage":"design"`. Check `gateway.config.json` has `"stage": "design"`. |
| `Too many wrong app keys from this address` | An app is using an old or mistyped key. That address waits 15 minutes; fix the key in that app. |
| App log: `update check failed` | Usually a temporary GitHub problem; it tries again the next day. The running version keeps working. |
