import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { buildZip, extractZip, inspectPackage, listZipEntries, unsafePathReason, ZipError } from "../src";

const enc = new TextEncoder();
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifest_version: 3,
    name: "Fixture Extension",
    version: "1.2.3",
    description: "A fixture",
    icons: { "128": "icons/128.png" },
    background: { service_worker: "sw.js" },
    action: { default_popup: "popup.html" },
    ...overrides,
  };
}

function pkg(files: Record<string, string | Uint8Array>): Uint8Array {
  const m = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(files)) m.set(k, typeof v === "string" ? enc.encode(v) : v);
  return buildZip(m);
}

function validFiles(man: object = manifest()): Record<string, string | Uint8Array> {
  return {
    "manifest.json": JSON.stringify(man),
    "icons/128.png": PNG,
    "sw.js": "chrome.runtime.onInstalled.addListener(() => {});",
    "popup.html": '<!doctype html><script src="popup.js"></script>',
    "popup.js": "document.body.textContent = 'hi';",
  };
}

const codes = (r: ReturnType<typeof inspectPackage>) => r.findings.map((f) => f.code);
const errorCodes = (r: ReturnType<typeof inspectPackage>) =>
  r.findings.filter((f) => f.severity === "error").map((f) => f.code);

describe("inspectPackage: valid package", () => {
  test("accepts a complete MV3 package and reports its manifest", () => {
    const bytes = pkg(validFiles());
    const r = inspectPackage(bytes);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.manifest?.version).toBe("1.2.3");
    expect(r.fileCount).toBe(5);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hash is deterministic for identical contents", () => {
    expect(inspectPackage(pkg(validFiles())).sha256).toBe(inspectPackage(pkg(validFiles())).sha256);
  });

  test("accepts a manifest with a UTF-8 BOM", () => {
    const f = validFiles();
    f["manifest.json"] = `\uFEFF${f["manifest.json"]}`;
    expect(inspectPackage(pkg(f)).ok).toBe(true);
  });
});

describe("inspectPackage: manifest rules", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["MV2", { manifest_version: 2 }, "manifest_version"],
    ["bad version", { version: "1.02" }, "version_invalid"],
    ["5-part version", { version: "1.2.3.4.5" }, "version_invalid"],
    ["all-zero version", { version: "0.0" }, "version_invalid"],
    ["long name", { name: "x".repeat(76) }, "name_too_long"],
    ["missing name", { name: "" }, "name_missing"],
    ["long description", { description: "d".repeat(133) }, "description_too_long"],
    ["no 128 icon", { icons: { "48": "icons/128.png" } }, "icon_missing"],
    ["no icons", { icons: undefined }, "icon_missing"],
    ["MV2 background", { background: { scripts: ["sw.js"] } }, "background_mv2"],
    ["missing service worker", { background: { service_worker: "nope.js" } }, "missing_file"],
    ["remote popup", { action: { default_popup: "https://evil.example/p.html" } }, "remote_reference"],
    ["key field", { key: "MIIB..." }, "key_field"],
    ["update_url", { update_url: "https://example.com/u.xml" }, "update_url"],
    ["browser_action", { browser_action: {} }, "action_mv2"],
    ["string CSP", { content_security_policy: "script-src 'self'" }, "csp_mv2"],
    [
      "remote CSP",
      { content_security_policy: { extension_pages: "script-src 'self' https://cdn.example.com" } },
      "remote_code_csp",
    ],
    [
      "unsafe-eval CSP",
      { content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } },
      "csp_unsafe",
    ],
    ["host in permissions", { permissions: ["https://*/*"] }, "host_in_permissions"],
    ["locale missing", { default_locale: "en" }, "missing_locale"],
    ["__MSG_ name without locale", { name: "__MSG_appName__" }, "missing_locale"],
    [
      "content script file missing",
      { content_scripts: [{ matches: ["https://a.com/*"], js: ["cs.js"] }] },
      "missing_file",
    ],
    ["content script without matches", { content_scripts: [{ js: ["sw.js"] }] }, "manifest_bad_field"],
  ];
  for (const [label, override, code] of cases) {
    test(`rejects ${label}`, () => {
      const r = inspectPackage(pkg(validFiles(manifest(override))));
      expect(r.ok).toBe(false);
      expect(errorCodes(r)).toContain(code);
    });
  }

  test("allows localhost in CSP and wasm-unsafe-eval", () => {
    const r = inspectPackage(
      pkg(
        validFiles(
          manifest({
            content_security_policy: {
              extension_pages: "script-src 'self' 'wasm-unsafe-eval' http://localhost:3000",
            },
          }),
        ),
      ),
    );
    expect(r.ok).toBe(true);
  });

  test("leading slash references resolve to package files", () => {
    expect(inspectPackage(pkg(validFiles(manifest({ background: { service_worker: "/sw.js" } })))).ok).toBe(
      true,
    );
  });

  test("warns (not errors) on sensitive and broad permissions", () => {
    const r = inspectPackage(
      pkg(validFiles(manifest({ permissions: ["debugger", "storage"], host_permissions: ["<all_urls>"] }))),
    );
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual(expect.arrayContaining(["sensitive_permissions", "broad_host_permissions"]));
  });

  test("manifest at a nested path gets a specific hint", () => {
    const f: Record<string, string | Uint8Array> = {};
    for (const [k, v] of Object.entries(validFiles())) f[`dist/${k}`] = v;
    const r = inspectPackage(pkg(f));
    expect(errorCodes(r)).toEqual(["manifest_missing"]);
    expect(r.findings[0]!.message).toContain("dist/manifest.json");
  });

  test("invalid JSON manifest", () => {
    const f = validFiles();
    f["manifest.json"] = "{ nope";
    expect(errorCodes(inspectPackage(pkg(f)))).toEqual(["manifest_json"]);
  });
});

describe("inspectPackage: content scanning", () => {
  const blocked: [string, string, string][] = [
    ["private key", "a.js", "-----BEGIN PRIVATE KEY-----\nMIIE"],
    ["AWS key", "a.js", "const k='AKIAABCDEFGHIJKLMNOP';"],
    ["GitHub token", "a.js", `t="ghp_${"a".repeat(36)}"`],
    ["Stripe key", "a.js", `s="sk_live_${"a".repeat(24)}"`],
    ["Google client secret", "a.json", `{"s":"GOCSPX-${"a".repeat(28)}"}`],
    ["service account", "creds.json", '{"type": "service_account"}'],
    ["importScripts remote", "a.js", "importScripts('https://cdn.example.com/x.js')"],
    ["dynamic import remote", "a.js", 'await import("https://cdn.example.com/x.js")'],
    ["remote script tag", "p.html", '<script src="https://cdn.example.com/x.js"></script>'],
    ["protocol-relative script tag", "p.html", '<script src="//cdn.example.com/x.js"></script>'],
    ["script.src remote", "a.js", 's.src = "https://cdn.example.com/lib.js";'],
  ];
  for (const [label, file, content] of blocked) {
    test(`blocks ${label}`, () => {
      const r = inspectPackage(pkg({ ...validFiles(), [file]: content }));
      expect(r.ok).toBe(false);
    });
  }

  for (const file of [".env", "config/.env.local", "certs/server.pem", "id_rsa", ".git/config", ".npmrc"]) {
    test(`blocks forbidden file ${file}`, () => {
      const r = inspectPackage(pkg({ ...validFiles(), [file]: "x" }));
      expect(errorCodes(r)).toContain("forbidden_file");
    });
  }

  test("does not flag fetch() of remote JSON data", () => {
    const r = inspectPackage(
      pkg({ ...validFiles(), "data.js": "fetch('https://api.example.com/config.json').then(r => r.json())" }),
    );
    expect(r.ok).toBe(true);
  });

  test("source maps warn by default and block in strict mode", () => {
    const f = { ...validFiles(), "popup.js.map": "{}" };
    expect(inspectPackage(pkg(f)).ok).toBe(true);
    expect(codes(inspectPackage(pkg(f)))).toContain("source_map");
    expect(inspectPackage(pkg(f), { strictSourceMaps: true }).ok).toBe(false);
  });

  test("Google API keys and eval are warnings", () => {
    const r = inspectPackage(pkg({ ...validFiles(), "a.js": `k="AIza${"a".repeat(35)}"; eval("1")` }));
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual(expect.arrayContaining(["google_api_key", "dynamic_eval"]));
  });

  test("binary files are not text-scanned", () => {
    const r = inspectPackage(pkg({ ...validFiles(), "img.png": enc.encode("AKIAABCDEFGHIJKLMNOP") }));
    expect(r.ok).toBe(true);
  });
});

describe("zip safety", () => {
  test.each([
    ["../evil.js", "parent-directory traversal"],
    ["a/../../evil.js", "parent-directory traversal"],
    ["/etc/passwd", "absolute path"],
    ["C:/x.js", "drive-letter path"],
    ["a\\b.js", "backslash in path"],
    ["a//b.js", "empty or '.' path segment"],
    ["./a.js", "empty or '.' path segment"],
  ])("unsafePathReason(%p)", (name, reason) => {
    expect(unsafePathReason(name)).toBe(reason);
  });

  test("safe names pass", () => {
    for (const n of ["manifest.json", "a/b/c.js", "_locales/en/messages.json", "dir/", "..hidden.js"])
      expect(unsafePathReason(n)).toBeNull();
  });

  test("traversal entry rejects the package", () => {
    const bytes = zipSync({ "manifest.json": enc.encode("{}"), "../evil.js": enc.encode("x") });
    expect(() => extractZip(bytes)).toThrow(ZipError);
    expect(errorCodes(inspectPackage(bytes))).toEqual(["zip_unsafe_path"]);
  });

  test("symlink entry rejects the package", () => {
    const bytes = zipSync({
      "manifest.json": enc.encode("{}"),
      link: [enc.encode("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }],
    });
    const entries = listZipEntries(bytes);
    expect(entries.find((e) => e.name === "link")?.isSymlink).toBe(true);
    expect(() => extractZip(bytes)).toThrow(/symlink/);
  });

  test("case-insensitive duplicates are rejected", () => {
    const bytes = zipSync({ "a.js": enc.encode("1"), "A.js": enc.encode("2") });
    expect(() => extractZip(bytes)).toThrow(/Duplicate/);
  });

  test("high-ratio entry is rejected as a zip bomb", () => {
    const bytes = zipSync({ "big.txt": new Uint8Array(4 * 1024 * 1024) }, { level: 9 });
    const e = listZipEntries(bytes)[0]!;
    expect(e.uncompressedSize / e.compressedSize).toBeGreaterThan(200);
    expect(() => extractZip(bytes)).toThrow(/compression ratio/);
  });

  test("non-zip input is rejected", () => {
    expect(errorCodes(inspectPackage(enc.encode("not a zip at all, definitely not")))).toEqual([
      "zip_not_zip",
    ]);
  });

  test("truncated zip is rejected", () => {
    const bytes = pkg(validFiles());
    expect(inspectPackage(bytes.subarray(0, bytes.length - 30)).ok).toBe(false);
  });
});

describe("zip integrity against forged headers", () => {
  const eocdOf = (v: DataView, len: number) => {
    let i = len - 22;
    while (v.getUint32(i, true) !== 0x06054b50) i--;
    return i;
  };
  /** Patches a field of the first central-directory entry (and the matching local-header field). */
  function forge(
    z: Uint8Array,
    cdOffsetInEntry: number,
    lfhOffset: number | null,
    value: number,
    width: 2 | 4 = 4,
  ) {
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
    const cd = v.getUint32(eocdOf(v, z.length) + 16, true);
    const set = (o: number) => (width === 4 ? v.setUint32(o, value, true) : v.setUint16(o, value, true));
    set(cd + cdOffsetInEntry);
    if (lfhOffset !== null) set(lfhOffset);
    return z;
  }

  test("an entry that lies about its size is rejected quickly, not truncated", () => {
    const z = zipSync({ "big.txt": new Uint8Array(64 * 1024 * 1024) }, { level: 9 });
    forge(z, 24, 22, 100);
    const t0 = performance.now();
    expect(() => extractZip(z)).toThrow(/expands beyond its declared size/);
    // Inflation stops at the declared 100 bytes instead of decompressing all 64 MB.
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test("an entry shorter than declared is rejected", () => {
    const z = zipSync({ "a.txt": enc.encode("hello world") }, { level: 9 });
    forge(z, 24, 22, 50);
    expect(() => extractZip(z)).toThrow(/shorter than declared/);
  });

  test("tampered content fails the CRC-32 check", () => {
    const z = zipSync({ "a.txt": enc.encode("hello world") }, { level: 0 });
    const idx = new TextDecoder().decode(z).indexOf("hello");
    expect(idx).toBeGreaterThan(0);
    z[idx] = "j".charCodeAt(0);
    expect(() => extractZip(z)).toThrow(/CRC-32/);
  });

  test("encrypted entries and unknown compression methods are refused", () => {
    expect(() => extractZip(forge(zipSync({ "a.txt": enc.encode("x") }), 8, 6, 1, 2))).toThrow(/encrypted/);
    expect(() => extractZip(forge(zipSync({ "a.txt": enc.encode("x") }), 10, 8, 12, 2))).toThrow(
      /compression method 12/,
    );
  });

  test("stored (uncompressed) and empty entries extract correctly", () => {
    const z = zipSync({ "a.txt": enc.encode("stored"), "empty.txt": new Uint8Array(0) }, { level: 0 });
    const r = extractZip(z);
    expect(new TextDecoder().decode(r.files.get("a.txt"))).toBe("stored");
    expect(r.files.get("empty.txt")!.length).toBe(0);
    const zd = zipSync({ "empty.txt": new Uint8Array(0) }, { level: 9 });
    expect(extractZip(zd).files.get("empty.txt")!.length).toBe(0);
  });
});
