# Working on this repository

**GitHub (`MULLET156/opendental-claude`, branch `main`) is the master copy.** Make every change here, never in a downloaded copy, a Drive copy, or a local folder. Before changing anything, get the latest `main`; if someone mentions changes made elsewhere, ask for them and merge them into `main` rather than publishing a separate version.

## Rules

- No dependencies: plain Node.js 20+, built-in modules only.
- No real patient data anywhere (code, tests, issues, logs).
- Change tools must be marked as changes (`readOnlyHint: false`), refuse to run unless their setting is on ("Allow schedule changes" → `allowWrites`, "Allow chart changes" → `allowChartChanges`), validate every input, and check targets belong to the named patient. Never sign notes or plans.
- New reports go in `core/reports.js` with typed parameters; never paste caller input into SQL.
- Keep one version number in `package.json`, `extension/manifest.json` and `plugin/.claude-plugin/plugin.json`. Add a `CHANGELOG.md` entry for every release. When adding connector tools, list them in `extension/manifest.json` `tools` too (a test checks this).

## Branches, pull requests and merging

**Merge as you go** (Ryan, 2026-11-16; see TDC-Office-Plan's CLAUDE.md): work on a short branch, open a pull request, and **merge it yourself** as soon as CI is green (Windows and Linux) and your own checks pass. Don't wait for Ryan. Merge small and often. Never push straight to `main`. Still:

- Changes that **write to Open Dental** (tools, gateway write paths, the lab sync write-back) are tested live on the test patient **PatNum 8133** (Ryan A. Millet) before merging, or Ryan does that test first.
- A change to TDC-Office-Plan's CONTRACT.md needs Ryan's OK first (open a `Contract change: ...` issue).
- `main` deploys the demo gateway on Hostinger: after merging, check its `/health` (still `"stage": "design"`, `"fake": true`) and revert the PR at once if something broke.

## Check and release

1. `npm test` (all tests must pass) and `npm run build`.
2. Push the branch and open a pull request; CI runs the tests on Windows and Linux. Merge it when green (above).
3. To publish: bump the version (a released version number is never reused), merge, then run the **Release** workflow (Actions tab or `workflow_dispatch`). It builds `opendental.mcpb`, `opendental.plugin` and the Windows gateway zip and creates the GitHub release.
4. Every gateway change you hand out gets a new version number (the Windows zip is named `opendental-gateway-windows-<version>.zip`), is pushed to its branch, and is published as a test pre-release by running the **Release** workflow on that branch, so GitHub has the same file the user has.
5. The Google Drive folder "Open Dental Claude Connector" is a copy for convenience; refresh it after a release.

## Layout

- `core/` shared client and safety checks (`odclient.js`), reports, Claude tools (`tools.js` schedule/patients/reports, `clinical-tools.js` chart notes, treatment planning, procedure status and tooth chart, `lab-tools.js` lab cases), MCP protocol.
- `extension/` Claude desktop extension; `plugin/` Claude skills; `gateway/` app API gateway; `test/` tests with a fake Open Dental server (`test/fake-od.js`).
