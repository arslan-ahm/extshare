/**
 * End-to-end tests for the installers (static/install.sh, static/install.ps1).
 * The real CLI and server bundles are built exactly as the website build publishes them and served from a
 * local HTTP server laid out like /download. Each installer must install launchers that run the tools, and
 * must refuse, installing nothing, when the checksum is wrong, missing, or the download fails.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDownloads, releaseVersion } from "../src/build";

setDefaultTimeout(120_000);

const STATIC = join(import.meta.dir, "../static");
const isWindows = process.platform === "win32";
const VERSION = releaseVersion();

let work: string;
let server: ReturnType<typeof Bun.serve>;
let published: Map<string, string | Uint8Array<ArrayBuffer>>;

const sha256 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "extshare-install-"));
  published = new Map(buildDownloads("http://127.0.0.1"));
  const cli = published.get("extshare.js")!;
  // Each top-level path is one /download layout.
  const layouts: Record<string, Record<string, string | Uint8Array<ArrayBuffer>>> = {
    good: Object.fromEntries(published),
    badsum: { ...Object.fromEntries(published), SHA256SUMS: `${"0".repeat(64)}  extshare.js\n` },
    noentry: { ...Object.fromEntries(published), SHA256SUMS: `${sha256(cli)}  something-else.js\n` },
    missing: { SHA256SUMS: published.get("SHA256SUMS")! },
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const [, layout, file] = new URL(req.url).pathname.split("/");
      const body = layouts[layout ?? ""]?.[file ?? ""];
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
  command: (component: string) => string[];
  /** The command a user runs after installing. */
  launcher: (home: string, tool: string) => string[];
}

const installers: Installer[] = [
  {
    name: "install.sh",
    available: Bun.which("sh") !== null,
    command: (c) => ["sh", join(STATIC, "install.sh"), c],
    launcher: (home, tool) => ["sh", join(home, "bin", tool)],
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
    launcher: (home, tool) => ["cmd", "/c", join(home, "bin", `${tool}.cmd`)],
  },
];

// Async on purpose: a blocking spawn would stall this process, and with it the download server above.
async function run(cmd: string[], env: Record<string, string | undefined> = process.env, cwd?: string) {
  const p = Bun.spawn(cmd, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out: out + err };
}

let n = 0;
async function install(
  inst: Installer,
  layout: string,
  component = "cli",
  extra: Record<string, string> = {},
) {
  const home = join(work, `${inst.name}-${layout}-${component}-${n++}`);
  mkdirSync(home, { recursive: true });
  const r = await run(inst.command(component), {
    ...process.env,
    EXTSHARE_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}/${layout}`,
    EXTSHARE_HOME: home,
    EXTSHARE_COMPONENT: component,
    EXTSHARE_NO_MODIFY_PATH: "1",
    EXTSHARE_NO_BUN_INSTALL: "1",
    ...extra,
  });
  return { ...r, home };
}

test("the published bundles are the real tools", async () => {
  // Precondition for every case below.
  for (const [file, name] of [
    ["extshare.js", "extshare"],
    ["extshare-server.js", "extshare-server"],
  ] as const) {
    const path = join(work, file);
    writeFileSync(path, published.get(file)!);
    const r = await run([process.execPath, path, "--version"]);
    expect(r.out.trim()).toBe(`${name} ${VERSION}`);
  }
  expect(published.get("VERSION")).toBe(`${VERSION}\n`);
  const sums = String(published.get("SHA256SUMS"));
  expect(sums).toContain(`${sha256(published.get("extshare.js")!)}  extshare.js`);
  expect(sums).toContain(`${sha256(published.get("extshare-server.js")!)}  extshare-server.js`);
});

for (const inst of installers) {
  describe.skipIf(!inst.available)(inst.name, () => {
    test("installs the CLI, and the installed command runs", async () => {
      const r = await install(inst, "good");
      expect(r.out).toContain(`Installed extshare ${VERSION}`);
      expect(r.code).toBe(0);
      const v = await run([...inst.launcher(r.home, "extshare"), "--version"], process.env, tmpdir());
      expect(v.out.trim()).toBe(`extshare ${VERSION}`);
      const help = await run([...inst.launcher(r.home, "extshare"), "--help"], process.env, tmpdir());
      expect(help.out).toContain("Usage: extshare <command>");
    });

    test("installs the server, which refuses to start unconfigured and writes nothing", async () => {
      const r = await install(inst, "good", "server");
      expect(r.out).toContain(`Installed extshare-server ${VERSION}`);
      expect(r.code).toBe(0);
      const v = await run([...inst.launcher(r.home, "extshare-server"), "--version"], process.env, tmpdir());
      expect(v.out.trim()).toBe(`extshare-server ${VERSION}`);
      // Start it in an empty folder with no server settings in the environment.
      const cwd = mkdtempSync(join(work, "srv-"));
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !/^(PUBLIC_URL|SECRET|CWS_|GOOGLE_|DATA_DIR)/.test(k)),
      );
      const start = await run(inst.launcher(r.home, "extshare-server"), env, cwd);
      expect(start.code).toBe(1);
      expect(start.out).toContain("PUBLIC_URL");
      expect(readdirSync(cwd)).toEqual([]);
      // It reads the .env in the folder it starts from (the docs rely on this): with PUBLIC_URL set there,
      // only the other settings are reported, and it still writes nothing.
      writeFileSync(join(cwd, ".env"), "PUBLIC_URL=https://extshare.example.com\nDATA_DIR=./never-created\n");
      const withEnv = await run(inst.launcher(r.home, "extshare-server"), env, cwd);
      expect(withEnv.code).toBe(1);
      expect(withEnv.out).not.toContain("- PUBLIC_URL");
      expect(withEnv.out).toContain("- SECRET");
      expect(readdirSync(cwd)).toEqual([".env"]);
    });

    test("re-running replaces an existing install", async () => {
      const first = await install(inst, "good");
      const lib = join(first.home, "lib", "extshare.js");
      writeFileSync(lib, "stale");
      const again = await run(inst.command("cli"), {
        ...process.env,
        EXTSHARE_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}/good`,
        EXTSHARE_HOME: first.home,
        EXTSHARE_COMPONENT: "cli",
        EXTSHARE_NO_MODIFY_PATH: "1",
        EXTSHARE_NO_BUN_INSTALL: "1",
      });
      expect(again.code).toBe(0);
      expect(sha256(new Uint8Array(readFileSync(lib)))).toBe(sha256(published.get("extshare.js")!));
    });

    test("refuses a file whose checksum does not match, installing nothing", async () => {
      const r = await install(inst, "badsum");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("checksum mismatch");
      expect(existsSync(join(r.home, "bin"))).toBe(false);
    });

    test("refuses when SHA256SUMS has no entry for the file", async () => {
      const r = await install(inst, "noentry");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("SHA256SUMS has no entry");
      expect(existsSync(join(r.home, "bin"))).toBe(false);
    });

    test("reports a failed download", async () => {
      const r = await install(inst, "missing");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("could not download");
      expect(existsSync(join(r.home, "bin"))).toBe(false);
    });

    test("rejects an unknown component", async () => {
      const r = await install(inst, "good", "nope");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("unknown component 'nope'");
    });

    test("without Bun, and told not to install it, explains what is needed", async () => {
      const r = await install(inst, "good", "cli", {
        EXTSHARE_BUN: join(work, isWindows ? "no-bun.exe" : "no-bun"),
      });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("bun not found");
      expect(existsSync(join(r.home, "bin"))).toBe(false);
    });
  });
}

test("at least one installer ran on this machine", () => {
  expect(installers.some((i) => i.available)).toBe(true);
});
