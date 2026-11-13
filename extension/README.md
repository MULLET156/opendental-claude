# Open Dental connector for Claude

Lets Claude read your Open Dental schedule, patients, A/R, claims and production through Open Dental's official API, and (only if you turn on "Allow changes") book, move, confirm or break appointments and add notes after you approve each one.

Settings (Claude > Settings > Extensions > Open Dental):

- **Developer Key / Customer Key**: from Open Dental's Developer Portal; stored in your system keychain.
- **API URL**: `http://<Open Dental server IP>:30223/api/v1` in the office (API Service), or `https://api.opendental.com/api/v1` (cloud, needs the eConnector).
- **Allow changes**: off by default.

Full documentation: https://github.com/MULLET156/opendental-claude

Independent project; not affiliated with or endorsed by Open Dental Software, Inc.
