import { describe, expect, test } from "bun:test";
import {
  type AccessInput,
  buildWithdrawnPackage,
  compareVersions,
  decideAccess,
  formatDuration,
  inspectPackage,
  mapCwsStatus,
  nextStateAfterSync,
  nextVersion,
  parseTtl,
  parseVersion,
  webStoreUrl,
} from "../src";

describe("versions", () => {
  test("parse", () => {
    expect(parseVersion("1")).toEqual([1]);
    expect(parseVersion("1.0.10.65535")).toEqual([1, 0, 10, 65535]);
    for (const bad of ["", "1.", ".1", "1.65536", "01", "1.2.3.4.5", "1.a", "0", "0.0.0", " 1"])
      expect(parseVersion(bad)).toBeNull();
  });
  test("compare treats missing parts as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.10", "1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3.1")).toBeLessThan(0);
  });
  test("nextVersion is the smallest greater version", () => {
    for (const v of ["1", "1.2.3", "1.65535.65535.65535", "2.0.0.65535"]) {
      const n = nextVersion(v);
      expect(compareVersions(n, v)).toBeGreaterThan(0);
      expect(parseVersion(n)).not.toBeNull();
    }
    expect(nextVersion("1.2.3")).toBe("1.2.3.1");
    expect(nextVersion("1.65535.65535.65535")).toBe("2.0.0.0");
    expect(() => nextVersion("65535.65535.65535.65535")).toThrow();
  });
});

describe("ttl", () => {
  test("parses units and combinations", () => {
    expect(parseTtl("30m")).toBe(30 * 60_000);
    expect(parseTtl("7d")).toBe(7 * 86_400_000);
    expect(parseTtl("1d12h")).toBe(36 * 3_600_000);
    expect(parseTtl(" 2H ")).toBe(2 * 3_600_000);
  });
  test("rejects out of range and garbage", () => {
    for (const bad of ["10m", "91d", "7", "7w", "-1d", "1.5d", ""]) expect(() => parseTtl(bad)).toThrow();
  });
  test("formatDuration", () => {
    expect(formatDuration(36 * 3_600_000 + 5 * 60_000)).toBe("1d 12h 5m");
    expect(formatDuration(0)).toBe("0m");
  });
});

describe("mapCwsStatus", () => {
  const ch = (v: string) => [{ crxVersion: v, deployPercentage: 100 }];
  test("submitted revision for this version maps its state", () => {
    expect(
      mapCwsStatus(
        { submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: ch("1.2.0") } },
        "1.2.0",
        true,
      )?.state,
    ).toBe("in_review");
    expect(
      mapCwsStatus(
        { submittedItemRevisionStatus: { state: "REJECTED", distributionChannels: ch("1.2.0") } },
        "1.2.0",
        false,
      )?.state,
    ).toBe("rejected");
    expect(
      mapCwsStatus(
        { submittedItemRevisionStatus: { state: "STAGED", distributionChannels: ch("1.2.0") } },
        "1.2.0",
        true,
      )?.state,
    ).toBe("staged");
    expect(
      mapCwsStatus(
        { submittedItemRevisionStatus: { state: "CANCELLED", distributionChannels: ch("1.2.0") } },
        "1.2.0",
        true,
      )?.state,
    ).toBe("cancelled");
  });
  test("submitted revision of another version is not attributed", () => {
    expect(
      mapCwsStatus(
        { submittedItemRevisionStatus: { state: "REJECTED", distributionChannels: ch("1.3.0") } },
        "1.2.0",
        false,
      ),
    ).toBeNull();
  });
  test("submitted revision without versions is attributed only to the latest submission", () => {
    const s = { submittedItemRevisionStatus: { state: "PENDING_REVIEW" as const } };
    expect(mapCwsStatus(s, "1.2.0", true)?.state).toBe("in_review");
    expect(mapCwsStatus(s, "1.2.0", false)).toBeNull();
  });
  test("published revision: live for our version, superseded by a newer one", () => {
    expect(
      mapCwsStatus(
        { publishedItemRevisionStatus: { state: "PUBLISHED_TO_TESTERS", distributionChannels: ch("1.2.0") } },
        "1.2.0",
        true,
      )?.state,
    ).toBe("live");
    expect(
      mapCwsStatus(
        { publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: ch("1.3.0") } },
        "1.2.0",
        false,
      )?.state,
    ).toBe("superseded");
    expect(
      mapCwsStatus(
        { publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: ch("1.1.0") } },
        "1.2.0",
        true,
      ),
    ).toBeNull();
  });
  test("takedown and upload states", () => {
    expect(mapCwsStatus({ takenDown: true }, "1.0", true)?.state).toBe("failed");
    expect(mapCwsStatus({ lastAsyncUploadState: "UPLOAD_IN_PROGRESS" }, "1.0", true)?.state).toBe(
      "processing",
    );
    expect(mapCwsStatus({ lastAsyncUploadState: "IN_PROGRESS" }, "1.0", true)?.state).toBe("processing");
    expect(mapCwsStatus({ lastAsyncUploadState: "FAILED" }, "1.0", true)?.state).toBe("failed");
    expect(mapCwsStatus({ lastAsyncUploadState: "FAILED" }, "1.0", false)).toBeNull();
    expect(mapCwsStatus({}, "1.0", true)).toBeNull();
  });
  test("sync never overrides locally-set terminal states", () => {
    const live = { state: "live" as const, detail: "" };
    expect(nextStateAfterSync("revoked", live)).toBe("revoked");
    expect(nextStateAfterSync("expired", live)).toBe("expired");
    expect(nextStateAfterSync("superseded", live)).toBe("superseded");
    expect(nextStateAfterSync("in_review", live)).toBe("live");
    expect(nextStateAfterSync("in_review", null)).toBe("in_review");
  });
});

describe("decideAccess", () => {
  const now = 1_000_000;
  const base: AccessInput = {
    now,
    release: { state: "live", expiresAt: now + 1000, revokedAt: null },
    invite: { expiresAt: now + 1000, revokedAt: null },
    visibility: "private",
    testers: new Set(["alice@example.com"]),
    email: "Alice@Example.com ",
  };
  test("allows a listed tester (case/space-insensitive)", () => {
    expect(decideAccess(base)).toEqual({ kind: "allow" });
  });
  test("private: unlisted email is forbidden", () => {
    expect(decideAccess({ ...base, email: "mallory@example.com" })).toEqual({ kind: "forbidden" });
  });
  test("private with an empty list forbids everyone", () => {
    expect(decideAccess({ ...base, testers: new Set() })).toEqual({ kind: "forbidden" });
  });
  test("unlisted with no list allows any signed-in user, with a list enforces it", () => {
    expect(decideAccess({ ...base, visibility: "unlisted", testers: new Set(), email: "x@y.com" })).toEqual({
      kind: "allow",
    });
    expect(decideAccess({ ...base, visibility: "unlisted", email: "x@y.com" })).toEqual({
      kind: "forbidden",
    });
  });
  test("asks for sign-in only after link validity", () => {
    expect(decideAccess({ ...base, email: null })).toEqual({ kind: "signin" });
    expect(decideAccess({ ...base, email: null, invite: { expiresAt: now, revokedAt: null } })).toEqual({
      kind: "deny",
      reason: "link_expired",
    });
  });
  test("deny reasons in priority order", () => {
    expect(decideAccess({ ...base, release: null })).toMatchObject({ reason: "invalid_link" });
    expect(decideAccess({ ...base, invite: null })).toMatchObject({ reason: "invalid_link" });
    expect(
      decideAccess({ ...base, release: { state: "live", expiresAt: now - 1, revokedAt: now } }),
    ).toMatchObject({ reason: "release_revoked" });
    expect(
      decideAccess({ ...base, release: { state: "live", expiresAt: now, revokedAt: null } }),
    ).toMatchObject({ reason: "release_expired" });
    expect(
      decideAccess({ ...base, release: { state: "expired", expiresAt: now + 5, revokedAt: null } }),
    ).toMatchObject({ reason: "release_expired" });
    expect(decideAccess({ ...base, invite: { expiresAt: now + 5, revokedAt: now } })).toMatchObject({
      reason: "link_revoked",
    });
  });
  test("pending and unavailable states are shown only to authorised testers", () => {
    expect(
      decideAccess({ ...base, release: { state: "in_review", expiresAt: now + 5, revokedAt: null } }),
    ).toEqual({ kind: "pending", state: "in_review" });
    expect(
      decideAccess({
        ...base,
        email: "m@x.com",
        release: { state: "in_review", expiresAt: now + 5, revokedAt: null },
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      decideAccess({ ...base, release: { state: "rejected", expiresAt: now + 5, revokedAt: null } }),
    ).toEqual({ kind: "unavailable", state: "rejected" });
    expect(
      decideAccess({ ...base, release: { state: "superseded", expiresAt: now + 5, revokedAt: null } }),
    ).toEqual({ kind: "unavailable", state: "superseded" });
  });
});

describe("webStoreUrl", () => {
  test("builds the detail URL for valid IDs only", () => {
    expect(webStoreUrl("a".repeat(32))).toBe(`https://chromewebstore.google.com/detail/${"a".repeat(32)}`);
    expect(() => webStoreUrl("z".repeat(32))).toThrow();
    expect(() => webStoreUrl("abc")).toThrow();
  });
});

describe("withdrawn package", () => {
  test("is a valid, permission-free package one version up", () => {
    const { zip, version } = buildWithdrawnPackage({ name: "My Ext", currentVersion: "1.4.2" });
    expect(version).toBe("1.4.2.1");
    const r = inspectPackage(zip);
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.manifest).toMatchObject({
      name: "My Ext",
      version: "1.4.2.1",
      permissions: [],
      hostPermissions: [],
    });
  });
  test("icon is a real PNG with correct dimensions", async () => {
    const { solidPng } = await import("../src/withdrawn");
    const png = solidPng(128, [1, 2, 3]);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const v = new DataView(png.buffer, png.byteOffset);
    expect(v.getUint32(16)).toBe(128);
    expect(v.getUint32(20)).toBe(128);
  });
});
