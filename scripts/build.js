#!/usr/bin/env node
"use strict";
/**
 * Build the installable files into dist/ with no npm dependencies:
 *   dist/opendental.mcpb    Claude desktop extension (the connector)
 *   dist/opendental.plugin  Claude plugin (the skills)
 *   dist/opendental-gateway-windows-<version>.zip  app gateway with the Windows setup
 *
 *   node scripts/build.js
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

// ------------------------------------------------------------------ tiny zip writer

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{ name: "dir/file.txt", data: Buffer }] -> Buffer */
function zip(entries) {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed date keeps builds reproducible
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix, v3.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ------------------------------------------------------------------ helpers

function walk(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name === ".DS_Store" || ent.name === "node_modules") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full, base));
    else out.push({ name: path.relative(base, full).split(path.sep).join("/"), data: fs.readFileSync(full) });
  }
  return out;
}

const read = (p) => fs.readFileSync(path.join(ROOT, p));

// ------------------------------------------------------------------ build

function buildExtension() {
  const manifest = JSON.parse(read("extension/manifest.json"));
  const pkg = JSON.parse(read("package.json"));
  if (manifest.version !== pkg.version) {
    throw new Error(`Version mismatch: extension/manifest.json ${manifest.version} vs package.json ${pkg.version}`);
  }
  const entries = [
    { name: "manifest.json", data: read("extension/manifest.json") },
    { name: "server/index.js", data: read("extension/server/index.js") },
    ...["odclient.js", "reports.js", "tools.js", "clinical-tools.js", "lab-tools.js", "mcp-stdio.js"].map((f) => ({ name: `server/core/${f}`, data: read(`core/${f}`) })),
    { name: "README.md", data: read("extension/README.md") },
    { name: "LICENSE", data: read("LICENSE") },
  ];
  if (fs.existsSync(path.join(ROOT, "extension/icon.png"))) entries.push({ name: "icon.png", data: read("extension/icon.png") });
  return zip(entries);
}

function buildPlugin() {
  const manifest = JSON.parse(read("plugin/.claude-plugin/plugin.json"));
  const pkg = JSON.parse(read("package.json"));
  if (manifest.version !== pkg.version) {
    throw new Error(`Version mismatch: plugin.json ${manifest.version} vs package.json ${pkg.version}`);
  }
  return zip(walk(path.join(ROOT, "plugin")));
}

const WINDOWS_README = `Open Dental Gateway for Windows
==============================

1. Extract this whole zip (right-click > Extract All).
2. Optional but easiest: open settings.txt in Notepad, fill in your Open Dental
   keys (and the lab tracker settings if you use it), and save. Setup then uses
   those answers instead of asking, and blanks the keys out of the file once
   they're saved securely.
3. Double-click Setup.cmd. Windows asks for administrator permission; if it shows
   "Windows protected your PC", click More info > Run anyway.

Setup downloads Node.js (checked against nodejs.org's checksums) into the install
folder (C:\\OpenDentalGateway), tests your Open Dental keys, can set up the lab
tracker sync, and starts the gateway in the background with Windows.
To change settings later, edit C:\\OpenDentalGateway\\settings.txt and run
C:\\OpenDentalGateway\\Setup.cmd. To update, download the newer zip and run its
Setup.cmd; your keys and settings are kept.

Guide: https://github.com/MULLET156/opendental-claude/blob/main/docs/install-gateway-windows.md
`;

/** The Windows download's file name carries the gateway version, e.g. opendental-gateway-windows-0.8.0.zip. */
function gatewayZipName() {
  return `opendental-gateway-windows-${JSON.parse(read("package.json")).version}.zip`;
}

/** Windows download: Setup.cmd + README.txt at the top, the gateway under app/. */
function buildGatewayWindows() {
  const crlf = (b) => Buffer.from(b.toString("utf8").replace(/\r?\n/g, "\r\n"), "utf8");
  const entries = [
    { name: "Setup.cmd", data: crlf(read("gateway/windows/Setup.cmd")) },
    { name: "README.txt", data: crlf(Buffer.from(WINDOWS_README)) },
    { name: "settings.txt", data: crlf(read("gateway/windows/settings.txt")) },
    { name: "app/package.json", data: read("package.json") },
    { name: "app/LICENSE", data: read("LICENSE") },
    ...walk(path.join(ROOT, "core")).map((e) => ({ name: `app/core/${e.name}`, data: e.data })),
    ...walk(path.join(ROOT, "gateway"))
      .filter((e) => !/(^|\/)\.env$|^gateway\.config\.json$|^logs\/|^demo\//.test(e.name)) // the demo (fake data) is not part of the office install
      .map((e) => ({ name: `app/gateway/${e.name}`, data: /\.(ps1|cmd|txt)$/.test(e.name) ? crlf(e.data) : e.data })),
  ];
  return { data: zip(entries), names: entries.map((e) => e.name) };
}

if (require.main === module) {
  fs.mkdirSync(DIST, { recursive: true });
  const ext = buildExtension();
  fs.writeFileSync(path.join(DIST, "opendental.mcpb"), ext);
  const plug = buildPlugin();
  fs.writeFileSync(path.join(DIST, "opendental.plugin"), plug);
  const win = buildGatewayWindows().data;
  const winName = gatewayZipName();
  for (const old of fs.readdirSync(DIST)) if (/^opendental-gateway-windows.*\.zip$/.test(old)) fs.rmSync(path.join(DIST, old));
  fs.writeFileSync(path.join(DIST, winName), win);
  console.log(`dist/opendental.mcpb    ${(ext.length / 1024).toFixed(1)} KB`);
  console.log(`dist/opendental.plugin  ${(plug.length / 1024).toFixed(1)} KB`);
  console.log(`dist/${winName}  ${(win.length / 1024).toFixed(1)} KB`);
}

module.exports = { zip, crc32, buildExtension, buildPlugin, buildGatewayWindows, gatewayZipName };
