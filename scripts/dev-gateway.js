#!/usr/bin/env node
"use strict";
/**
 * One command for module developers: a fake Open Dental (test/fake-od.js with
 * the fake office) plus a gateway in front of it, on this computer only, with
 * published test keys. Fake data only.
 *
 *   npm run dev                      (or: node scripts/dev-gateway.js)
 *   npm run dev -- --port 8788 --today 2026-11-16
 *
 * Then point a module at it:
 *   TDC_STAGE=design
 *   GATEWAY_URL=http://127.0.0.1:8787
 *   GATEWAY_KEY=<the module's test key printed below>
 */

const { startDemoGateway, TEST_KEYS } = require("../gateway/demo/demo-gateway");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  const port = Number(arg("port") || process.env.PORT || 8787);
  const today = arg("today");
  try {
    const demo = await startDemoGateway({ keys: TEST_KEYS, port, host: "127.0.0.1", today, log: !process.argv.includes("--quiet") });
    console.log(`
Demo gateway with FAKE DATA running at ${demo.url}  (this computer only)
Today in the fake office: ${demo.office().today}

Test keys (fake data only; never use them anywhere else):
${Object.entries(TEST_KEYS).map(([m, k]) => `  ${m.padEnd(9)} ${k}`).join("\n")}

Try:  curl ${demo.url}/health
      curl -H "Authorization: Bearer ${TEST_KEYS.daysheet}" "${demo.url}/v1/reports/daysheet?date=${demo.office().today}"

Press Ctrl+C to stop.`);
    const stop = () => demo.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (e) {
    console.error(`Couldn't start the demo gateway: ${e.message}`);
    process.exit(1);
  }
})();
