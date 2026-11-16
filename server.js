#!/usr/bin/env node
"use strict";
/**
 * `npm start` (and Hostinger's Node.js app) runs the DEMO gateway: fake data,
 * never real Open Dental. See gateway/demo/server.js for its settings.
 *
 * The real gateway for the office server is started by the Windows setup
 * (gateway/windows/Setup.cmd) or with: node gateway/server.js <config>
 */
require("./gateway/demo/server.js");
