import { expect, test } from "bun:test";
import type {
  ApiToken,
  AuditEntry,
  Invite,
  Project,
  Release,
  Session,
  Store,
  User,
} from "../src/store/types";

/**
 * Behaviour every Store implementation must have. Run against MemoryStore in the unit suite;
 * the owner runs it against SqliteStore with `bun run verify:sqlite` (scripts/verify-sqlite.ts).
 */
export function storeContract(name: string, make: () => Store) {
  const user = (id: string, email: string): User => ({
    id,
    email,
    name: id,
    passwordHash: "h",
    totpSecret: null,
    totpEnabled: false,
    totpLastStep: 0,
    disabled: false,
    createdAt: 1,
  });
  const seedWs = (s: Store) => {
    s.createWorkspace({ id: "ws1", name: "W", createdAt: 1 });
    s.createUser(user("u1", "a@x.com"));
    s.addMember({ workspaceId: "ws1", userId: "u1", role: "owner" });
  };
  const project = (id: string, itemId: string): Project => ({
    id,
    workspaceId: "ws1",
    name: id,
    itemId,
    visibility: "private",
    createdBy: "a@x.com",
    createdAt: 10,
  });
  const release = (
    id: string,
    projectId: string,
    createdAt: number,
    over: Partial<Release> = {},
  ): Release => ({
    id,
    projectId,
    workspaceId: "ws1",
    kind: "build",
    version: "1.0",
    state: "in_review",
    stateDetail: "",
    sha256: "0".repeat(64),
    sizeBytes: 10,
    notes: "",
    findings: [{ severity: "warning", code: "c", message: "m", file: "f.js" }],
    publishType: "DEFAULT_PUBLISH",
    uploadedToStore: true,
    createdBy: "a@x.com",
    createdAt,
    updatedAt: createdAt,
    expiresAt: createdAt + 1000,
    revokedAt: null,
    revokeReason: "",
    lastSyncAt: null,
    ...over,
  });
  const token = (hash: string, over: Partial<ApiToken> = {}): ApiToken => ({
    hash,
    kind: "refresh",
    userId: "u1",
    workspaceId: "ws1",
    family: "fam1",
    createdAt: 1,
    expiresAt: 100,
    revokedAt: null,
    usedAt: null,
    ...over,
  });

  test(`${name}: user email is unique and lookups round-trip every field`, () => {
    const s = make();
    seedWs(s);
    expect(() => s.createUser(user("u2", "a@x.com"))).toThrow();
    s.updateUser("u1", { totpSecret: "SECRET", totpEnabled: true, totpLastStep: 42, disabled: true });
    expect(s.getUserByEmail("a@x.com")).toEqual({
      ...user("u1", "a@x.com"),
      totpSecret: "SECRET",
      totpEnabled: true,
      totpLastStep: 42,
      disabled: true,
    });
    expect(s.getUser("missing")).toBeNull();
    expect(s.listMemberships("u1")).toEqual([{ workspaceId: "ws1", userId: "u1", role: "owner" }]);
    expect(s.getMembership("ws1", "u2")).toBeNull();
    expect(() => s.addMember({ workspaceId: "ws1", userId: "u1", role: "viewer" })).toThrow();
  });

  test(`${name}: reads are copies`, () => {
    const s = make();
    seedWs(s);
    const u = s.getUser("u1")!;
    u.name = "mutated";
    expect(s.getUser("u1")!.name).toBe("u1");
    s.createProject(project("p1", "a".repeat(32)));
    s.createRelease(release("r1", "p1", 100));
    const r = s.getRelease("r1")!;
    r.findings.push({ severity: "error", code: "x", message: "x" });
    expect(s.getRelease("r1")!.findings).toHaveLength(1);
  });

  test(`${name}: sessions update, delete, and per-user delete`, () => {
    const s = make();
    seedWs(s);
    const sess: Session = {
      idHash: "s1",
      userId: "u1",
      workspaceId: "ws1",
      mfaPassed: false,
      csrf: "c",
      createdAt: 1,
      expiresAt: 50,
    };
    s.createSession(sess);
    s.createSession({ ...sess, idHash: "s2" });
    s.updateSession("s1", { mfaPassed: true });
    expect(s.getSession("s1")).toEqual({ ...sess, mfaPassed: true });
    s.deleteSession("s1");
    expect(s.getSession("s1")).toBeNull();
    s.deleteSessionsForUser("u1");
    expect(s.getSession("s2")).toBeNull();
  });

  test(`${name}: refresh tokens can be claimed exactly once; revocation by family and user`, () => {
    const s = make();
    seedWs(s);
    s.createToken(token("t1"));
    s.createToken(token("t2", { kind: "access" }));
    s.createToken(token("t3", { family: "fam2" }));
    expect(s.claimRefreshToken("t1", 5)).toBe(true);
    expect(s.claimRefreshToken("t1", 6)).toBe(false);
    expect(s.getToken("t1")!.usedAt).toBe(5);
    expect(s.claimRefreshToken("t2", 5)).toBe(false); // access tokens are never claimable
    s.revokeTokenFamily("fam1", 7);
    expect(s.getToken("t2")!.revokedAt).toBe(7);
    expect(s.getToken("t3")!.revokedAt).toBeNull();
    expect(s.claimRefreshToken("t3", 8)).toBe(true);
    s.createToken(token("t4", { family: "fam3" }));
    s.revokeToken("t4", 9);
    expect(s.claimRefreshToken("t4", 9)).toBe(false);
    s.revokeTokensForUser("u1", 10);
    expect(s.getToken("t3")!.revokedAt).toBe(10);
    expect(s.getToken("t2")!.revokedAt).toBe(7); // already-revoked keeps original timestamp
  });

  test(`${name}: device grants unique on both codes`, () => {
    const s = make();
    seedWs(s);
    const g = {
      id: "g1",
      deviceCodeHash: "dh",
      userCode: "ABCD-EFGH",
      status: "pending" as const,
      userId: null,
      workspaceId: null,
      clientName: "cli",
      createdAt: 1,
      expiresAt: 100,
      lastPollAt: 0,
    };
    s.createDeviceGrant(g);
    expect(() => s.createDeviceGrant({ ...g, id: "g2", deviceCodeHash: "other" })).toThrow();
    expect(() => s.createDeviceGrant({ ...g, id: "g3", userCode: "WXYZ-WXYZ" })).toThrow();
    s.updateDeviceGrant("g1", { status: "approved", userId: "u1", workspaceId: "ws1" });
    expect(s.getDeviceGrantByUserCode("ABCD-EFGH")).toEqual({
      ...g,
      status: "approved",
      userId: "u1",
      workspaceId: "ws1",
    });
    expect(s.getDeviceGrantByCodeHash("dh")!.id).toBe("g1");
  });

  test(`${name}: projects unique by item, listed newest first per workspace`, () => {
    const s = make();
    seedWs(s);
    s.createWorkspace({ id: "ws2", name: "Other", createdAt: 1 });
    s.createProject(project("p1", "a".repeat(32)));
    s.createProject({ ...project("p2", "b".repeat(32)), createdAt: 20 });
    s.createProject({ ...project("p3", "c".repeat(32)), workspaceId: "ws2" });
    expect(() => s.createProject(project("p4", "a".repeat(32)))).toThrow();
    expect(s.listProjects("ws1").map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(s.getProjectByItemId("c".repeat(32))!.workspaceId).toBe("ws2");
  });

  test(`${name}: releases round-trip, update, list by project and by state`, () => {
    const s = make();
    seedWs(s);
    s.createProject(project("p1", "a".repeat(32)));
    s.createRelease(release("r1", "p1", 100));
    s.createRelease(
      release("r2", "p1", 200, { state: "live", uploadedToStore: false, revokedAt: 5, lastSyncAt: 6 }),
    );
    s.createRelease(release("r3", "p1", 150, { state: "expired" }));
    expect(s.getRelease("r2")).toEqual(
      release("r2", "p1", 200, { state: "live", uploadedToStore: false, revokedAt: 5, lastSyncAt: 6 }),
    );
    expect(s.listReleases("p1").map((r) => r.id)).toEqual(["r2", "r3", "r1"]);
    expect(s.listReleasesInStates(["in_review", "live"]).map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(s.listReleasesInStates([])).toEqual([]);
    s.updateRelease("r1", { state: "revoked", revokedAt: 300, findings: [], uploadedToStore: false });
    expect(s.getRelease("r1")).toMatchObject({
      state: "revoked",
      revokedAt: 300,
      findings: [],
      uploadedToStore: false,
    });
  });

  test(`${name}: testers are a set per release, sorted`, () => {
    const s = make();
    seedWs(s);
    s.createProject(project("p1", "a".repeat(32)));
    s.createRelease(release("r1", "p1", 100));
    s.addTesters([
      { releaseId: "r1", email: "z@x.com", addedBy: "a", addedAt: 1 },
      { releaseId: "r1", email: "b@x.com", addedBy: "a", addedAt: 1 },
      { releaseId: "r1", email: "b@x.com", addedBy: "dup", addedAt: 2 },
    ]);
    expect(s.listTesters("r1").map((t) => t.email)).toEqual(["b@x.com", "z@x.com"]);
    expect(s.listTesters("r1")[0]!.addedBy).toBe("a");
    s.removeTesters("r1", ["z@x.com", "nobody@x.com"]);
    expect(s.listTesters("r1").map((t) => t.email)).toEqual(["b@x.com"]);
  });

  test(`${name}: invites revoke and extend only matching rows`, () => {
    const s = make();
    seedWs(s);
    s.createProject(project("p1", "a".repeat(32)));
    s.createRelease(release("r1", "p1", 100));
    const inv = (id: string, tokenHash: string, expiresAt: number): Invite => ({
      id,
      releaseId: "r1",
      tokenHash,
      createdBy: "a",
      createdAt: 100,
      expiresAt,
      revokedAt: null,
    });
    s.createInvite(inv("i1", "h1", 1000));
    s.createInvite(inv("i2", "h2", 500));
    expect(() => s.createInvite(inv("i3", "h1", 1))).toThrow();
    s.extendInvites("r1", 1000, 2000);
    expect(s.getInviteByTokenHash("h1")!.expiresAt).toBe(2000);
    expect(s.getInviteByTokenHash("h2")!.expiresAt).toBe(500);
    s.revokeInvites("r1", 700);
    expect(s.listInvites("r1").every((i) => i.revokedAt === 700)).toBe(true);
    s.extendInvites("r1", 2000, 3000);
    expect(s.getInviteByTokenHash("h1")!.expiresAt).toBe(2000); // revoked invites are not extended
  });

  test(`${name}: audit is filtered by workspace and target, newest first, limited`, () => {
    const s = make();
    const e = (id: string, at: number, target: string, ws = "ws1"): AuditEntry => ({
      id,
      workspaceId: ws,
      at,
      actor: "a",
      action: "x",
      target,
      ip: null,
      details: { n: at },
    });
    s.appendAudit(e("a1", 1, "t1"));
    s.appendAudit(e("a2", 3, "t2"));
    s.appendAudit(e("a3", 2, "t1"));
    s.appendAudit(e("a4", 9, "t1", "ws2"));
    expect(s.listAudit({ workspaceId: "ws1", limit: 10 }).map((x) => x.id)).toEqual(["a2", "a3", "a1"]);
    expect(s.listAudit({ workspaceId: "ws1", target: "t1", limit: 1 })).toEqual([e("a3", 2, "t1")]);
  });

  test(`${name}: purgeExpired removes only expired ephemeral rows`, () => {
    const s = make();
    seedWs(s);
    s.createSession({
      idHash: "s1",
      userId: "u1",
      workspaceId: "ws1",
      mfaPassed: true,
      csrf: "c",
      createdAt: 1,
      expiresAt: 10,
    });
    s.createSession({
      idHash: "s2",
      userId: "u1",
      workspaceId: "ws1",
      mfaPassed: true,
      csrf: "c",
      createdAt: 1,
      expiresAt: 30,
    });
    s.createToken(token("t1", { expiresAt: 10 }));
    s.createTesterSession({ idHash: "ts", email: "t@x.com", createdAt: 1, expiresAt: 10 });
    expect(s.purgeExpired(20)).toBe(3);
    expect(s.getSession("s2")).not.toBeNull();
    expect(s.getTesterSession("ts")).toBeNull();
  });

  test(`${name}: transaction rolls back on throw`, () => {
    const s = make();
    seedWs(s);
    expect(() =>
      s.transaction(() => {
        s.createProject(project("p1", "a".repeat(32)));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.getProject("p1")).toBeNull();
    s.transaction(() => s.createProject(project("p1", "a".repeat(32))));
    expect(s.getProject("p1")).not.toBeNull();
  });
}
