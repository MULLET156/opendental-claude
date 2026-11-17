"use strict";
/**
 * Minimal tar reader and writer (ustar, with pax/GNU long names on read), built-ins
 * only. Used by the self-updating runner and the release build.
 */

/** Read a tar buffer into [{ name, data }] (regular files only). */
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

/** A relative path that stays inside the folder it's extracted to, or null. */
function safeName(name) {
  const n = String(name).replace(/\\/g, "/");
  if (!n || n.startsWith("/") || /^[A-Za-z]:/.test(n)) return null;
  const parts = n.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/** Write [{ name, data }] as a ustar buffer (names up to 100 chars, or 255 with a prefix). */
function tar(entries) {
  const blocks = [];
  for (const { name, data } of entries) {
    const h = Buffer.alloc(512);
    let base = name;
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const i = name.lastIndexOf("/", 155);
      if (i < 0 || Buffer.byteLength(name.slice(i + 1)) > 100) throw new Error(`Name too long for tar: ${name}`);
      prefix = name.slice(0, i);
      base = name.slice(i + 1);
    }
    h.write(base, 0);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("14000000000\0", 136); // fixed time, so builds are reproducible
    h.write("0", 156);
    h.write("ustar\0" + "00", 257);
    h.write(prefix, 345);
    h.fill(" ", 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

module.exports = { untar, tar, safeName };
