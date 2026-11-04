import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../src/store/memory";
import { encodePatch, ROW_MAPPERS } from "../src/store/sqlite";
import { storeContract } from "./store-contract";

describe("MemoryStore contract", () => {
  storeContract("memory", () => new MemoryStore());
});

/**
 * Checks the SQLite store's field-to-column mapping against the migration file itself,
 * without opening a database: every inserted column must exist in its table, every NOT NULL
 * column without a default must be supplied, and every column must be read back by the row mapper.
 */
describe("SqliteStore mapping vs migrations/001_init.sql", () => {
  const sql = readFileSync(join(import.meta.dir, "../src/store/migrations/001_init.sql"), "utf8");
  const tables = new Map<string, { name: string; required: boolean }[]>();
  for (const m of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
    const cols = m[2]!
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[a-z_0-9]+\s+(TEXT|INTEGER)/.test(l))
      .map((l) => ({
        name: l.split(/\s+/)[0]!,
        required: /NOT NULL/.test(l) && !/DEFAULT/.test(l) && !/PRIMARY KEY/.test(l),
      }));
    tables.set(m[1]!, cols);
  }

  test("migration defines all tables", () => {
    expect([...tables.keys()].sort()).toEqual(
      [
        "api_tokens",
        "audit_log",
        "device_grants",
        "invites",
        "memberships",
        "projects",
        "release_testers",
        "releases",
        "sessions",
        "tester_sessions",
        "users",
        "workspaces",
      ].sort(),
    );
  });

  // One complete fixture per entity, with every field set (nullable ones non-null so they produce a column).
  const fixtures: Record<string, object> = {
    users: {
      id: "u",
      email: "e",
      name: "n",
      passwordHash: "h",
      totpSecret: "s",
      totpEnabled: true,
      totpLastStep: 1,
      disabled: false,
      createdAt: 1,
    },
    workspaces: { id: "w", name: "n", createdAt: 1 },
    memberships: { workspaceId: "w", userId: "u", role: "owner" },
    sessions: {
      idHash: "h",
      userId: "u",
      workspaceId: "w",
      mfaPassed: true,
      csrf: "c",
      createdAt: 1,
      expiresAt: 2,
    },
    api_tokens: {
      hash: "h",
      kind: "access",
      userId: "u",
      workspaceId: "w",
      family: "f",
      createdAt: 1,
      expiresAt: 2,
      revokedAt: 3,
      usedAt: 4,
    },
    device_grants: {
      id: "g",
      deviceCodeHash: "d",
      userCode: "c",
      status: "pending",
      userId: "u",
      workspaceId: "w",
      clientName: "n",
      createdAt: 1,
      expiresAt: 2,
      lastPollAt: 0,
    },
    projects: {
      id: "p",
      workspaceId: "w",
      name: "n",
      itemId: "i",
      visibility: "private",
      createdBy: "e",
      createdAt: 1,
    },
    releases: {
      id: "r",
      projectId: "p",
      workspaceId: "w",
      kind: "build",
      version: "1",
      state: "live",
      stateDetail: "",
      sha256: "s",
      sizeBytes: 1,
      notes: "",
      findings: [],
      publishType: "DEFAULT_PUBLISH",
      uploadedToStore: true,
      createdBy: "e",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
      revokedAt: 3,
      revokeReason: "",
      lastSyncAt: 4,
    },
    release_testers: { releaseId: "r", email: "e", addedBy: "a", addedAt: 1 },
    invites: {
      id: "i",
      releaseId: "r",
      tokenHash: "h",
      createdBy: "e",
      createdAt: 1,
      expiresAt: 2,
      revokedAt: 3,
    },
    tester_sessions: { idHash: "h", email: "e", createdAt: 1, expiresAt: 2 },
    audit_log: {
      id: "a",
      workspaceId: "w",
      at: 1,
      actor: "x",
      action: "y",
      target: "z",
      ip: "1.2.3.4",
      details: { k: 1 },
    },
  };

  for (const [table, fixture] of Object.entries(fixtures)) {
    test(`${table}: insert columns exist, required columns supplied, mapper round-trips`, () => {
      const cols = tables.get(table);
      expect(cols).toBeDefined();
      const names = new Set(cols!.map((c) => c.name));
      const [insertCols, values] = encodePatch(fixture);
      for (const c of insertCols) expect(names.has(c)).toBe(true);
      for (const c of cols!) {
        if (c.required || c.name === "id" || c.name === "hash") expect(insertCols).toContain(c.name);
      }
      // Every table column is populated by the fixture, so the encoded row equals a full SELECT * row.
      expect(new Set(insertCols)).toEqual(names);
      const row = Object.fromEntries(insertCols.map((c, i) => [c, values[i]]));
      expect(ROW_MAPPERS[table as keyof typeof ROW_MAPPERS](row) as unknown).toEqual(fixture);
    });
  }
});
