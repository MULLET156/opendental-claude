# Contributing

Thanks for helping. A few ground rules keep this safe for practices that rely on it:

1. **No real patient data** anywhere: issues, tests, fixtures, screenshots, logs. Use Open Dental's public test database or made-up records.
2. **No dependencies.** Everything runs on plain Node.js (20+) so practices can install it without a toolchain. Use Node's built-in modules.
3. **Tests for every change.** `npm test` runs the suite against a fake Open Dental server (`test/fake-od.js`). Add cases there for new endpoints.
4. **Safety first.** New Claude tools that change data must be marked as changes, refuse to run unless writes are allowed, and validate every input. New reports go in `core/reports.js` with typed parameters; never paste caller input into SQL.
5. **Keep versions in step.** `package.json`, `extension/manifest.json` and `plugin/.claude-plugin/plugin.json` share one version; `npm run build` checks this.

If Open Dental behaves differently from what the code expects on your version, an issue with the Open Dental version number, the endpoint, and the (de-identified) response shape is very helpful.
