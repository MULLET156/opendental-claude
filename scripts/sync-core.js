#!/usr/bin/env node
"use strict";
/**
 * Copy opendental-claude's shared core/ code, at a released version, into a
 * TDC Office module repo as vendor/opendental-core/ (CONTRACT.md §7).
 *
 * Copy this one file into your module repo as scripts/sync-core.js, then:
 *
 *   node scripts/sync-core.js 0.9.0
 *   node scripts/sync-core.js 0.9.0-test.12          (a test build, before Ryan merges)
 *   node scripts/sync-core.js 0.9.0 --from ..\opendental-claude   (from a local copy)
 *
 * It downloads the tagged version from GitHub (tag v<version>), checks that the
 * version inside matches, replaces vendor/opendental-core/ completely, and writes:
 *   VERSION      the version, e.g. 0.9.0
 *   CHECKSUMS    SHA-256 of every copied file (npm test can check nothing was edited)
 *   README.md    "don't edit these files"
 *
 * Never edit the vendored files; ask the Connector agent for changes instead.
 * Node.js 20+ built-ins only.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const REPO = "MULLET156/opendental-claude";

function usage(msg) {
  if (msg) console.error(msg + "\n");
  console.error("Usage: node scripts/sync-core.js <version> [--from <opendental-claude folder>] [--dest vendor/opendental-core]");
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Minimal tar reader (ustar, pax and GNU long names): returns [{ name, data }]. */
function untar(buf) {
  const files = [];
  let longName = null;
  let paxPath = null;
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a, b) => header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = str(156, 157) || "0";
    const prefix = str(345, 500);
    let name = (prefix ? prefix + "/" : "") + str(0, 100);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x") {
      const m = data.toString("utf8").match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === "g") continue;
    if (longName) name = longName;
    if (paxPath) name = paxPath;
    longName = null;
    paxPath = null;
    if (type === "0" || type === "\0") files.push({ name, data: Buffer.from(data) });
  }
  return files;
}

/** Files to vendor, keyed by their path relative to the repo root. */
async function fromGitHub(version) {
  const tag = `v${version}`;
  const url = `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${encodeURIComponent(tag)}`;
  console.log(`Downloading ${REPO} ${tag} ...`);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw new Error(`Couldn't reach GitHub (${(e.cause && e.cause.code) || e.message}). Check the internet connection, or use --from with a local copy.`);
  }
  if (res.status === 404) throw new Error(`There's no release tagged ${tag} on GitHub. Check the version on ${REPO}'s Releases page.`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${tag}.`);
  const files = untar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
  const out = new Map();
  for (const f of files) {
    const rel = f.name.split("/").slice(1).join("/"); // drop "opendental-claude-0.9.0/"
    if (rel) out.set(rel, f.data);
  }
  return out;
}

function fromFolder(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(path.join(root, "core"))) throw new Error(`${root} doesn't look like opendental-claude (no core folder).`);
  const out = new Map();
  for (const name of fs.readdirSync(path.join(root, "core"))) {
    const full = path.join(root, "core", name);
    if (fs.statSync(full).isFile()) out.set(`core/${name}`, fs.readFileSync(full));
  }
  for (const name of ["package.json", "LICENSE"]) if (fs.existsSync(path.join(root, name))) out.set(name, fs.readFileSync(path.join(root, name)));
  return out;
}

async function main() {
  let version = process.argv[2];
  if (!version || version.startsWith("--")) usage("Give the opendental-claude version to copy, e.g. 0.9.0.");
  version = version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-test\.\d+)?$/.test(version)) usage(`"${version}" isn't a version like 0.9.0 or 0.9.0-test.12.`);
  const dest = path.resolve(arg("dest") || path.join("vendor", "opendental-core"));
  const from = arg("from");

  const files = from ? fromFolder(from) : await fromGitHub(version);
  const pkg = files.get("package.json");
  if (!pkg) throw new Error("The download has no package.json; is this the right repository?");
  const inside = JSON.parse(pkg.toString("utf8")).version;
  if (inside !== version.replace(/-test\.\d+$/, "")) {
    throw new Error(`Version mismatch: asked for ${version}, but that copy says ${inside}.${from ? " Use the version from its package.json, or pull the right branch." : ""}`);
  }
  const core = [...files.keys()].filter((k) => /^core\/[A-Za-z0-9_.-]+\.js$/.test(k)).sort();
  if (!core.length) throw new Error("No core/*.js files found.");

  // Replace the folder completely, but only if it's empty or one we made before.
  if (fs.existsSync(dest)) {
    const existing = fs.readdirSync(dest);
    if (existing.length && !existing.includes("VERSION")) throw new Error(`${dest} has files but no VERSION; not touching it. Move it away first.`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });

  const sums = [];
  for (const rel of core) {
    const name = rel.slice("core/".length);
    fs.writeFileSync(path.join(dest, name), files.get(rel));
    sums.push(`${crypto.createHash("sha256").update(files.get(rel)).digest("hex")}  ${name}`);
  }
  if (files.get("LICENSE")) fs.writeFileSync(path.join(dest, "LICENSE"), files.get("LICENSE"));
  fs.writeFileSync(path.join(dest, "VERSION"), version + "\n");
  fs.writeFileSync(path.join(dest, "CHECKSUMS"), sums.join("\n") + "\n");
  fs.writeFileSync(
    path.join(dest, "README.md"),
    `# opendental-core ${version}\n\nCopied from [${REPO}](https://github.com/${REPO}) \`core/\` by \`scripts/sync-core.js\`.\n\n**Don't edit these files.** To update: \`node scripts/sync-core.js <version>\`. For changes, ask the Connector agent (open an issue in ${REPO}).\n\nUse it like:\n\n\`\`\`js\nconst { createClient } = require("./vendor/opendental-core/odclient");\nconst { checkStage } = require("./vendor/opendental-core/gateway-client");\nconst od = createClient({ gatewayUrl: process.env.GATEWAY_URL, gatewayKey: process.env.GATEWAY_KEY });\nawait checkStage(od, process.env.TDC_STAGE); // refuses to start in design unless the gateway is fake\nconst { rows } = await od.runReport("daysheet", { date: "2026-11-16" });\n\`\`\`\n`
  );
  console.log(`Copied opendental-core ${version} (${core.length} files) to ${path.relative(process.cwd(), dest) || dest}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`sync-core: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { untar };
