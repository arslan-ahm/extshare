/**
 * End-to-end tests for the CLI installers (static/install.sh, static/install.ps1).
 * A real CLI binary is compiled for this machine and served from a local HTTP server laid out like a GitHub
 * Release (binary + SHA256SUMS). Each installer must install a binary that runs, and must refuse, installing
 * nothing, when the checksum is wrong, missing, or the download fails.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@extshare/cli/src/main";

setDefaultTimeout(120_000);

const ROOT = join(import.meta.dir, "../../..");
const STATIC = join(import.meta.dir, "../static");
const isWindows = process.platform === "win32";
/** The asset name the installers pick for this machine (both map Windows to the x64 build). */
const asset = isWindows
  ? "extshare-windows-x64.exe"
  : `extshare-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const binName = isWindows ? "extshare.exe" : "extshare";

let work: string;
let server: ReturnType<typeof Bun.serve>;
let binary: Uint8Array<ArrayBuffer>;

const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "extshare-install-"));
  const out = join(work, asset);
  const build = Bun.spawnSync(
    ["bun", "build", join(ROOT, "packages/cli/src/main.ts"), "--compile", "--outfile", out],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`CLI build failed: ${build.stderr.toString()}`);
  binary = new Uint8Array(readFileSync(out));
  const good = `${sha256(binary)}  ${asset}\n`;
  // Each top-level path is one release layout.
  const releases: Record<string, Record<string, Uint8Array<ArrayBuffer> | string>> = {
    good: { [asset]: binary, SHA256SUMS: good },
    badsum: { [asset]: binary, SHA256SUMS: `${"0".repeat(64)}  ${asset}\n` },
    noentry: { [asset]: binary, SHA256SUMS: `${sha256(binary)}  extshare-plan9-mips\n` },
    missing: { SHA256SUMS: good },
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const [, release, file] = new URL(req.url).pathname.split("/");
      const body = releases[release ?? ""]?.[file ?? ""];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
});

afterAll(() => {
  server?.stop(true);
  rmSync(work, { recursive: true, force: true });
});

interface Installer {
  name: string;
  available: boolean;
  command: () => string[];
}

const installers: Installer[] = [
  {
    name: "install.sh",
    available: Bun.which("sh") !== null,
    command: () => ["sh", join(STATIC, "install.sh")],
  },
  {
    name: "install.ps1",
    available: isWindows && Bun.which("powershell") !== null,
    command: () => [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(STATIC, "install.ps1"),
    ],
  },
];

// Async on purpose: a blocking spawn would stall this process, and with it the release server above.
async function runInstaller(inst: Installer, release: string) {
  const dir = join(work, `${inst.name}-${release}`);
  mkdirSync(dir, { recursive: true });
  const p = Bun.spawn(inst.command(), {
    env: {
      ...process.env,
      EXTSHARE_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}/${release}`,
      EXTSHARE_INSTALL_DIR: dir,
      EXTSHARE_NO_MODIFY_PATH: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: out + err, installed: join(dir, binName) };
}

test("the served binary is the real CLI and reports the package version", () => {
  // Precondition for every case below: the fixture really is a runnable CLI.
  const direct = Bun.spawnSync([join(work, asset), "--version"]);
  expect(direct.exitCode).toBe(0);
  expect(direct.stdout.toString().trim()).toBe(`extshare ${VERSION}`);
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

for (const inst of installers) {
  describe.skipIf(!inst.available)(inst.name, () => {
    test("installs a verified binary that runs", async () => {
      const r = await runInstaller(inst, "good");
      expect(r.out).toContain(`Installed extshare ${VERSION}`);
      expect(r.code).toBe(0);
      expect(existsSync(r.installed)).toBe(true);
      expect(sha256(new Uint8Array(readFileSync(r.installed)))).toBe(sha256(binary));
      const v = Bun.spawnSync([r.installed, "--version"]);
      expect(v.stdout.toString().trim()).toBe(`extshare ${VERSION}`);
    });

    test("re-running over an existing install replaces it", async () => {
      const first = await runInstaller(inst, "good");
      writeFileSync(first.installed, "stale");
      const again = await runInstaller(inst, "good");
      expect(again.code).toBe(0);
      expect(sha256(new Uint8Array(readFileSync(again.installed)))).toBe(sha256(binary));
    });

    test("refuses a binary whose checksum does not match, installing nothing", async () => {
      const r = await runInstaller(inst, "badsum");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("checksum mismatch");
      expect(existsSync(r.installed)).toBe(false);
    });

    test("refuses when SHA256SUMS has no entry for this platform", async () => {
      const r = await runInstaller(inst, "noentry");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("SHA256SUMS has no entry");
      expect(existsSync(r.installed)).toBe(false);
    });

    test("reports a failed download", async () => {
      const r = await runInstaller(inst, "missing");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("could not download");
      expect(existsSync(r.installed)).toBe(false);
    });
  });
}

test("at least one installer ran on this machine", () => {
  expect(installers.some((i) => i.available)).toBe(true);
});
