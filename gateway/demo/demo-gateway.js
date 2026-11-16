"use strict";
/**
 * The demo gateway: the real gateway code in front of a fake Open Dental
 * (test/fake-od.js serving the fake office). /health says "fake": true, which
 * TDC Office modules require in the design stage.
 *
 * It never talks to real Open Dental: it refuses to start when Open Dental keys
 * are present in its environment, and its Open Dental address is always the
 * fake one it starts itself on 127.0.0.1.
 *
 * The fake office is rebuilt each day (so "today" always has a schedule);
 * anything a module wrote is forgotten then, or when the demo restarts.
 */

const http = require("node:http");
const { startFakeOD } = require("../../test/fake-od");
const { createClient } = require("../../core/odclient");
const { validateConfig, hashKey } = require("../config");
const { createGateway } = require("../app");
const { presetApp } = require("../presets");
const { buildOffice, localToday } = require("./fake-office");
const { createFakeApi } = require("./fake-api");
const { fakeReportRows } = require("./fake-reports");
const { version } = require("../../package.json");

/** Published test keys for `npm run dev`. Loopback only; the Hostinger demo refuses them. */
const TEST_KEYS = {
  daysheet: "odg_test_daysheet_key_0001",
  finder: "odg_test_finder_key_0002",
  voice: "odg_test_voice_key_0003",
  numbers: "odg_test_numbers_key_0004",
  dev: "odg_test_dev_key_0005",
};

/**
 * @param {object} opts
 * @param {Object<string,string>} opts.keys  { presetName: appKey } — which modules may connect.
 * @param {number} [opts.port=8787]
 * @param {string} [opts.host="127.0.0.1"]
 * @param {string} [opts.today]              Fix "today" (yyyy-MM-dd); default: the real date, rebuilt daily.
 * @param {number} [opts.seed=7]
 * @param {boolean} [opts.log=true]          Audit lines to the console (no patient data).
 */
async function startDemoGateway({ keys, port = 8787, host = "127.0.0.1", today, seed = 7, log = true } = {}) {
  if (process.env.OD_DEVELOPER_KEY || process.env.OD_CUSTOMER_KEY) {
    throw new Error("The demo gateway never talks to real Open Dental. Remove OD_DEVELOPER_KEY and OD_CUSTOMER_KEY from its settings.");
  }
  const entries = Object.entries(keys || {}).filter(([, k]) => k);
  if (!entries.length) throw new Error("Give the demo gateway at least one module key.");

  const holder = { office: buildOffice({ today: today || localToday(), seed }) };
  const fresh = () => {
    if (!today && holder.office.today !== localToday()) holder.office = buildOffice({ today: localToday(), seed });
    return holder.office;
  };

  const fakeOd = await startFakeOD({ onRequest: (rec) => createFakeApi(fresh())(rec) });
  const client = createClient({ baseUrl: fakeOd.url, developerKey: "demoDeveloperKey", customerKey: "demoCustomerKey", maxRows: 5000 });
  const od = { ...client, fakeReportRows: (name, params, opt) => fakeReportRows(fresh(), name, params, opt) };

  const config = validateConfig({
    listen: { host, port: port || 8787 }, // (port 0 = any free port, for tests)
    auditLogDir: null,
    maxRows: 5000,
    apps: entries.map(([preset, key]) => presetApp(preset, preset, hashKey(key))),
  });
  const handler = createGateway({ config, od, version, fake: true });
  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => {
      if (log) console.log(JSON.stringify({ ts: new Date().toISOString(), method: req.method, path: req.url.split("?")[0].replace(/\/\d+(?=\/|$)/g, "/{id}"), status: res.statusCode, ms: Date.now() - started }));
    });
    handler(req, res);
  });
  server.headersTimeout = 30000;
  server.requestTimeout = 120000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actual}`,
    port: actual,
    office: () => fresh(),
    modules: entries.map(([k]) => k),
    close: async () => {
      await new Promise((r) => server.close(r));
      await fakeOd.close();
    },
  };
}

module.exports = { startDemoGateway, TEST_KEYS };
