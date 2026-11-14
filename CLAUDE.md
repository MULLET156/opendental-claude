# Working on this repository

**GitHub (`MULLET156/opendental-claude`, branch `main`) is the master copy.** Make every change here, never in a downloaded copy, a Drive copy, or a local folder. Before changing anything, get the latest `main`; if someone mentions changes made elsewhere, ask for them and merge them into `main` rather than publishing a separate version.

## Rules

- No dependencies: plain Node.js 20+, built-in modules only.
- No real patient data anywhere (code, tests, issues, logs).
- Change tools must be marked as changes (`readOnlyHint: false`), refuse to run unless their setting is on ("Allow schedule changes" → `allowWrites`, "Allow chart changes" → `allowChartChanges`), validate every input, and check targets belong to the named patient. Never sign notes or plans.
- New reports go in `core/reports.js` with typed parameters; never paste caller input into SQL.
- Keep one version number in `package.json`, `extension/manifest.json` and `plugin/.claude-plugin/plugin.json`. Add a `CHANGELOG.md` entry for every release. When adding connector tools, list them in `extension/manifest.json` `tools` too (a test checks this).

## Check and release

1. `npm test` (all tests must pass) and `npm run build`.
2. Commit to `main` and push. CI runs the tests on Windows and Linux.
3. To publish: bump the version (a released version number is never reused), push, then run the **Release** workflow (Actions tab or `workflow_dispatch`). It builds `opendental.mcpb` and `opendental.plugin` and creates the GitHub release.
4. The Google Drive folder "Open Dental Claude Connector" is a copy for convenience; refresh it after a release.

## Layout

- `core/` shared client and safety checks (`odclient.js`), reports, Claude tools (`tools.js` schedule/patients/reports, `clinical-tools.js` chart notes, treatment planning, procedure status and tooth chart, `lab-tools.js` lab cases), MCP protocol.
- `extension/` Claude desktop extension; `plugin/` Claude skills; `gateway/` app API gateway; `test/` tests with a fake Open Dental server (`test/fake-od.js`).
