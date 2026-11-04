import { zlibSync } from "fflate";
import { nextVersion } from "./version";
import { buildZip } from "./zip";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typed = new TextEncoder().encode(type);
  out.set(typed, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Solid-colour RGB PNG, used for the icons of a withdrawal build. */
export function solidPng(size: number, rgb: [number, number, number]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const row = 1 + size * 3;
  const raw = new Uint8Array(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set(rgb, y * row + 1 + x * 3);
  }
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Builds the "kill switch" successor: same name, next version, no permissions, no content
 * scripts, and a popup telling the tester the build was withdrawn. Publishing it makes Chrome
 * auto-update every installed copy to an inert extension once the Web Store approves it.
 */
export function buildWithdrawnPackage(input: { name: string; currentVersion: string }): {
  zip: Uint8Array;
  version: string;
} {
  const version = nextVersion(input.currentVersion);
  const enc = new TextEncoder();
  const manifest = {
    manifest_version: 3,
    name: input.name.slice(0, 75),
    version,
    description: "This test build has been withdrawn by its publisher. You can remove it.",
    icons: { "128": "icons/128.png" },
    action: { default_popup: "withdrawn.html", default_icon: { "128": "icons/128.png" } },
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Withdrawn</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;width:280px;color:#1f2328}h1{font-size:15px;margin:0 0 8px}</style></head>
<body><h1>This test build was withdrawn</h1><p>The publisher has ended this test. The extension no longer does anything and can be removed from chrome://extensions.</p></body></html>`;
  const files = new Map<string, Uint8Array>([
    ["manifest.json", enc.encode(JSON.stringify(manifest, null, 2))],
    ["withdrawn.html", enc.encode(html)],
    ["icons/128.png", solidPng(128, [110, 118, 129])],
  ]);
  return { zip: buildZip(files), version };
}
