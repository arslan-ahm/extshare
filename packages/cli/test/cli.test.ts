import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@extshare/core";
import { base32Decode, TOTP_STEP_MS, totpAt } from "../../server/src/security";
import { csrfFrom, type FakeCws, form, ITEM_ID, Jar, makeDeps } from "../../server/test/helpers";
import type { CliContext } from "../src/context";
import { run } from "../src/main";
import { packPath } from "../src/pack";

setDefaultTimeout(60_000);

const PASSWORD = "correct horse battery staple";
const tmp: string[] = [];
const mk = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

/** Writes a small fixture extension build directory (test-local files only). */
function writeBuild(dir: string, version: string, extra: Record<string, string> = {}) {
  mkdirSync(join(dir, "icons"), { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: "CLI Fixture",
    version,
    description: "fixture",
    icons: { "128": "icons/128.png" },
    background: { service_worker: "sw.js" },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "icons", "128.png"), new Uint8Array([137, 80, 78, 71]));
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('install', () => {});");
  for (const [k, v] of Object.entries(extra)) {
    mkdirSync(join(dir, k, ".."), { recursive: true });
    writeFileSync(join(dir, k), v);
  }
}

let server: ReturnType<typeof Bun.serve>;
let env: ReturnType<typeof makeDeps>;
let base: string;
let ownerJar: Jar;

beforeAll(async () => {
  let handler: (r: Request) => Response | Promise<Response> = () => new Response("starting", { status: 503 });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => handler(r) });
  base = `http://127.0.0.1:${server.port}`;
  env = makeDeps({
    config: { publicUrl: base, uploadPollAttempts: 1, uploadPollIntervalMs: 10, trustProxy: false },
  });
  handler = (r) => env.app.fetch(r);

  await env.auth.createUser({
    email: "dev@example.com",
    name: "Dev",
    password: PASSWORD,
    role: "owner",
    workspaceName: "Team",
  });
  ownerJar = new Jar();
  const headers = { origin: base };
  const login = ownerJar.take(
    await fetch(`${base}/login`, {
      method: "POST",
      headers,
      body: form({ email: "dev@example.com", password: PASSWORD }),
      redirect: "manual",
    }),
  );
  const mfaPath = login.headers.get("location")!;
  const html = await (await fetch(`${base}${mfaPath}`, { headers: ownerJar.header() })).text();
  const secret = env.store.getUserByEmail("dev@example.com")!.totpSecret!;
  const code = totpAt(base32Decode(secret), Math.floor(env.clock.now() / TOTP_STEP_MS));
  const done = await fetch(`${base}${mfaPath}`, {
    method: "POST",
    headers: { ...headers, ...ownerJar.header() },
    body: form({ _csrf: csrfFrom(html), code }),
    redirect: "manual",
  });
  expect(done.status).toBe(303);
});

afterAll(() => server?.stop(true));

/** Approves a device code in the dashboard exactly as a user would after `extshare login` opens the browser. */
async function approveInBrowser(url: string) {
  const html = await (await fetch(url, { headers: ownerJar.header() })).text();
  const code = html.match(/name="code" value="([A-Z0-9-]+)"/)![1]!;
  const r = await fetch(`${base}/device`, {
    method: "POST",
    headers: { origin: base, ...ownerJar.header() },
    body: form({ _csrf: csrfFrom(html), code, decision: "approve" }),
    redirect: "manual",
  });
  expect(r.status).toBe(303);
}

function cli(cwd: string, configDir: string) {
  const out: string[] = [];
  const err: string[] = [];
  const approvals: Promise<void>[] = [];
  const ctx: CliContext = {
    cwd,
    configDir,
    fetch: (u, i) => fetch(u, { ...i, redirect: "manual" }),
    // Advance the server's clock instead of really waiting, then yield so the approval can land.
    sleep: async (ms) => {
      env.clock.advance(ms);
      await Bun.sleep(5);
    },
    now: env.clock.now,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    openBrowser: (url) => approvals.push(approveInBrowser(url)),
    json: false,
  };
  return {
    out,
    err,
    async run(...argv: string[]) {
      out.length = 0;
      err.length = 0;
      const code = await run(argv, ctx);
      await Promise.all(approvals);
      return code;
    },
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}

describe("CLI end to end against a live HTTP server", () => {
  test("login, project, publish, share, manage, revoke, logout", async () => {
    const cwd = mk("extshare-cwd-");
    const config = mk("extshare-cfg-");
    const c = cli(cwd, config);

    expect(await c.run("whoami")).toBe(3);
    expect(c.errText()).toContain("Not logged in");

    expect(await c.run("login", "--server", base)).toBe(0);
    expect(c.text()).toContain("Logged in as dev@example.com");
    const creds = JSON.parse(readFileSync(join(config, "credentials.json"), "utf8"));
    expect(creds).toMatchObject({ server: base, email: "dev@example.com" });
    expect(creds.accessToken).toMatch(/^xsa_/);
    if (process.platform !== "win32")
      expect(statSync(join(config, "credentials.json")).mode & 0o777).toBe(0o600);

    expect(
      await c.run(
        "projects",
        "create",
        "--name",
        "CLI Fixture",
        "--item-id",
        ITEM_ID,
        "--visibility",
        "private",
      ),
    ).toBe(0);
    const projectId = c.text().match(/Created project (prj_\S+)/)![1]!;
    expect(await c.run("init", "--project", projectId)).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, "extshare.json"), "utf8"))).toEqual({ server: base, projectId });

    const dist = join(cwd, "dist");
    writeBuild(dist, "1.0.0", { "node_modules/junk.js": "x", ".git/HEAD": "ref" });
    expect(await c.run("validate", "dist")).toBe(0);
    expect(c.text()).toContain("Package is valid.");
    expect(c.text()).toContain("Skipped: .git, node_modules");

    expect(
      await c.run("publish", "dist", "--ttl", "3d", "--testers", "qa@example.com", "--notes", "first"),
    ).toBe(0);
    const link = c.text().match(/(http:\/\/127\.0\.0\.1:\d+\/r\/[A-Za-z0-9_-]+)/)![1]!;
    const releaseId = c.text().match(/Release\s+(rel_\S+)/)![1]!;
    expect(c.text()).toContain("in_review");
    const fake = env.cws as FakeCws;
    expect(fake.lastUploadedVersion).toBe("1.0.0");
    // The packaged ZIP excluded node_modules and .git.
    const stored = env.store.getRelease(releaseId)!;
    const zip = (await env.artifacts.get(stored.sha256))!;
    const { extractZip } = await import("@extshare/core");
    expect([...extractZip(zip).files.keys()].sort()).toEqual(["icons/128.png", "manifest.json", "sw.js"]);

    const gw = await fetch(link);
    expect(gw.status).toBe(200);
    expect(await gw.text()).toContain("Sign in with Google");

    fake.status = {
      publishedItemRevisionStatus: {
        state: "PUBLISHED_TO_TESTERS",
        distributionChannels: [{ crxVersion: "1.0.0" }],
      },
    };
    expect(await c.run("status", releaseId, "--sync")).toBe(0);
    expect(c.text()).toContain("Status    live");

    expect(await c.run("testers", releaseId, "--add", "b@example.com", "--remove", "qa@example.com")).toBe(0);
    expect(c.text()).toBe("b@example.com");
    expect(await c.run("testers", releaseId, "--add", "not-an-email")).toBe(1);

    expect(await c.run("invite", releaseId)).toBe(0);
    const link2 = c.text().match(/(http:\/\/\S+\/r\/\S+)/)![1]!;
    expect(link2).not.toBe(link);
    expect((await fetch(link)).status).toBe(410);
    expect((await fetch(link2)).status).toBe(200);

    expect(await c.run("extend", releaseId, "--ttl", "10d")).toBe(0);
    expect(await c.run("releases")).toBe(0);
    expect(c.text()).toContain(releaseId);
    expect(await c.run("releases", "--json")).toBe(0);
    expect(JSON.parse(c.text())[0].id).toBe(releaseId);

    const outFile = join(cwd, "dl.zip");
    expect(await c.run("download", releaseId, "-o", outFile)).toBe(0);
    expect(sha256Hex(new Uint8Array(readFileSync(outFile)))).toBe(stored.sha256);

    expect(await c.run("revoke", releaseId, "--kill-switch")).toBe(2);
    expect(c.errText()).toContain("--yes");
    expect(await c.run("revoke", releaseId, "--reason", "test over", "--kill-switch", "--yes")).toBe(0);
    expect(c.text()).toContain("Withdrawal build 1.0.0.1 submitted");
    expect((await fetch(link2)).status).toBe(410);

    expect(await c.run("audit", releaseId)).toBe(0);
    for (const a of [
      "release.created",
      "testers.changed",
      "invite.created",
      "release.extended",
      "release.revoked",
      "release.kill_switch",
    ]) {
      expect(c.text()).toContain(a);
    }

    expect(await c.run("logout")).toBe(0);
    expect(await c.run("whoami")).toBe(3);
    // The server-side session is gone too, not just the local file.
    expect(
      (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${creds.accessToken}` } })).status,
    ).toBe(401);
  });

  test("expired access token is refreshed transparently and the rotated pair is saved", async () => {
    const config = mk("extshare-cfg-");
    const c = cli(mk("extshare-cwd-"), config);
    expect(await c.run("login", "--server", base)).toBe(0);
    const before = JSON.parse(readFileSync(join(config, "credentials.json"), "utf8"));
    env.clock.advance(2 * 3_600_000);
    expect(await c.run("whoami")).toBe(0);
    const after = JSON.parse(readFileSync(join(config, "credentials.json"), "utf8"));
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.accessToken).not.toBe(before.accessToken);
  });

  test("publish refuses an invalid build locally without uploading", async () => {
    const cwd = mk("extshare-cwd-");
    const c = cli(cwd, mk("extshare-cfg-"));
    expect(await c.run("login", "--server", base)).toBe(0);
    writeBuild(join(cwd, "bad"), "1.0", { "leak.js": "const k = 'AKIAABCDEFGHIJKLMNOP';" });
    const uploadsBefore = (env.cws as FakeCws).calls.length;
    expect(await c.run("publish", "bad", "--project", "prj_whatever", "--testers", "a@b.com")).toBe(1);
    expect(c.errText()).toContain("AWS access key");
    expect(c.errText()).toContain("nothing was uploaded");
    expect((env.cws as FakeCws).calls.length).toBe(uploadsBefore);
  });

  test("argument and connectivity errors have distinct exit codes", async () => {
    const c = cli(mk("extshare-cwd-"), mk("extshare-cfg-"));
    expect(await c.run("frobnicate")).toBe(2);
    expect(await c.run("publish", "--bogus-flag")).toBe(2);
    expect(await c.run("login", "--server", "http://example.com")).toBe(1);
    expect(c.errText()).toContain("https://");
    expect(await c.run("login", "--server", "http://127.0.0.1:1")).toBe(4);
    expect(await c.run("--help")).toBe(0);
    expect(c.text()).toContain("extshare publish".replace("extshare ", ""));
  });
});

describe("packPath", () => {
  test("requires manifest.json at the root and names the fix", () => {
    const d = mk("extshare-pack-");
    writeBuild(join(d, "dist"), "1.0");
    expect(() => packPath(d)).toThrow(/No manifest.json at the root/);
    expect(packPath(join(d, "dist")).files.sort()).toEqual(["icons/128.png", "manifest.json", "sw.js"]);
  });

  test("passes an existing zip through unchanged and refuses other files", () => {
    const d = mk("extshare-pack-");
    writeBuild(join(d, "dist"), "1.0");
    const { zip } = packPath(join(d, "dist"));
    writeFileSync(join(d, "b.zip"), zip);
    expect(sha256Hex(packPath(join(d, "b.zip")).zip)).toBe(sha256Hex(zip));
    writeFileSync(join(d, "x.txt"), "x");
    expect(() => packPath(join(d, "x.txt"))).toThrow(/directory or a .zip/);
    expect(() => packPath(join(d, "missing"))).toThrow(/No such file/);
  });

  test("is deterministic", () => {
    const d = mk("extshare-pack-");
    writeBuild(join(d, "dist"), "1.0");
    expect(sha256Hex(packPath(join(d, "dist")).zip)).toBe(sha256Hex(packPath(join(d, "dist")).zip));
  });

  test("refuses symlinks", () => {
    const d = mk("extshare-pack-");
    writeBuild(join(d, "dist"), "1.0");
    try {
      symlinkSync(join(d, "dist", "sw.js"), join(d, "dist", "link.js"));
    } catch {
      // Creating symlinks needs Developer Mode or admin rights on Windows; nothing to check then.
      return;
    }
    expect(existsSync(join(d, "dist", "link.js"))).toBe(true);
    expect(() => packPath(join(d, "dist"))).toThrow(/symlink/);
  });
});
